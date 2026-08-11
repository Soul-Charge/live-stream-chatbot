/**
 * 阶段 5：播放器单元测试。
 *
 * 用 2 秒静音裸 PCM（32000 Hz / 单声道 / 16bit）直接喂给 PlayerQueue，
 * 验证 ffplay 以裸 PCM 参数能正常播放并退出（不卡住、不报错）。
 *
 * 用法：
 *     node scripts/phase5_player_test.mjs
 */

import { Readable } from 'node:stream';
import { resolve } from 'node:path';

import { ConfigStore } from '../src/config.js';
import { PlayerQueue } from '../src/player.js';

const ROOT = resolve(import.meta.dirname, '..');
const store = new ConfigStore(resolve(ROOT, 'config', 'config.json'));

console.log('player args:', JSON.stringify(store.get().player.args));

const errors = [];
const player = new PlayerQueue(() => store.get().player, (err) => errors.push(err.message));
const pcm = Buffer.alloc(32000 * 2 * 2); // 2 秒静音

const t0 = Date.now();
await player.enqueue(Readable.from([pcm]));
const elapsed = Date.now() - t0;

console.log(`播放完成，耗时 ${elapsed} ms`);
console.log(`播放器错误数: ${errors.length}`);
if (errors.length > 0) {
  console.log('错误详情:', errors.join(' | '));
  process.exitCode = 1;
} else if (elapsed > 10000) {
  console.log('❌ 播放超过 10 秒，疑似卡住');
  process.exitCode = 1;
} else {
  console.log('✅ 播放器裸 PCM 参数验证通过');
}
