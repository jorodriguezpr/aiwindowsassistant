/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import BetterSqlite3 from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config';

/**
 * Versioned migrations applied against PRAGMA user_version. Each entry is run
 * exactly once, in order — append new migrations rather than editing old ones.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS conversation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls_json TEXT,
    tool_call_id TEXT,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_history_chat ON conversation_history(chat_id, seq);

  CREATE TABLE IF NOT EXISTS claude_sessions (
    chat_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS parked_chats (
    chat_id INTEGER PRIMARY KEY,
    parked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    tags TEXT,
    summary TEXT NOT NULL,
    source TEXT
  );

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    schedule_desc TEXT NOT NULL,
    prompt TEXT NOT NULL,
    engine TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_run_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
  );
  `,
];

let db: BetterSqlite3.Database | null = null;

/** Lazily opens (and migrates) data/aiwindowsassistant.db. Safe to call repeatedly. */
export function getDb(): BetterSqlite3.Database {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, 'aiwindowsassistant.db');
  db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(database: BetterSqlite3.Database): void {
  const currentVersion = database.pragma('user_version', { simple: true }) as number;
  for (let v = currentVersion; v < MIGRATIONS.length; v++) {
    database.exec(MIGRATIONS[v]);
    database.pragma(`user_version = ${v + 1}`);
  }
}
