import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class StackFailure extends Error {
  constructor(category, operation) {
    super(category);
    this.category = category;
    this.operation = operation;
  }
}

export function safeFailure(error, operation) {
  if (error instanceof StackFailure) return { category: error.category, operation: error.operation };
  const categories = { ENOENT: 'missing-file', EACCES: 'permission-denied', EPERM: 'permission-denied', EEXIST: 'already-exists', ENOSPC: 'disk-full', ETIMEDOUT: 'timeout' };
  return { category: categories[error?.code] ?? ({ AssertionError: 'assertion', AbortError: 'aborted', TimeoutError: 'timeout' }[error?.name]) ?? 'operation-failed', operation };
}

export function postgresEnvironment(root, path) {
  return { PATH: path, HOME: root, LANG: 'C.UTF-8', PGPASSFILE: join(root, 'empty.pgpass'), PGCONNECT_TIMEOUT: '5' };
}

export function proxyRuntimeEnabled(env, arguments_) {
  return Boolean(env.NODE_USE_ENV_PROXY && env.NODE_USE_ENV_PROXY !== '0') || [env.NODE_OPTIONS ?? '', ...arguments_].some(value => value.replaceAll('_', '-').includes('use-env-proxy'));
}

export function sandboxEnvironment(root, path) {
  return { PATH: path, HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' };
}

export class RunControl {
  controller = new AbortController();
  operation = 'preflight';
  signalName;
  handlers = new Map();
  constructor() {
    for (const name of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        this.signalName ??= name;
        this.controller.abort(new StackFailure('interrupted', this.operation));
      };
      this.handlers.set(name, handler);
      process.on(name, handler);
    }
  }
  checkpoint(operation = this.operation) {
    this.operation = operation;
    if (this.controller.signal.aborted) throw new StackFailure('interrupted', operation);
  }
  dispose() {
    for (const [name, handler] of this.handlers) process.off(name, handler);
  }
}

function processInfo(text) {
  const boundary = text.lastIndexOf(')');
  const fields = text.slice(boundary + 2).trim().split(/\s+/);
  if (boundary < 0 || fields.length < 20) throw new StackFailure('invalid-process-observation', 'process-identity');
  return { pid: Number(text.slice(0, text.indexOf(' '))), state: fields[0], group: Number(fields[2]), session: Number(fields[3]), start: fields[19] };
}

export class OwnedProcessGroup {
  known = new Map();
  constructor(child) {
    this.child = child;
    this.id = child.pid;
    if (!this.id) throw new StackFailure('spawn-failed', 'bridge-spawn');
    try {
      const info = processInfo(readFileSync(`/proc/${this.id}/stat`, 'utf8'));
      if (info.group === this.id && info.session === this.id) this.known.set(info.pid, info.start);
    } catch {}
  }
  exists() {
    try { process.kill(-this.id, 0); return true; } catch (error) { if (error?.code === 'ESRCH') return false; throw error; }
  }
  async members(includeStopped = false) {
    const found = [];
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const info = processInfo(await readFile(`/proc/${name}/stat`, 'utf8'));
        if (info.group === this.id && info.session === this.id) found.push(info);
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error?.code)) continue;
        if (['EACCES', 'EPERM'].includes(error?.code) && !this.known.has(Number(name))) continue;
        throw error;
      }
    }
    if (found.length && !found.some(info => this.known.get(info.pid) === info.start)) throw new StackFailure('process-ownership-unconfirmed', 'bridge-stop');
    for (const info of found) this.known.set(info.pid, info.start);
    return includeStopped ? found : found.filter(info => !['Z', 'X'].includes(info.state));
  }
  async observeChildren() {
    const members = await this.members();
    return members.filter(info => info.pid !== this.id).map(info => info.pid);
  }
  async stop(force = false) {
    const deadline = Date.now() + 8000;
    let signal = force ? 'SIGKILL' : 'SIGTERM';
    let sentAt = 0;
    let stoppedSignature;
    while (true) {
      const members = await this.members(true);
      const live = members.filter(info => !['Z', 'X'].includes(info.state));
      if (!this.exists()) return;
      if (members.length) {
        const signature = members.map(info => `${info.pid}:${info.start}:${info.state}`).sort().join(',');
        if (!live.length && signal === 'SIGKILL' && sentAt && stoppedSignature === signature) return;
        stoppedSignature = !live.length ? signature : undefined;
        if (!sentAt || !live.length || (signal === 'SIGTERM' && Date.now() - sentAt >= 2000)) {
          if (sentAt || !live.length) signal = 'SIGKILL';
          try { process.kill(-this.id, signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
          sentAt = Date.now();
        }
      }
      if (Date.now() >= deadline) throw new StackFailure('process-stop-unconfirmed', 'bridge-stop');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

export function parseMemory(text) {
  const rss = text.match(/^VmRSS:\s+(\d+)/m);
  const anon = text.match(/^RssAnon:\s+(\d+)/m);
  if (!rss || !anon || Number(rss[1]) <= 0) return null;
  return { rss: Number(rss[1]) * 1024, anon: Number(anon[1]) * 1024 };
}

export function summarizeMemory(samples, phase) {
  const selected = samples.filter(sample => sample.phase === phase);
  const result = {};
  for (const process of ['rust', 'node']) {
    const valid = selected.filter(sample => Number.isFinite(sample[`${process}Rss`]) && sample[`${process}Rss`] > 0 && Number.isFinite(sample[`${process}Anon`]));
    result[`${process}ValidSamples`] = valid.length;
    for (const kind of ['Rss', 'Anon']) {
      const key = `${process}${kind}`;
      result[key] = valid.length ? Math.max(...valid.map(sample => sample[key])) : null;
    }
  }
  return result;
}
