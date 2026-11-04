import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('../data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'radio.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  artist TEXT DEFAULT '',
  album TEXT DEFAULT '',
  genre TEXT DEFAULT '',
  isrc TEXT DEFAULT '',
  composer TEXT DEFAULT '',
  duration REAL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'musica',
  active INTEGER NOT NULL DEFAULT 1,
  last_played_at INTEGER,
  play_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS clocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6d5dfc',
  items TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day INTEGER NOT NULL,            -- 0 domingo ... 6 sábado
  start TEXT NOT NULL,             -- HH:MM
  end TEXT NOT NULL,               -- HH:MM (24:00 = meia-noite)
  kind TEXT NOT NULL,              -- relogio | programa | aovivo
  title TEXT NOT NULL,
  clock_id INTEGER REFERENCES clocks(id) ON DELETE SET NULL,
  items TEXT NOT NULL DEFAULT '[]' -- programa: lista ordenada de track ids
);

CREATE TABLE IF NOT EXISTS play_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER,
  title TEXT,
  artist TEXT,
  composer TEXT,
  isrc TEXT,
  category TEXT,
  duration REAL,
  slot_title TEXT,
  source TEXT DEFAULT 'automacao',
  started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_time ON play_log(started_at);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);

// Migrações simples
const cols = db.prepare('PRAGMA table_info(tracks)').all().map((c) => c.name);
if (!cols.includes('loudness')) db.exec('ALTER TABLE tracks ADD COLUMN loudness REAL');

export const CATEGORIES = {
  musica: 'Música',
  vinheta: 'Vinheta',
  programa: 'Programa',
  podcast: 'Podcast',
  spot: 'Comercial',
  horacerta: 'Hora certa',
};

export function kvGet(k, fallback = null) {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return row ? JSON.parse(row.v) : fallback;
}
export function kvSet(k, v) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
}

export const DEFAULT_SETTINGS = {
  stationName: 'Rádio Tec',
  defaultClockId: null,
  songSeparationMin: 180,   // mesma música não repete antes disso
  artistSeparationMin: 60,  // mesmo artista não repete antes disso
  protectProgramStartMin: 4 // perto de um programa fixo, prefere faixas curtas
};
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...kvGet('settings', {}) };
}
