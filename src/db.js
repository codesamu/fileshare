import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

let db;

export function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(path.join(DATA_DIR, 'drive.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS folders (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      parent_id  TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      folder_id    TEXT,
      size         INTEGER NOT NULL,
      mime         TEXT NOT NULL,
      blob         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      downloaded   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS files_folder ON files(folder_id);

    CREATE TABLE IF NOT EXISTS shares (
      id            TEXT PRIMARY KEY,
      token         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      password_hash TEXT,
      expires_at    INTEGER,
      max_downloads INTEGER,
      downloads     INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS share_items (
      share_id TEXT NOT NULL,
      item_id  TEXT NOT NULL,
      kind     TEXT NOT NULL,
      PRIMARY KEY (share_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS ingest_log (
      path        TEXT PRIMARY KEY,
      file_id     TEXT,
      imported_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  return db;
}

export function getDb() {
  if (!db) throw new Error('database not initialised');
  return db;
}

export function getSetting(key) {
  const row = getDb().prepare('SELECT v FROM settings WHERE k = ?').get(key);
  return row ? row.v : null;
}

export function setSetting(key, value) {
  getDb()
    .prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(key, String(value));
}
