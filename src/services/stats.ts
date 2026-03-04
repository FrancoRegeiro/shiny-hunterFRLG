import { getDb } from '../db';
import { HuntRecord, ShinyFindRecord } from '../types';
import { logger } from '../logger';

export function createHunt(target: string, game: string): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO hunts (target, game, started_at) VALUES (?, ?, ?)
  `).run(target, game, Date.now());
  logger.info(`Created hunt #${result.lastInsertRowid}: ${target} in ${game}`);
  return Number(result.lastInsertRowid);
}

export function updateHuntEncounters(huntId: number, encounters: number): void {
  const db = getDb();
  db.prepare(`UPDATE hunts SET encounters = ? WHERE id = ?`).run(encounters, huntId);
}

export function endHunt(huntId: number, status: 'found' | 'abandoned', encounters: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE hunts SET ended_at = ?, status = ?, encounters = ? WHERE id = ?
  `).run(Date.now(), status, encounters, huntId);
  logger.info(`Hunt #${huntId} ended: ${status} after ${encounters} encounters`);
}

export function recordShinyFind(
  huntId: number,
  pokemon: string,
  encounters: number,
  elapsedSeconds: number,
  screenshotPath: string | null
): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO shiny_finds (hunt_id, pokemon, encounters, elapsed_seconds, screenshot_path, found_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(huntId, pokemon, encounters, elapsedSeconds, screenshotPath, Date.now());
  logger.info(`Recorded shiny find #${result.lastInsertRowid}: ${pokemon} in ${encounters} encounters`);
  return Number(result.lastInsertRowid);
}

export function getActiveHunt(): HuntRecord | null {
  const db = getDb();
  return db.prepare(`SELECT * FROM hunts WHERE status = 'active' ORDER BY id DESC LIMIT 1`).get() as HuntRecord | null;
}

export function getAllHunts(): HuntRecord[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM hunts ORDER BY id DESC`).all() as HuntRecord[];
}

export function getShinyFinds(): ShinyFindRecord[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM shiny_finds ORDER BY id DESC`).all() as ShinyFindRecord[];
}

export function getHuntStats(): {
  totalHunts: number;
  totalEncounters: number;
  totalShinies: number;
  averageEncountersPerShiny: number;
} {
  const db = getDb();
  const hunts = db.prepare(`SELECT COUNT(*) as count, SUM(encounters) as total FROM hunts`).get() as any;
  const shinies = db.prepare(`SELECT COUNT(*) as count FROM shiny_finds`).get() as any;

  return {
    totalHunts: hunts.count || 0,
    totalEncounters: hunts.total || 0,
    totalShinies: shinies.count || 0,
    averageEncountersPerShiny: shinies.count > 0 ? Math.round((hunts.total || 0) / shinies.count) : 0,
  };
}
