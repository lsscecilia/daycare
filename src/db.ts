import { Database } from "bun:sqlite";
import { ensureDirs, P } from "./paths";

// Schema history. Never edit an entry once shipped; append a new one.
const MIGRATIONS = [
  `
  CREATE TABLE item (
    id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    repo TEXT NOT NULL, worktree TEXT, branch TEXT, base TEXT, here INTEGER NOT NULL DEFAULT 0,
    template TEXT, status TEXT NOT NULL DEFAULT 'active', reviewed_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE step (
    id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES item(id), idx INTEGER NOT NULL,
    name TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    provider TEXT, prompt TEXT, checklist TEXT, budget_usd REAL, max_minutes REAL,
    failure_reason TEXT, evidence TEXT, result TEXT, started_at INTEGER, completed_at INTEGER
  );
  CREATE TABLE worker (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, provider TEXT, session_id TEXT,
    item_id INTEGER, step_id INTEGER, pid INTEGER, pid_started TEXT, child_pid INTEGER,
    cwd TEXT, repo_root TEXT, repo_key TEXT, title TEXT, status TEXT NOT NULL,
    doing TEXT, last_sig TEXT, repeat INTEGER NOT NULL DEFAULT 0,
    kill_reason TEXT, kill_evidence TEXT, spent REAL, budget REAL,
    out_path TEXT, err_path TEXT,
    started_at INTEGER NOT NULL, last_event_at INTEGER, turn_started_at INTEGER, ended_at INTEGER
  );
  CREATE UNIQUE INDEX worker_session ON worker(session_id);
  CREATE TABLE lock (path TEXT PRIMARY KEY, worker_id INTEGER NOT NULL, used_at INTEGER NOT NULL);
  CREATE TABLE touch (worker_id INTEGER NOT NULL, repo_key TEXT NOT NULL, rel_path TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (worker_id, repo_key, rel_path));
  CREATE TABLE transition (id INTEGER PRIMARY KEY, step_id INTEGER NOT NULL, from_status TEXT, to_status TEXT,
    source TEXT, note TEXT, at INTEGER NOT NULL);
  CREATE TABLE message (
    id INTEGER PRIMARY KEY, image TEXT, ocr TEXT, note TEXT, sender TEXT, channel TEXT, text TEXT,
    urgency TEXT, floor TEXT, summary TEXT, commands TEXT, findings TEXT, draft TEXT,
    status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE checkpoint (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, at INTEGER NOT NULL,
    branch TEXT, head TEXT, status_porcelain TEXT, diff_stat TEXT, note TEXT, session_id TEXT);
  CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)
  `,
  // v2: follow-ups. step.followup is a message to send by continuing the helper's conversation
  // (followup_session) instead of starting fresh; item.queued waits for a run in progress.
  `
  ALTER TABLE step ADD COLUMN followup TEXT;
  ALTER TABLE step ADD COLUMN followup_session TEXT;
  ALTER TABLE item ADD COLUMN queued TEXT
  `,
];

let _db: Database | undefined;

export function db(): Database {
  if (_db) return _db;
  ensureDirs();
  _db = new Database(P.db, { create: true });
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA busy_timeout = 5000");
  _db.exec("PRAGMA foreign_keys = ON");
  migrate(_db);
  return _db;
}

function version(d: Database): number {
  return (d.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function migrate(d: Database) {
  if (version(d) >= MIGRATIONS.length) return;
  tx(() => {
    // Re-read inside the write lock: another process may have migrated first.
    for (let i = version(d); i < MIGRATIONS.length; i++) {
      for (const stmt of MIGRATIONS[i].split(";")) if (stmt.trim()) d.exec(stmt);
      d.exec(`PRAGMA user_version = ${i + 1}`);
    }
  }, d);
}

// Every read-modify-write goes through here. BEGIN IMMEDIATE takes the write lock up front;
// a deferred transaction that upgrades to a write fails with SQLITE_BUSY_SNAPSHOT, which
// busy_timeout doesn't retry (measured in the design spikes). So: immediate, plus a retry.
export function tx<T>(fn: () => T, d: Database = db()): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return d.transaction(fn).immediate();
    } catch (e: any) {
      const busy = /SQLITE_BUSY|database is locked/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);
      if (!busy || attempt >= 40) throw e;
      Bun.sleepSync(15 + Math.random() * 35);
    }
  }
}

export const one = <T = any>(sql: string, ...args: any[]) => db().query(sql).get(...args) as T | null;
export const all = <T = any>(sql: string, ...args: any[]) => db().query(sql).all(...args) as T[];
export const run = (sql: string, ...args: any[]) => db().query(sql).run(...args);

export function kvGet(k: string): string | null {
  return one<{ v: string }>("SELECT v FROM kv WHERE k = ?", k)?.v ?? null;
}
export function kvSet(k: string, v: string | null) {
  if (v === null) run("DELETE FROM kv WHERE k = ?", k);
  else run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
}
