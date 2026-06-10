/**
 * usage/sqlite — a lazy, read-only sql.js (WASM) loader for SQLite readers.
 *
 * Why sql.js: pure WASM, zero native build / node-gyp / prebuilt-binary matrix,
 * so it installs identically on Linux/macOS/Windows and in CI (the decisive
 * constraint — see docs/research/usage-design.md §2). We never write the host DB:
 * we load its bytes and run SELECTs, then discard.
 *
 * Read-only by construction:
 *   • open by reading the file into a Uint8Array → new SQL.Database(bytes);
 *   • if a -wal/-shm sidecar exists, the on-disk file may be a half-flushed
 *     snapshot, so we copy the db (+ sidecars) into an os.tmpdir temp path,
 *     open the copy, and clean it up afterward. This avoids reading a torn page
 *     of a live DB (Crush/OpenCode can be running).
 *
 * Fail-open: ANY failure (missing wasm, unreadable file, corrupt db, bad SQL)
 * returns null / [] — a SQLite reader degrades to zero rows, never throws.
 *
 * The WASM module is initialized once (lazy singleton) so report runs that touch
 * no SQLite reader pay nothing.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Minimal handle a SQLite reader needs: run a SELECT, then close. */
export interface SqliteDb {
  /** Run a SQL statement and return all rows as plain objects (column → value). */
  all(sql: string): Array<Record<string, unknown>>;
  /** Release the in-memory database. Idempotent. */
  close(): void;
}

/** The sql.js factory signature we depend on (a tiny structural subset). */
interface SqlJsStatic {
  Database: new (data: Uint8Array) => SqlJsDatabase;
}
interface SqlJsDatabase {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  close(): void;
}
type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;

const require = createRequire(import.meta.url);

/** Lazy singleton: the initialized sql.js module (or null if it failed to load). */
let sqlPromise: Promise<SqlJsStatic | null> | undefined;

/** Resolve the sql-wasm.wasm next to the resolved sql.js package entry. */
function locateWasm(file: string): string {
  try {
    const entry = require.resolve("sql.js"); // → node_modules/sql.js/dist/sql-wasm.js
    return join(dirname(entry), file);
  } catch {
    return file;
  }
}

/** Initialize sql.js once. Returns null (cached) when the module cannot load. */
function loadSqlJs(): Promise<SqlJsStatic | null> {
  if (sqlPromise === undefined) {
    sqlPromise = (async () => {
      try {
        // sql.js's default export is the initializer (a CommonJS module).
        const mod = require("sql.js") as InitSqlJs | { default: InitSqlJs };
        const init: InitSqlJs = typeof mod === "function" ? mod : mod.default;
        return await init({ locateFile: locateWasm });
      } catch {
        return null;
      }
    })();
  }
  return sqlPromise;
}

/** SQLite WAL/SHM sidecar suffixes that signal a possibly-live database file. */
const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

/**
 * Open a SQLite file read-only via sql.js. Returns a small {@link SqliteDb} or
 * null on any failure. When a -wal/-shm sidecar is present the db is copied to a
 * temp dir first (and the copy is removed when the handle is closed) to avoid
 * reading a torn snapshot of a live database.
 */
export async function openSqlite(path: string): Promise<SqliteDb | null> {
  if (!existsSync(path)) return null;

  const SQL = await loadSqlJs();
  if (SQL === null) return null;

  const hasSidecar = SIDECAR_SUFFIXES.some((s) => existsSync(path + s));
  let openPath = path;
  let tempDir: string | undefined;

  if (hasSidecar) {
    try {
      tempDir = mkdtempSync(join(tmpdir(), "agentconnect-usage-"));
      const dst = join(tempDir, basename(path));
      copyFileSync(path, dst);
      for (const suffix of SIDECAR_SUFFIXES) {
        const side = path + suffix;
        if (existsSync(side)) copyFileSync(side, dst + suffix);
      }
      openPath = dst;
    } catch {
      // If the copy fails, fall back to opening the original bytes directly.
      openPath = path;
      if (tempDir) {
        cleanupTemp(tempDir);
        tempDir = undefined;
      }
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(openPath);
  } catch {
    if (tempDir) cleanupTemp(tempDir);
    return null;
  }

  // Reject anything that is not a SQLite file up front (the 16-byte header magic
  // "SQLite format 3\0"). sql.js would otherwise accept arbitrary bytes and only
  // fail at query time; this keeps the documented "null on non-db" contract.
  if (!hasSqliteMagic(bytes)) {
    if (tempDir) cleanupTemp(tempDir);
    return null;
  }

  let db: SqlJsDatabase;
  try {
    db = new SQL.Database(bytes);
  } catch {
    if (tempDir) cleanupTemp(tempDir);
    return null;
  }

  let closed = false;
  return {
    all(sql: string): Array<Record<string, unknown>> {
      if (closed) return [];
      let result: Array<{ columns: string[]; values: unknown[][] }>;
      try {
        result = db.exec(sql);
      } catch {
        return []; // bad SQL / schema mismatch → no rows
      }
      const out: Array<Record<string, unknown>> = [];
      for (const block of result) {
        const { columns, values } = block;
        for (const row of values) {
          const obj: Record<string, unknown> = {};
          for (let i = 0; i < columns.length; i++) {
            const col = columns[i];
            if (col !== undefined) obj[col] = row[i];
          }
          out.push(obj);
        }
      }
      return out;
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        /* ignore */
      }
      if (tempDir) cleanupTemp(tempDir);
    },
  };
}

/** The 16-byte SQLite file header: "SQLite format 3\0". */
const SQLITE_MAGIC = Uint8Array.from([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);

/** Does `bytes` begin with the SQLite file-header magic? */
function hasSqliteMagic(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC[i]) return false;
  }
  return true;
}

function cleanupTemp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
