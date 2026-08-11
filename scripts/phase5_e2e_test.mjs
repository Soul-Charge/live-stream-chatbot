/**
 * 阶段 5：中间件端到端播放验证。
 *
 * 启动 Genie 服务器 + 中间件，触发两个角色的合成，确认：
 * - Genie /tts 200；
 * - ffplay 正常消费裸 PCM 流并退出（不再卡住）；
 * - 中间件无“TTS 合成失败”/播放器错误。
 *
 * 用法：
 *     node scripts/phase5_e2e_test.mjs
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startChild(file, args) {
  const child = spawn(file, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const collect = (stream, name) => {
    stream.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) lines.push(`${name}: ${line}`);
      }
    });
  };
  collect(child.stdout, 'OUT');
  collect(child.stderr, 'ERR');
  return { child, lines };
}

async function waitHttp(url, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log(`[wait] ${label} 第 ${attempt} 次探测 -> 200`);
        return true;
      }
    } catch {
      // 未就绪
    }
    if (attempt % 5 === 0) console.log(`[wait] ${label} 第 ${attempt} 次探测，仍未就绪...`);
    await sleep(2000);
  }
  return false;
}

async function main() {
  const genie = startChild(
    resolve(ROOT, '.venv-genie', 'Scripts', 'python.exe'),
    [resolve(ROOT, 'scripts', 'start_genie_server.py')],
  );
  const middleware = startChild('node', [resolve(ROOT, 'src', 'index.js')]);

  try {
    if (!(await waitHttp('http://127.0.0.1:8000/openapi.json', 'genie', 90000))) {
      console.log('❌ Genie 启动超时');
      process.exitCode = 1;
      return;
    }
    if (!(await waitHttp('http://127.0.0.1:7788/health', 'middleware', 180000))) {
      console.log('❌ 中间件启动/预加载超时');
      process.exitCode = 1;
      return;
    }
    console.log('✅ Genie + 中间件就绪，发送合成请求...');

    const texts = ['樱羽艾玛说你好呀', '二阶堂希罗说こんにちは'];
    for (const text of texts) {
      const res = await fetch(
        `http://127.0.0.1:7788/tts?text=${encodeURIComponent(text)}`,
        { signal: AbortSignal.timeout(15000) },
      );
      console.log(`[req] ${text} -> HTTP ${res.status}`);
    }

    console.log('[wait] 等待合成与播放完成（最多 60 秒）...');
    await sleep(60000);

    const mwLog = middleware.lines.join('\n');
    const genieLog = genie.lines.join('\n');
    const tts200 = (genieLog.match(/POST \/tts HTTP\/1.1" 200/g) ?? []).length;
    const ttsFail = (mwLog.match(/TTS 合成失败/g) ?? []).length;
    const playerErr = (mwLog.match(/播放器错误|播放器退出/g) ?? []).length;
    const preloadIdx = mwLog.indexOf('角色预加载完成');
    const listenIdx = mwLog.indexOf('弹幕 TTS 中间件已启动');
    const preloadBeforeListen = preloadIdx >= 0 && listenIdx >= 0 && preloadIdx < listenIdx;
    console.log(`Genie /tts 200: ${tts200}`);
    console.log(`中间件 TTS 合成失败: ${ttsFail}`);
    console.log(`中间件播放器错误: ${playerErr}`);
    console.log(`预加载完成先于监听: ${preloadBeforeListen}`);
    console.log('--- 中间件日志尾部 ---');
    console.log(middleware.lines.slice(-8).join('\n'));

    const pass = tts200 >= texts.length && ttsFail === 0 && playerErr === 0 && preloadBeforeListen;
    console.log(pass ? '✅ 阶段 5 端到端播放验证通过' : '❌ 验证未通过');
    process.exitCode = pass ? 0 : 1;
  } finally {
    middleware.child.kill();
    genie.child.kill();
  }
}

main();
