import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { createRootIgnorePolicy, MAX_ROOT_IGNORE_BYTES } from '../src/shared/rootIgnore.cjs';

const require = createRequire(import.meta.url);
const source = require('../src/shared/rootIgnore.cjs') as { createRootIgnorePolicy: typeof createRootIgnorePolicy };

function bundledPolicy(): typeof createRootIgnorePolicy {
  const artifact = readFileSync('obsidian-plugin/main.js', 'utf8');
  const module = { exports: {} as { createRootIgnorePolicy: typeof createRootIgnorePolicy } };
  vm.runInNewContext(artifact, {
    module,
    exports: module.exports,
    require(id: string) {
      if (id === 'obsidian') return { Plugin: class {}, Modal: class {}, PluginSettingTab: class {} };
      throw new Error(`Unexpected plugin import: ${id}`);
    },
    TextDecoder,
    TextEncoder,
    Buffer,
    Uint8Array,
    setTimeout,
    clearTimeout
  });
  expect(module.exports.createRootIgnorePolicy).toBeTypeOf('function');
  return module.exports.createRootIgnorePolicy;
}

const cases: Array<{ rules: string; paths: Array<[string, boolean?]> }> = [
  { rules: '*.md\n!important.md\n', paths: [['note.md'], ['sub/note.md'], ['important.md'], ['sub/important.md']] },
  { rules: '/root.txt\nsub/file.txt\n', paths: [['root.txt'], ['nested/root.txt'], ['sub/file.txt'], ['nested/sub/file.txt']] },
  { rules: 'cache/\n!cache/keep.txt\n', paths: [['cache', true], ['cache/drop.txt'], ['cache/keep.txt'], ['deep/cache/drop.txt']] },
  { rules: 'cache/\n!cache/\n!cache/keep.txt\n', paths: [['cache', true], ['cache/drop.txt'], ['cache/keep.txt']] },
  { rules: '**/logs/*.log\nfoo/**/draft?.md\n', paths: [['logs/a.log'], ['sub/logs/a.log'], ['logs/sub/a.log'], ['foo/draft1.md'], ['foo/a/b/draft2.md']] },
  { rules: '# comment\n\\#literal\n\\!literal\nname\\ with\\ space\ntrailing\\ \n', paths: [['#literal'], ['!literal'], ['name with space'], ['trailing '], ['comment']] },
  { rules: 'Case.md\nCaf\u00e9.md\n', paths: [['Case.md'], ['case.md'], ['Caf\u00e9.md'], ['Cafe\u0301.md']] },
  { rules: '*.gitignore\n.gitignore\n', paths: [['.gitignore'], ['folder/.gitignore']] },
  { rules: 'foo\n!foo/bar\n', paths: [['foo', true], ['foo/bar'], ['foo/bar/deep']] },
  { rules: 'foo/\n', paths: [['foo'], ['foo', true], ['foo/child']] }
];

describe('root .gitignore evaluator', () => {
  it('matches native git check-ignore for root-file patterns in TS, CJS, and bundled Obsidian plugin', () => {
    const implementations = [createRootIgnorePolicy, source.createRootIgnorePolicy, bundledPolicy()];
    const directory = mkdtempSync(join(tmpdir(), 'obts-root-ignore-'));
    try {
      const initialized = spawnSync('git', ['init', '-q', directory], { encoding: 'utf8' });
      expect(initialized.status, initialized.stderr).toBe(0);
      for (const { rules, paths } of cases) {
        writeFileSync(join(directory, '.gitignore'), rules);
        const policies = implementations.map((create) => create(Buffer.from(rules)));
        for (const [path, isDirectory = false] of paths) {
          const git = spawnSync('git', ['-C', directory, '-c', 'core.excludesFile=/dev/null', '-c', 'core.ignoreCase=false', 'check-ignore', '--no-index', '-q', '--', path.normalize('NFC') + (isDirectory ? '/' : '')], { encoding: 'utf8' });
          expect([0, 1], `${path}: ${git.stderr}`).toContain(git.status);
          const expected = git.status === 0 && path !== '.gitignore';
          for (const policy of policies) {
            expect(policy.ignores(path, isDirectory), `${JSON.stringify(rules)} -> ${path}`).toBe(expected);
          }
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on invalid and oversized policy bytes, and permits an absent or empty policy', () => {
    for (const create of [createRootIgnorePolicy, source.createRootIgnorePolicy, bundledPolicy()]) {
      expect(create(null).ignores('notes.md')).toBe(false);
      expect(create(new Uint8Array()).ignores('notes.md')).toBe(false);
      expect(create(null).ignores('.obts/internal')).toBe(false);
      expect(() => create(new Uint8Array([0xff]))).toThrow(/valid UTF-8/u);
      expect(() => create(new Uint8Array([0xc0, 0x80]))).toThrow();
      expect(() => create(Buffer.from('foo\0bar'))).toThrow();
      expect(() => create(new Uint8Array(MAX_ROOT_IGNORE_BYTES + 1))).toThrowError(expect.objectContaining({ code: 'policy_too_large' }));
      const policy = create(Buffer.from('*.md'));
      expect(policy.ignores('.gitignore')).toBe(false);
      expect(policy.ignores('folder/.gitignore')).toBe(false);
      for (const path of ['/absolute', '../escape', 'a//b', 'a\\b', 'a/./b', 'a/']) {
        expect(() => policy.ignores(path)).toThrow();
      }
    }
  });
});
