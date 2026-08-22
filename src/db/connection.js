import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

export function openDanmakuDatabase(config, log = () => {}) {
  const file = resolve(String(config.path || 'data/danmaku.sqlite3'));
  mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma(`journal_mode = ${config.journalMode === 'delete' ? 'DELETE' : 'WAL'}`);
  db.pragma(`synchronous = ${String(config.synchronous).toUpperCase() === 'FULL' ? 'FULL' : 'NORMAL'}`);
  db.pragma(`busy_timeout = ${Number(config.busyTimeoutMs) || 5000}`);
  db.pragma('foreign_keys = ON');
  log('info', `弹幕数据库已打开: ${file}`);
  return db;
}
