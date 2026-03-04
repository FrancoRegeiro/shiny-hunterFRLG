import Database from 'better-sqlite3';
import path from 'path';
import { config } from './config';
import { logger } from './logger';

let db: Database.Database;

export function initDb(): Database.Database {
  const dbPath = path.resolve(process.cwd(), config.paths.db);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS hunts (
      id INTEGER PRIMARY KEY,
      target TEXT NOT NULL,
      game TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      encounters INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS shiny_finds (
      id INTEGER PRIMARY KEY,
      hunt_id INTEGER REFERENCES hunts(id),
      pokemon TEXT NOT NULL,
      encounters INTEGER NOT NULL,
      elapsed_seconds REAL NOT NULL,
      screenshot_path TEXT,
      found_at INTEGER NOT NULL
    );
  `);

  logger.info(`Database initialized at ${dbPath}`);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}
