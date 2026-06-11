import type Database from 'better-sqlite3';
import { migration_001 } from './001-initial.js';
import { migration_002 } from './002-kiro.js';
import { migration_003 } from './003-transports.js';
import { migration_004 } from './004-reqid.js';
import { migration_005 } from './005-combos.js';

const ALL_MIGRATIONS: Array<{ id: number; name: string; sql: string }> = [
  migration_001,
  migration_002,
  migration_003,
  migration_004,
  migration_005,
];

export function migrate(db: Database.Database): void {
  const current = Number(db.pragma('user_version', { simple: true }));
  for (const m of ALL_MIGRATIONS) {
    if (m.id <= current) continue;
    try {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.id}`);
      console.log(`[db] applied migration ${m.id}: ${m.name}`);
    } catch (e: unknown) {
      console.error(`[db] migration ${m.id} failed:`, (e as Error).message);
      console.error('[db] path:', process.env.ROUTER_DB_PATH);
      throw e;
    }
  }
}
