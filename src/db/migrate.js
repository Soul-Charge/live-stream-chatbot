import { MIGRATIONS } from './schema.js';

export function migrateDanmakuDatabase(db, log = () => {}) {
  const current = Number(db.pragma('user_version', { simple: true })) || 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    db.transaction(() => {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.exec(`PRAGMA user_version = ${migration.version}`);
    })();
    log('info', `弹幕数据库已迁移到 v${migration.version}`);
  }

  return Number(db.pragma('user_version', { simple: true })) || 0;
}
