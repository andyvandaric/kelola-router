import type Database from 'better-sqlite3';
import { ulid } from 'ulid';

export interface Combo {
  id: string;
  name: string;
  models: string[];
  created_at: string;
  updated_at: string;
}

interface ComboRow {
  id: string;
  name: string;
  models: string;
  created_at: string;
  updated_at: string;
}

function rowToCombo(row: ComboRow): Combo {
  return {
    id: row.id,
    name: row.name,
    models: JSON.parse(row.models) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listCombos(db: Database.Database): Combo[] {
  const rows = db
    .prepare(`SELECT * FROM combos ORDER BY created_at`)
    .all() as ComboRow[];
  return rows.map(rowToCombo);
}

export function getCombo(db: Database.Database, name: string): Combo | null {
  const row = db
    .prepare(`SELECT * FROM combos WHERE name = ?`)
    .get(name) as ComboRow | undefined;
  return row ? rowToCombo(row) : null;
}

export function getComboById(db: Database.Database, id: string): Combo | null {
  const row = db
    .prepare(`SELECT * FROM combos WHERE id = ?`)
    .get(id) as ComboRow | undefined;
  return row ? rowToCombo(row) : null;
}

export function createCombo(db: Database.Database, name: string, models: string[]): Combo {
  const id = `combo_${ulid()}`;
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  db.prepare(`
    INSERT INTO combos (id, name, models, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, JSON.stringify(models), now, now);
  const row = getComboById(db, id);
  if (!row) throw new Error('createCombo: row missing post-insert');
  return row;
}

export function updateCombo(
  db: Database.Database,
  id: string,
  updates: { name?: string; models?: string[] }
): Combo {
  const existing = getComboById(db, id);
  if (!existing) throw new Error(`combo not found: ${id}`);
  const newName = updates.name ?? existing.name;
  const newModels = updates.models ?? existing.models;
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  db.prepare(`
    UPDATE combos SET name = ?, models = ?, updated_at = ? WHERE id = ?
  `).run(newName, JSON.stringify(newModels), now, id);
  const row = getComboById(db, id);
  if (!row) throw new Error('updateCombo: row missing post-update');
  return row;
}

export function deleteCombo(db: Database.Database, id: string): boolean {
  const r = db.prepare(`DELETE FROM combos WHERE id = ?`).run(id);
  return r.changes > 0;
}
