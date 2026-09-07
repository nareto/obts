import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const helper = pathToFileURL(resolve('scripts/bridge-stack-runtime.mjs')).href;
function run(source: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import * as runtime from ${JSON.stringify(helper)}; ${source}`], { encoding: 'utf8', timeout: 20_000 });
  expect(result.status, result.stderr).toBe(0);
}

describe('disposable Bridge stack runtime safety', () => {
  it('does not inherit PostgreSQL credentials, routing or user configuration', () => {
    run(`
      process.env.PGHOSTADDR = '192.0.2.1'; process.env.PGPASSWORD = 'not-a-credential'; process.env.PGSERVICE = 'unwanted';
      const env = runtime.postgresEnvironment('/tmp/private-fixture', '/usr/bin');
      assert.deepEqual(Object.keys(env).sort(), ['HOME','LANG','PATH','PGCONNECT_TIMEOUT','PGPASSFILE'].sort());
      assert.equal(env.HOME, '/tmp/private-fixture'); assert.equal(env.PGPASSFILE, '/tmp/private-fixture/empty.pgpass');
    `);
  });
  it.each(['"--use-env-proxy"', '--use_env_proxy', '--use-env-proxy'])('rejects accepted proxy option spelling %s', option => {
    run(`assert.equal(runtime.proxyRuntimeEnabled({NODE_OPTIONS:${JSON.stringify(option)}}, []),true); assert.equal(runtime.proxyRuntimeEnabled({},[${JSON.stringify(option)}]),true);`);
  });
  it('isolates Git objects and configuration inside the synthetic root', () => {
    run(`
      const {mkdtempSync,mkdirSync,readdirSync,rmSync,existsSync} = await import('node:fs');
      const {tmpdir} = await import('node:os'); const {join} = await import('node:path'); const {spawnSync} = await import('node:child_process');
      const root = mkdtempSync(join(tmpdir(),'obts-git-isolation-')); const outside = join(root,'external'); const own = join(root,'own'); mkdirSync(outside); mkdirSync(own);
      try {
        process.env.GIT_OBJECT_DIRECTORY=outside; process.env.GIT_COMMON_DIR=outside; process.env.GIT_CONFIG_GLOBAL=join(outside,'user-config');
        const env = runtime.sandboxEnvironment(own,process.env.PATH);
        assert.equal('GIT_OBJECT_DIRECTORY' in env,false); assert.equal('GIT_COMMON_DIR' in env,false);
        const repository = join(own,'repository.git');
        const init=spawnSync('git',['init','--bare',repository],{env,encoding:'utf8'}); assert.equal(init.status,0,'synthetic git init');
        const object=spawnSync('git',['--git-dir',repository,'hash-object','-w','--stdin'],{env,input:'synthetic fixture',encoding:'utf8'}); assert.equal(object.status,0,'synthetic git object');
        const hash=object.stdout.trim(); assert.equal(existsSync(join(repository,'objects',hash.slice(0,2),hash.slice(2))),true); assert.equal(readdirSync(outside).length,0);
      } finally {rmSync(root,{recursive:true,force:true});}
    `);
  });
  it('rechecks an empty process enumeration while its group still exists', () => {
    run(`
      const group=new runtime.OwnedProcessGroup({pid:1073741824}); let scans=0; let killed=false;
      group.members=async()=>{scans++;return scans===1||killed?[]:[{pid:1073741824,start:'1',state:'S'}];};
      const kill=process.kill;
      process.kill=(_pid,signal)=>{if(signal===0){if(killed){const e=new Error();e.code='ESRCH';throw e;}return true;} killed=true;return true;};
      try {await group.stop(true);assert.equal(killed,true);assert.ok(scans>=2);} finally {process.kill=kill;}
    `);
  });
  it('keeps missing memory observations distinct from measured zero anonymous memory', () => {
    run(`
      assert.equal(runtime.parseMemory('State: Z'), null);
      assert.deepEqual(runtime.parseMemory('VmRSS: 5 kB\nRssAnon: 0 kB'), {rss:5120,anon:0});
      const missing = runtime.summarizeMemory([{phase:'small',rustRss:null,rustAnon:null,nodeRss:null,nodeAnon:null}], 'small');
      assert.equal(missing.rustValidSamples, 0); assert.equal(missing.rustRss, null); assert.equal(missing.nodeRss, null);
    `.replace("5 kB\nRssAnon", '5 kB\\nRssAnon'));
  });
  it.each(['SIGINT', 'SIGTERM'])('stops continuation after draining work on %s', signal => {
    run(`
      const control = new runtime.RunControl(); let drained = false; let continued = false;
      try {
        control.checkpoint('setup');
        setTimeout(() => process.kill(process.pid, ${JSON.stringify(signal)}), 10);
        await new Promise(resolve => setTimeout(resolve, 80)); drained = true;
        control.checkpoint('next-setup-step'); continued = true;
      } catch (error) { assert.equal(error.category, 'interrupted'); }
      finally { assert.equal(drained, true); assert.equal(continued, false); control.dispose(); }
    `);
  });
  it('stops surviving descendants after the group leader exits', () => {
    run(`
      const {spawn} = await import('node:child_process');
      const {once} = await import('node:events');
      const source = "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.on('SIGUSR2',()=>process.exit(0)); setInterval(()=>{},1000);";
      const child = spawn(process.execPath, ['-e',source], {detached:true,stdio:'ignore'});
      const group = new runtime.OwnedProcessGroup(child);
      try {
        const deadline = Date.now()+5000;
        while ((await group.members()).length < 2 && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
        assert.equal((await group.members()).length, 2);
        const exited = once(child,'exit'); child.kill('SIGUSR2'); await exited;
        assert.equal((await group.members()).length, 1);
        await group.stop(true); assert.equal((await group.members()).length, 0);
      } finally { await group.stop(true); }
    `);
  });
  it('refuses to signal an unconfirmed process-group identity', () => {
    run(`
      const {spawn} = await import('node:child_process');
      const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      const group = new runtime.OwnedProcessGroup(child); const saved = new Map(group.known);
      try {
        group.known.clear(); let refused = false;
        try { await group.stop(true); } catch(error) { refused = error.category === 'process-ownership-unconfirmed'; }
        assert.equal(refused,true);
      } finally { group.known = saved; await group.stop(true); }
    `);
  });
  it('sanitizes invalid credential-bearing URLs without reaching setup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'obts-stack-preflight-test-'));
    try {
      const canary = randomBytes(32).toString('hex');
      const result = spawnSync(process.execPath, [resolve('scripts/check-bridge-stack.mjs')], { encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH, TMPDIR: directory, OBTS_SYNTHETIC_POSTGRES_URL: `postgresql://synthetic:${canary}@[::` } });
      expect(`${result.stdout}${result.stderr}`.includes(canary)).toBe(false);
      expect(result.status).toBe(1);
      expect(result.stderr.length).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.failure.category).toBe('invalid-synthetic-postgres-url');
      expect(output.syntheticResourcesRemoved).toBe(true);
      const files = readdirSync(directory);
      expect(files).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(directory, files[0]!), 'utf8')).failure.category).toBe('invalid-synthetic-postgres-url');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
