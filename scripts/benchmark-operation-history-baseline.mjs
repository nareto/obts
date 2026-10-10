import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export async function loadLegacyMetadataStore(ref, root) {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const commit = git('rev-parse', '--verify', `${ref}^{commit}`).trim();
  const sources = [];
  const visited = new Set();
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  async function emit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    const source = git('show', `${commit}:${path}`);
    sources.push({ path, sha256: createHash('sha256').update(source).digest('hex') });
    const output = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
    }).outputText;
    for (const match of output.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/gu)) {
      const dependency = match[1];
      if (dependency.startsWith('node:')) continue;
      if (!dependency.startsWith('.')) throw new Error(`Unsupported legacy dependency: ${dependency}`);
      await emit(posix.normalize(posix.join(posix.dirname(path), dependency)).replace(/\.js$/u, '.ts'));
    }
    const destination = join(root, path.replace(/\.ts$/u, '.js'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, output);
  }
  await emit('src/server/metadataStore.ts');
  const { MetadataStore } = await import(pathToFileURL(join(root, 'src/server/metadataStore.js')).href);
  return { MetadataStore, provenance: { commit, typescript: ts.version, sources } };
}
