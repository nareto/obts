import { createHash } from 'node:crypto';
import { constants, closeSync, fsyncSync, lstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, open, readdir, lstat, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  assertDeletionRootUnchanged, assertNoSymlinkComponents, closeDeletionRoot, openDeletionRoot,
  readDeletionRootEntries, removeDeletionRootFileChild, removeEmptyDeletionRootDirectoryChild, syncDeletionRoot,
  type DeletionRoot
} from './deletionRoot.js';
import type { SyncOperationRow } from './metadataStore.js';

const HISTORY_SCHEMA = [
  { type: 'table', name: 'ledger_meta', sql: `CREATE TABLE ledger_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        vault_id TEXT NOT NULL,
        ledger_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        max_sequence INTEGER NOT NULL
      )` },
  { type: 'table', name: 'operations', sql: `CREATE TABLE operations (
        operation_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        vault_id TEXT NOT NULL,
        device_id TEXT,
        target_commit TEXT,
        status TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        attempt_id TEXT,
        attempt_hash TEXT,
        has_proposal_base INTEGER NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL
      )` },
  { type: 'index', name: 'operations_attempt', sql: `CREATE INDEX operations_attempt ON operations(device_id, operation_type, attempt_id, sequence)` },
  { type: 'index', name: 'operations_target_bound', sql: `CREATE INDEX operations_target_bound ON operations(device_id, operation_type, target_commit, has_proposal_base, sequence)` },
  { type: 'index', name: 'operations_target_status', sql: `CREATE INDEX operations_target_status ON operations(device_id, operation_type, target_commit, has_proposal_base, status, sequence)` },
  { type: 'index', name: 'operations_pending', sql: `CREATE INDEX operations_pending ON operations(status, operation_type, device_id, target_commit, sequence)` },
  { type: 'table', name: 'operation_counts', sql: `CREATE TABLE operation_counts (
        operation_type TEXT NOT NULL,
        status TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY(operation_type,status)
      )` },
  { type: 'trigger', name: 'operations_count_insert', sql: `CREATE TRIGGER operations_count_insert AFTER INSERT ON operations BEGIN
        INSERT INTO operation_counts(operation_type,status,count) VALUES(NEW.operation_type,NEW.status,1)
        ON CONFLICT(operation_type,status) DO UPDATE SET count=count+1;
      END` },
  { type: 'table', name: 'batches', sql: `CREATE TABLE batches (
        batch_id TEXT PRIMARY KEY,
        parent_generation INTEGER NOT NULL,
        target_generation INTEGER NOT NULL,
        row_count INTEGER NOT NULL
      )` }
];

export type HistoryPublication = {
  fsyncFile(path: string): Promise<void>;
  fsyncDirectory(path: string): Promise<void>;
};

const defaultPublication: HistoryPublication = {
  fsyncFile: syncPath,
  fsyncDirectory: syncPath
};

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

type HistoryRecord = {
  operation_id: string;
  sequence: number;
  vault_id: string;
  device_id: string | null;
  target_commit: string | null;
  status: string;
  operation_type: string;
  attempt_id: string | null;
  attempt_hash: string | null;
  has_proposal_base: number;
  canonical_json: string;
  canonical_hash: string;
};

type HistoryOpenState = { generation: number; nextSequence: number; pendingBatch?: HistoryBatch | null };

export type HistoryBatch = {
  vault_id: string;
  ledger_id: string;
  batch_id: string;
  parent_generation: number;
  target_generation: number;
  rows: Array<{ operation_id: string; sequence: number; canonical: string; sha256: string }>;
};

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, sortJson(item)]));
}

export class OperationHistoryStore {
  private readonly db: DatabaseSync;
  private readonly fileIdentity: { dev: number; ino: number };
  readonly ledgerId: string;

