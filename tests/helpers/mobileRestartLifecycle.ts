import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';

export async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export class MobileRestartLifecycle {
  closing = false;
  readonly work = new Map<Promise<unknown>, string>();
  readonly children = new Map<ChildProcess, { closed: Promise<void>; cancel: () => void }>();
  private readonly detachedFailures: { label: string; error: unknown }[] = [];
  private phase = 'setup';
  private readonly started = Date.now();
  private phaseStarted = this.started;
  private readonly phases: string[] = [];

  assertOpen() {
    if (this.closing) throw new Error('Mobile test fixture is closing');
  }

  mark(phase: string) {
    this.assertOpen();
    const now = Date.now();
    this.phases.push(`${this.phase}=${now - this.phaseStarted}ms`);
    this.phase = phase;
    this.phaseStarted = now;
  }

  diagnostics() {
    return `${this.phases.join(', ')}; active=${this.phase}:${Date.now() - this.phaseStarted}ms; total=${Date.now() - this.started}ms; work=[${[...this.work.values()].join(', ')}]; children=${this.children.size}; detachedFailures=[${this.detachedFailures.map(failure => failure.label).join(', ')}]`;
  }

  run<T>(label: string, action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Mobile test fixture is closing'));
    const work = Promise.resolve().then(() => { this.assertOpen(); return action(); });
    this.work.set(work, label);
    void work.then(() => this.work.delete(work), () => this.work.delete(work));
    return work;
  }

  ownMethods(target: any, names: string[], label: string, options: { detached?: boolean } = {}) {
    for (const name of names) {
      const method = target[name];
      if (typeof method !== 'function') throw new Error(`Missing owned method ${label}.${name}`);
      target[name] = (...args: any[]) => {
        const work = this.run(`${label}.${name}`, () => method.apply(target, args));
        if (options.detached) {
          void work.catch(error => { this.detachedFailures.push({ label: `${label}.${name}`, error }); });
        }
        return work;
      };
    }
  }

  async child(script: string, args: string[], options: { timeoutMs?: number; closeMs?: number; forkOptions?: ForkOptions } = {}) {
    this.assertOpen();
    const child = fork(script, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], ...options.forkOptions });
    let message: any;
    let received = false;
    let failure: Error | undefined;
    let code: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let stderr = '';
    let resolveClosed!: () => void;
    let rejectDeadline!: (error: Error) => void;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const terminate = () => {
      child.kill('SIGKILL');
      closeTimer ??= setTimeout(() => rejectDeadline(new Error('Child did not close after SIGKILL')), options.closeMs ?? 2000);
    };
    const cancel = () => { failure ??= new Error('Child cancelled during teardown'); terminate(); };
    this.children.set(child, { closed, cancel });
    child.stdout?.resume();
    child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-4096); });
    child.on('error', error => { failure ??= error; terminate(); });
    child.once('message', value => {
      received = true;
      message = value;
      if (message?.failed) { failure = new Error(`Child failed: ${message.failed}`); terminate(); }
      else if (message?.boundary) terminate();
    });
    child.once('close', (exitCode, exitSignal) => {
      code = exitCode;
      signal = exitSignal;
      this.children.delete(child);
      resolveClosed();
    });
    const timer = setTimeout(() => { failure ??= new Error('Child boundary/exit timeout'); terminate(); }, options.timeoutMs ?? 25000);
    try {
      await Promise.race([closed, deadline]);
      if (failure) throw failure;
      if (!received) throw new Error(`Child closed before IPC: code=${code}, signal=${signal}; ${stderr}`);
      if (message?.boundary ? signal !== 'SIGKILL' : code !== 0) throw new Error(`Child failed: code=${code}, signal=${signal}; ${stderr}`);
      return { message, code, signal };
    } finally {
      clearTimeout(timer);
      clearTimeout(closeTimer);
    }
  }

  async close(options: { stop: () => void; finish: () => Promise<unknown>; remove: () => Promise<unknown>; drainMs?: number }) {
    this.closing = true;
    const errors: unknown[] = [];
    try { options.stop(); } catch (error) { errors.push(error); }
    for (const child of this.children.values()) child.cancel();
    try {
      await within(Promise.all([
        ...[...this.children.values()].map(child => child.closed),
        ...[...this.work.keys()].map(work => work.catch(() => {}))
      ]), options.drainMs ?? 5000, 'Mobile test drain');
    } catch (error) { errors.push(error); }
    try { await within(options.finish(), 5000, 'Mobile server close'); } catch (error) { errors.push(error); }
    errors.push(...this.detachedFailures.map(failure => failure.error));
    if (errors.length || this.work.size || this.children.size) {
      throw new AggregateError(errors, `Fixture preserved: lifecycle failure or quiescence not established; ${this.diagnostics()}`, { cause: errors[0] });
    }
    await options.remove();
  }
}
