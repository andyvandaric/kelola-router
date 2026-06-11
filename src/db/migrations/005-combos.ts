/**
 * Migration 005 — combo/fallback chains.
 *
 * A combo groups multiple model names into an ordered fallback list.
 * When a request targets a combo name, the proxy tries each model in
 * sequence until one succeeds or all are exhausted (429/lock → next).
 */
export const migration_005 = {
  id: 5,
  name: 'combos',
  sql: `
    CREATE TABLE IF NOT EXISTS combos (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      models     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_combos_name ON combos(name);
  `,
};
