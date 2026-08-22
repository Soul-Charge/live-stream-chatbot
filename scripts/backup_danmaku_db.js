import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const configPath = resolve(process.argv[2] || 'config/config.json');
if (!existsSync(configPath)) {
  console.error(`配置文件不存在: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (config.database?.enabled === false) {
  console.log('弹幕数据库未启用，跳过备份');
  process.exit(0);
}

const source = resolve(config.database?.path || 'data/danmaku.sqlite3');
if (!existsSync(source)) {
  console.log(`弹幕数据库文件不存在，跳过备份: ${source}`);
  process.exit(0);
}

const backupDir = join(dirname(source), 'backup');
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = join(backupDir, `danmaku-${stamp}.sqlite3`);

const db = new Database(source, { readonly: true });
try {
  await db.backup(destination);
  console.log(`弹幕数据库已备份: ${destination}`);
} finally {
  db.close();
}