  private constructor(private readonly directory: string, private readonly path: string, private readonly vaultId: string, ledgerId: string, existedBefore: boolean, validateContents: boolean, readOnly = false, state?: HistoryOpenState) {
    this.ledgerId = ledgerId;
    this.db = new DatabaseSync(path, { readOnly });
    try {
      const stat = lstatSync(path);
      this.fileIdentity = { dev: stat.dev, ino: stat.ino };
      if (existedBefore) {
        OperationHistoryStore.verifyIdentity(this.db, vaultId, ledgerId);
        OperationHistoryStore.verifySchema(this.db);
        if (validateContents) this.verifyContents();
        if (state) this.verifyOpenState(state);
      }
      const mode = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
      this.db.exec('PRAGMA synchronous=EXTRA');
      const sync = this.db.prepare('PRAGMA synchronous').get() as { synchronous?: number };
      if (mode?.journal_mode?.toLowerCase() !== 'delete' || sync?.synchronous !== 3) {
        throw new Error('Operation history durability configuration is unavailable.');
      }
      if (!existedBefore) {
        this.db.exec('BEGIN IMMEDIATE');
        for (const object of HISTORY_SCHEMA) this.db.exec(object.sql);
        this.db.prepare('INSERT INTO ledger_meta(singleton, schema_version, vault_id, ledger_id, generation, max_sequence) VALUES(1, 1, ?, ?, 0, 0)').run(vaultId, ledgerId);
        this.db.exec('COMMIT');
      }
    } catch (error) {
      try { this.db.close(); } catch {}
      throw error;
    }
  }

  private static verifySchema(db: DatabaseSync): void {
    const objects = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ type: string; name: string; sql: string }>;
    const normalize = (sql: string) => sql.replace(/\s+/gu, ' ').trim();
    if (objects.length !== HISTORY_SCHEMA.length || HISTORY_SCHEMA.some((expected) =>
      !objects.some((actual) => actual.type === expected.type && actual.name === expected.name && normalize(actual.sql) === normalize(expected.sql)))) {
      throw new Error('Operation history schema is incomplete or inconsistent.');
    }
  }

  private static verifyIdentity(db: DatabaseSync, vaultId: string, ledgerId: string, generation?: number, nextSequence?: number): void {
    const rows = db.prepare('SELECT singleton,schema_version,vault_id,ledger_id,generation,max_sequence FROM ledger_meta LIMIT 2').all() as
      Array<{ singleton: number; schema_version: number; vault_id: string; ledger_id: string; generation: number; max_sequence: number }>;
    const meta = rows[0];
    if (rows.length !== 1 || !meta || meta.singleton !== 1 || meta.schema_version !== 1 || meta.vault_id !== vaultId || meta.ledger_id !== ledgerId) {
      throw new Error('Operation history ledger identity mismatch.');
    }
    const last = db.prepare('SELECT MAX(sequence) AS sequence FROM operations').get() as { sequence: number | null };
    if (!Number.isSafeInteger(meta.generation) || meta.generation < 0 || !Number.isSafeInteger(meta.max_sequence) || meta.max_sequence < 0 ||
        meta.max_sequence !== (last.sequence ?? 0) ||
        generation !== undefined && meta.generation !== generation || nextSequence !== undefined && meta.max_sequence >= nextSequence) {
      throw new Error('Operation history generation or sequence mismatch.');
    }
  }

  private verifyContents(): void {
    const integrity = this.db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('Operation history index integrity failure.');
    let rowCount = 0;
    let maxSequence = 0;
    for (const record of this.db.prepare('SELECT * FROM operations NOT INDEXED').iterate() as Iterable<HistoryRecord>) {
      const row = this.decodeRow(record);
      if (!Number.isSafeInteger(record.sequence) || record.sequence <= 0 || row.status !== 'committed' && row.status !== 'aborted') {
        throw new Error('Operation history row payload is corrupt.');
      }
      rowCount += 1;
      maxSequence = Math.max(maxSequence, record.sequence);
    }
    const countsDiffer = this.db.prepare(`
      WITH actual AS (SELECT operation_type,status,COUNT(*) AS count FROM operations NOT INDEXED GROUP BY operation_type,status),
      missing AS (SELECT * FROM actual EXCEPT SELECT * FROM operation_counts),
      extra AS (SELECT * FROM operation_counts EXCEPT SELECT * FROM actual)
      SELECT 1 FROM missing UNION ALL SELECT 1 FROM extra LIMIT 1
    `).get();
    let generation = 0;
    let provenRows = 0;
    for (const batch of this.db.prepare('SELECT parent_generation,target_generation,row_count FROM batches ORDER BY target_generation').iterate()) {
      if (batch.parent_generation !== generation || batch.target_generation !== generation + 1 ||
          !Number.isSafeInteger(batch.row_count) || Number(batch.row_count) <= 0 || Number(batch.row_count) > 256) {
        throw new Error('Operation history batch proof is inconsistent.');
      }
      generation += 1;
      provenRows += Number(batch.row_count);
    }
    if (this.generation !== generation || this.maxSequence !== maxSequence) throw new Error('Operation history generation or sequence mismatch.');
    if (countsDiffer || provenRows !== rowCount) throw new Error('Operation history aggregate or batch proof is inconsistent.');
  }

  static async open(directory: string, vaultId: string, ledgerId: string, allowCreate: boolean, publication: HistoryPublication = defaultPublication, validateContents = true, state?: HistoryOpenState): Promise<OperationHistoryStore> {
    if (allowCreate && state && (state.generation !== 0 || state.pendingBatch !== null)) {
      throw new Error('Operation history initialization state is inconsistent.');
    }
    await assertNoSymlinkComponents(directory);
    if (!allowCreate && !OperationHistoryStore.pathExists(directory)) throw new Error('Acknowledged operation history ledger is missing.');
    const firstCreated = allowCreate ? await mkdir(directory, { recursive: true, mode: 0o700 }) : undefined;
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Operation history directory is unsafe.');
    const path = join(directory, 'history.sqlite');
    const root = await openDeletionRoot(directory);
    try {
      await OperationHistoryStore.clearRecoveryScratch(root, vaultId, ledgerId);
      if (allowCreate) await OperationHistoryStore.clearOwnedScratch(root, vaultId, ledgerId, 'initial');
    } finally { await closeDeletionRoot(root); }
    const entries = await readdir(directory);
    const candidates = entries.filter((name) => !['history.sqlite', 'history.sqlite-journal'].includes(name));
    if (candidates.length) throw new Error('Unexpected operation history residue.');
    if (entries.includes('history.sqlite-journal')) {
      const journal = await lstat(join(directory, 'history.sqlite-journal'));
      if (!journal.isFile() || journal.isSymbolicLink()) throw new Error('Operation history journal is unsafe.');
    }
    let existed = false;
    try {
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('Unrecognized existing operation history ledger.');
      existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!allowCreate) throw new Error('Acknowledged operation history ledger is missing.');
    }
    if (!existed && entries.length) throw new Error('Operation history journal has no ledger.');
    if (existed) await OperationHistoryStore.preflight(directory, vaultId, ledgerId, state);
    if (!existed) await OperationHistoryStore.publishInitialLedger(directory, vaultId, ledgerId, publication);
    const store = new OperationHistoryStore(directory, path, vaultId, ledgerId, true, validateContents, false, state);
    try {
      await chmod(directory, 0o700);
      await chmod(path, 0o600);
      if (allowCreate) {
        await publication.fsyncFile(path);
        const defaultParent = dirname(dirname(directory));
        const createdParent = firstCreated ? dirname(firstCreated) : defaultParent;
        const publicationParent = createdParent.length < defaultParent.length ? createdParent : defaultParent;
        let current = directory;
        while (true) {
          await publication.fsyncDirectory(current);
          if (current === publicationParent) break;
          const parent = dirname(current);
          if (parent === current) throw new Error('Operation history publication parent is invalid.');
          current = parent;
        }
      }
      return store;
    } catch (error) {
      try { store.close(); } catch {}
      throw error;
    }
  }

  private verifyOpenState(state: HistoryOpenState): void {
    if (this.maxSequence >= state.nextSequence) throw new Error('Operation history generation or sequence mismatch.');
    const batch = state.pendingBatch;
    if (!batch) {
      if (this.generation !== state.generation) throw new Error('Operation history generation or sequence mismatch.');
    } else if (batch.vault_id !== this.vaultId || batch.ledger_id !== this.ledgerId || batch.parent_generation !== state.generation ||
        batch.target_generation !== state.generation + 1 ||
        this.generation !== batch.parent_generation && (this.generation !== batch.target_generation || !this.hasBatch(batch))) {
      throw new Error('Operation history archive proof is missing.');
    } else if (this.generation === batch.parent_generation) {
      const priorBatch = this.db.prepare('SELECT 1 FROM batches WHERE batch_id=?').get(batch.batch_id);
      const priorRow = this.db.prepare('SELECT 1 FROM operations WHERE operation_id=? OR sequence=? LIMIT 1');
      if (priorBatch || batch.rows.some((row) => priorRow.get(row.operation_id, row.sequence))) {
        throw new Error('Operation history pending batch collides with existing evidence.');
      }
    }
  }

  private static scratchName(vaultId: string, ledgerId: string, purpose: 'recovery' | 'initial'): string {
    return `.${purpose}-${createHash('sha256').update(JSON.stringify([vaultId, ledgerId])).digest('hex')}`;
  }

  private static async publishInitialLedger(directory: string, vaultId: string, ledgerId: string, publication: HistoryPublication): Promise<void> {
    const root = await openDeletionRoot(directory);
    const name = OperationHistoryStore.scratchName(vaultId, ledgerId, 'initial');
    const stagedDirectory = join(directory, name);
    const stagedPath = join(stagedDirectory, 'history.sqlite');
    let staged: DeletionRoot | undefined;
    let failed = false;
    try {
      await mkdir(join(root.fdPath, name), { mode: 0o700 });
      staged = await openDeletionRoot(stagedDirectory);
      const file = await open(join(staged.fdPath, 'history.sqlite'), 'wx', 0o600);
      await file.close();
      const store = new OperationHistoryStore(stagedDirectory, stagedPath, vaultId, ledgerId, false, false);
      // SQLite must release its connection and journal pathname before the database moves.
      store.close();
      await publication.fsyncFile(stagedPath);
      await publication.fsyncDirectory(stagedDirectory);
      await assertDeletionRootUnchanged(root);
      await assertDeletionRootUnchanged(staged);
      const entries = await readDeletionRootEntries(root);
      if (entries.length !== 1 || entries[0]?.name !== name ||
          (await readDeletionRootEntries(staged)).some(({ name }) => name !== 'history.sqlite')) {
        throw new Error('Unexpected operation history residue.');
      }
      await rename(join(staged.fdPath, 'history.sqlite'), join(root.fdPath, 'history.sqlite'));
      await OperationHistoryStore.clearOwnedScratch(root, vaultId, ledgerId, 'initial');
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        if (staged) await closeDeletionRoot(staged);
      } catch (error) {
        if (!failed) { failed = true; throw error; }
      } finally {
        try { await closeDeletionRoot(root); } catch (error) { if (!failed) throw error; }
      }
    }
  }

  private static async clearRecoveryScratch(root: DeletionRoot, vaultId: string, ledgerId: string): Promise<void> {
    await OperationHistoryStore.clearOwnedScratch(root, vaultId, ledgerId, 'recovery');
  }

  private static async clearOwnedScratch(root: DeletionRoot, vaultId: string, ledgerId: string, purpose: 'recovery' | 'initial'): Promise<void> {
    const name = OperationHistoryStore.scratchName(vaultId, ledgerId, purpose);
    await assertDeletionRootUnchanged(root);
    const path = join(root.configuredPath, name);
    let scratch: DeletionRoot;
    try { scratch = await openDeletionRoot(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      const info = await scratch.handle.stat();
      if ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid!()) throw new Error('Operation history recovery ownership is unsafe.');
      const entries = await readDeletionRootEntries(scratch);
      if (entries.some(({ name }) => !['history.sqlite', 'history.sqlite-journal'].includes(name))) throw new Error('Unexpected operation history recovery residue.');
      const files = [];
      for (const { name } of entries) {
        const stat = await lstat(join(scratch.fdPath, name), { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n || stat.uid !== BigInt(process.getuid!())) {
          throw new Error('Operation history recovery residue is unsafe.');
        }
        files.push({ name, stat });
      }
      for (const { name, stat } of files) {
        await assertDeletionRootUnchanged(root);
        await removeDeletionRootFileChild(scratch, name, stat);
      }
      await syncDeletionRoot(scratch);
      await removeEmptyDeletionRootDirectoryChild(root, name, scratch);
      await syncDeletionRoot(root);
    } finally { await closeDeletionRoot(scratch); }
  }

  private static async fingerprint(root: DeletionRoot, name: string, destination?: DeletionRoot): Promise<string> {
    await assertDeletionRootUnchanged(root);
    const path = join(root.fdPath, name);
    const initial = await lstat(path, { bigint: true });
    const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await source.stat({ bigint: true });
      if (!stat.isFile() || initial.isSymbolicLink() || initial.dev !== stat.dev || initial.ino !== stat.ino) throw new Error('Operation history recovery source changed.');
      if (destination) await assertDeletionRootUnchanged(destination);
      const output = destination ? await open(join(destination.fdPath, name), 'wx', 0o600) : undefined;
      const hash = createHash('sha256');
      try {
        const buffer = Buffer.alloc(64 * 1024);
        while (true) {
          const { bytesRead } = await source.read(buffer);
          if (!bytesRead) break;
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          if (output) await output.writeFile(chunk);
        }
        if (output) await output.sync();
      } finally { await output?.close(); }
      const current = await lstat(path, { bigint: true });
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeNs !== stat.mtimeNs || current.ctimeNs !== stat.ctimeNs) {
        throw new Error('Operation history recovery source changed.');
      }
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, hash.digest('hex')].join(':');
    } finally { await source.close(); }
  }

  private static async preflight(directory: string, vaultId: string, ledgerId: string, state?: HistoryOpenState): Promise<void> {
    const path = join(directory, 'history.sqlite');
    try {
      const readonly = new OperationHistoryStore(directory, path, vaultId, ledgerId, true, false, true, state);
      readonly.close();
      return;
    } catch (error) {
      // SQLITE_READONLY_ROLLBACK is the only refusal that authorizes recovery of a private copy.
      if ((error as { code?: string; errcode?: number }).code !== 'ERR_SQLITE_ERROR' || (error as { errcode?: number }).errcode !== 776) throw error;
    }
    const root = await openDeletionRoot(directory);
    const name = OperationHistoryStore.scratchName(vaultId, ledgerId, 'recovery');
    const scratchPath = join(directory, name);
    let scratch: DeletionRoot | undefined;
    let failure: unknown;
    let cleaned = false;
    try {
      await mkdir(join(root.fdPath, name), { mode: 0o700 });
      scratch = await openDeletionRoot(scratchPath);
      const database = await OperationHistoryStore.fingerprint(root, 'history.sqlite', scratch);
      const journal = await OperationHistoryStore.fingerprint(root, 'history.sqlite-journal', scratch);
      await assertDeletionRootUnchanged(scratch);
      const copy = new OperationHistoryStore(scratchPath, join(scratchPath, 'history.sqlite'), vaultId, ledgerId, true, true, false, state);
      copy.close();
      await closeDeletionRoot(scratch);
      scratch = undefined;
      await OperationHistoryStore.clearRecoveryScratch(root, vaultId, ledgerId);
      cleaned = true;
      const entries = await readDeletionRootEntries(root);
      if (entries.length !== 2 || entries.some(({ name }) => !['history.sqlite', 'history.sqlite-journal'].includes(name))) throw new Error('Unexpected operation history residue.');
      if (await OperationHistoryStore.fingerprint(root, 'history.sqlite') !== database ||
          await OperationHistoryStore.fingerprint(root, 'history.sqlite-journal') !== journal) throw new Error('Operation history recovery source changed.');
      await assertDeletionRootUnchanged(root);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        if (scratch) await closeDeletionRoot(scratch);
        if (!cleaned) await OperationHistoryStore.clearRecoveryScratch(root, vaultId, ledgerId);
      } catch (error) {
        if (!failure) throw error;
      } finally { await closeDeletionRoot(root); }
    }
  }

  get generation(): number {
    return (this.db.prepare('SELECT generation FROM ledger_meta WHERE singleton=1').get() as { generation: number }).generation;
  }

  get maxSequence(): number {
    return (this.db.prepare('SELECT max_sequence FROM ledger_meta WHERE singleton=1').get() as { max_sequence: number }).max_sequence;
  }

  verifyAvailable(generation?: number, nextSequence?: number): void {
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== this.fileIdentity.dev || stat.ino !== this.fileIdentity.ino) {
      throw new Error('Operation history ledger path identity changed.');
    }
    OperationHistoryStore.verifyIdentity(this.db, this.vaultId, this.ledgerId, generation, nextSequence);
    OperationHistoryStore.verifySchema(this.db);
  }

  isAvailable(): boolean {
    try {
      this.verifyAvailable();
      return true;
    } catch {
      return false;
    }
  }

  static pathExists(directory: string): boolean {
    try {
      const directoryStat = lstatSync(directory);
      const fileStat = lstatSync(join(directory, 'history.sqlite'));
      return directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && fileStat.isFile() && !fileStat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  static verifyOnDisk(directory: string, vaultId: string, ledgerId: string, generation: number, nextSequence: number): void {
    if (!OperationHistoryStore.pathExists(directory)) throw new Error('Operation history ledger is missing or unsafe.');
    const db = new DatabaseSync(join(directory, 'history.sqlite'), { readOnly: true });
    try {
      const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
      db.exec('PRAGMA synchronous=EXTRA');
      const sync = db.prepare('PRAGMA synchronous').get() as { synchronous?: number };
      if (mode?.journal_mode?.toLowerCase() !== 'delete' || sync.synchronous !== 3) {
        throw new Error('Operation history durability configuration is unavailable.');
      }
      OperationHistoryStore.verifyIdentity(db, vaultId, ledgerId, generation, nextSequence);
      OperationHistoryStore.verifySchema(db);
    } finally {
      db.close();
    }
  }

  commitBatch(batch: HistoryBatch): void {
    if (batch.vault_id !== this.vaultId || batch.ledger_id !== this.ledgerId || batch.target_generation !== batch.parent_generation + 1) {
      throw new Error('Invalid operation history batch identity.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const meta = this.db.prepare('SELECT generation FROM ledger_meta WHERE singleton=1').get() as { generation: number };
      const priorBatch = this.db.prepare('SELECT parent_generation,target_generation,row_count FROM batches WHERE batch_id=?').get(batch.batch_id) as { parent_generation: number; target_generation: number; row_count: number } | undefined;
      if (priorBatch) {
        if (priorBatch.parent_generation !== batch.parent_generation || priorBatch.target_generation !== batch.target_generation || priorBatch.row_count !== batch.rows.length || meta.generation !== batch.target_generation) throw new Error('Operation history batch proof mismatch.');
        const find = this.db.prepare('SELECT canonical_hash,sequence,canonical_json FROM operations WHERE operation_id=?');
        for (const row of batch.rows) {
          const prior = find.get(row.operation_id) as { canonical_hash: string; sequence: number; canonical_json: string } | undefined;
          if (!prior || prior.canonical_hash !== row.sha256 || prior.sequence !== row.sequence || prior.canonical_json !== row.canonical) {
            throw new Error('Operation history batch contents mismatch.');
          }
        }
        this.db.exec('COMMIT');
        this.syncFile();
        return;
      }
      if (meta.generation !== batch.parent_generation) throw new Error('Operation history generation mismatch.');
      const insert = this.db.prepare('INSERT INTO operations(operation_id,sequence,vault_id,device_id,target_commit,status,operation_type,attempt_id,attempt_hash,has_proposal_base,canonical_json,canonical_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      const find = this.db.prepare('SELECT canonical_hash,sequence FROM operations WHERE operation_id=?');
      for (const row of batch.rows) {
        const prior = find.get(row.operation_id) as { canonical_hash: string; sequence: number } | undefined;
        if (prior) throw new Error('Operation history identity collision.');
        const operation = JSON.parse(row.canonical) as SyncOperationRow;
        const canonical = OperationHistoryStore.canonical(operation);
        if (canonical.text !== row.canonical || canonical.sha256 !== row.sha256 || operation.operation_id !== row.operation_id ||
            operation.operation_sequence !== row.sequence || operation.vault_id !== this.vaultId ||
            operation.status !== 'committed' && operation.status !== 'aborted') {
          throw new Error('Operation history row payload is invalid.');
        }
        const manifest = operation.prepared_manifest as Record<string, unknown> | null;
        const attemptId = typeof manifest?.attempt_id === 'string' ? manifest.attempt_id : null;
        const attemptHash = typeof manifest?.attempt_hash === 'string' ? manifest.attempt_hash : null;
        insert.run(operation.operation_id, row.sequence, operation.vault_id, operation.device_id, operation.target_commit,
          operation.status, operation.operation_type, attemptId, attemptHash,
          Number(Object.hasOwn(operation, 'proposal_base')), row.canonical, row.sha256);
      }
      this.db.prepare('INSERT INTO batches(batch_id,parent_generation,target_generation,row_count) VALUES(?,?,?,?)').run(batch.batch_id, batch.parent_generation, batch.target_generation, batch.rows.length);
      this.db.prepare('UPDATE ledger_meta SET generation=?,max_sequence=MAX(max_sequence,?) WHERE singleton=1')
        .run(batch.target_generation, Math.max(...batch.rows.map((row) => row.sequence)));
      this.db.exec('COMMIT');
      this.syncFile();
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  hasBatch(batch: HistoryBatch): boolean {
    const proof = this.db.prepare('SELECT parent_generation,target_generation,row_count FROM batches WHERE batch_id=?').get(batch.batch_id) as { parent_generation: number; target_generation: number; row_count: number } | undefined;
    if (proof?.parent_generation !== batch.parent_generation || proof.target_generation !== batch.target_generation || proof.row_count !== batch.rows.length) return false;
    const find = this.db.prepare('SELECT canonical_hash,sequence,canonical_json FROM operations WHERE operation_id=?');
    return batch.rows.every((row) => {
      const prior = find.get(row.operation_id) as { canonical_hash: string; sequence: number; canonical_json: string } | undefined;
      return prior?.canonical_hash === row.sha256 && prior.sequence === row.sequence && prior.canonical_json === row.canonical;
    });
  }

  findAttempt(deviceId: string, attemptId: string): { row: SyncOperationRow; sequence: number } | null {
    const row = this.db.prepare("SELECT operation_id,sequence,vault_id,device_id,target_commit,status,operation_type,attempt_id,attempt_hash,has_proposal_base,canonical_json,canonical_hash FROM operations WHERE device_id=? AND operation_type='device_push' AND attempt_id=? ORDER BY sequence LIMIT 1").get(deviceId, attemptId) as HistoryRecord | undefined;
    return row ? { row: this.decodeRow(row), sequence: row.sequence } : null;
  }

  findTargetCandidates(deviceId: string, target: string): Array<{ row: SyncOperationRow; sequence: number }> {
    const columns = 'operation_id,sequence,vault_id,device_id,target_commit,status,operation_type,attempt_id,attempt_hash,has_proposal_base,canonical_json,canonical_hash';
    const bound = this.db.prepare(`SELECT ${columns} FROM operations WHERE device_id=? AND operation_type='device_push' AND target_commit=? AND has_proposal_base=1 ORDER BY sequence LIMIT 1`).get(deviceId, target) as HistoryRecord | undefined;
    const findLegacy = this.db.prepare(`SELECT ${columns} FROM operations WHERE device_id=? AND operation_type='device_push' AND target_commit=? AND has_proposal_base=0 AND status=? ORDER BY sequence LIMIT 1`);
    const prepared = findLegacy.get(deviceId, target, 'prepared') as HistoryRecord | undefined;
    const committed = findLegacy.get(deviceId, target, 'committed') as HistoryRecord | undefined;
    const legacy = [prepared, committed].filter((value): value is HistoryRecord => value !== undefined)
      .sort((left, right) => left.sequence - right.sequence)[0];
    return [bound, legacy].filter((value): value is HistoryRecord => value !== undefined)
      .map((value) => ({ row: this.decodeRow(value), sequence: value.sequence }));
  }

  countByTypeStatus(excludedIds: string[] = []): Array<{ operation_type: string; status: string; count: number }> {
    const counts = this.db.prepare('SELECT operation_type,status,count FROM operation_counts').all() as Array<{ operation_type: string; status: string; count: number }>;
    if (excludedIds.length === 0) return counts;
    const excluded = this.db.prepare(`SELECT operation_type,status,COUNT(*) AS count FROM operations WHERE operation_id IN (${excludedIds.map(() => '?').join(',')}) GROUP BY operation_type,status`)
      .all(...excludedIds) as Array<{ operation_type: string; status: string; count: number }>;
    const excludedCounts = new Map(excluded.map((item) => [`${item.operation_type}:${item.status}`, item.count]));
    return counts.map((item) => ({ ...item, count: item.count - (excludedCounts.get(`${item.operation_type}:${item.status}`) ?? 0) }))
      .filter((item) => item.count > 0);
  }

  exportRows(): SyncOperationRow[] {
    return (this.db.prepare('SELECT operation_id,sequence,vault_id,device_id,target_commit,status,operation_type,attempt_id,attempt_hash,has_proposal_base,canonical_json,canonical_hash FROM operations ORDER BY sequence').all() as HistoryRecord[])
      .map((row) => this.decodeRow(row));
  }

  close(): void { this.db.close(); }

  private decodeRow(record: HistoryRecord): SyncOperationRow {
    let row: SyncOperationRow;
    try { row = JSON.parse(record.canonical_json) as SyncOperationRow; }
    catch { throw new Error('Operation history row payload is corrupt.'); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Operation history row payload is corrupt.');
    const canonical = OperationHistoryStore.canonical(row);
    if (canonical.text !== record.canonical_json || canonical.sha256 !== record.canonical_hash ||
        row.operation_id !== record.operation_id || row.operation_sequence !== record.sequence ||
        row.vault_id !== this.vaultId || record.vault_id !== this.vaultId || record.device_id !== row.device_id ||
        record.target_commit !== row.target_commit || record.status !== row.status || record.operation_type !== row.operation_type ||
        record.attempt_id !== (typeof row.prepared_manifest?.attempt_id === 'string' ? row.prepared_manifest.attempt_id : null) ||
        record.attempt_hash !== (typeof row.prepared_manifest?.attempt_hash === 'string' ? row.prepared_manifest.attempt_hash : null) ||
        record.has_proposal_base !== Number(Object.hasOwn(row, 'proposal_base'))) {
      throw new Error('Operation history row payload is corrupt.');
    }
    return row;
  }

  static async eraseDirectory(directory: string, ownership?: { vaultId: string; ledgerId: string }): Promise<void> {
    let parent: DeletionRoot;
    try {
      parent = await openDeletionRoot(dirname(directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let root: DeletionRoot | undefined;
    try {
      try {
        root = await openDeletionRoot(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await syncDeletionRoot(parent);
        return;
      }
      if (ownership) {
        await OperationHistoryStore.clearRecoveryScratch(root, ownership.vaultId, ownership.ledgerId);
        await OperationHistoryStore.clearOwnedScratch(root, ownership.vaultId, ownership.ledgerId, 'initial');
      }
      const names = await readDeletionRootEntries(root);
      if (names.some(({ name }) => !['history.sqlite', 'history.sqlite-journal'].includes(name))) {
        throw new Error('Unexpected operation history residue.');
      }
      const files = [];
      for (const { name } of names) {
        const stat = await lstat(join(root.fdPath, name), { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Operation history residue is unsafe.');
        files.push({ name, stat });
      }
      for (const { name, stat } of files) {
        await assertDeletionRootUnchanged(parent);
        await removeDeletionRootFileChild(root, name, stat);
      }
      await syncDeletionRoot(root);
      await removeEmptyDeletionRootDirectoryChild(parent, basename(directory), root);
      await syncDeletionRoot(parent);
    } finally {
      if (root) await closeDeletionRoot(root);
      await closeDeletionRoot(parent);
    }
  }

  static canonical(row: SyncOperationRow): { text: string; sha256: string } {
    const text = JSON.stringify(sortJson(row));
    return { text, sha256: createHash('sha256').update(text).digest('hex') };
  }

  private syncFile(): void {
    const fd = openSync(this.path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    this.syncDirectory();
  }

  private syncDirectory(): void {
    const fd = openSync(this.directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
