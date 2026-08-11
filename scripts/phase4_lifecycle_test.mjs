/**
 * 阶段 4：角色生命周期验证。
 *
 * 流程：
 * 1. 以子进程启动 Genie 服务器（start_genie_server.py），收集其输出。
 * 2. 用 TTSEngine.preloadAll() 预加载全部角色。
 * 3. 调用 TTSEngine.shutdown()，确认服务端收到
 *    /unload_character（每个角色）、/clear_reference_audio_cache、/stop。
 * 4. 结束后杀掉服务器子进程。
 *
 * 用法：
 *     node scripts/phase4_lifecycle_test.mjs
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { ConfigStore } from '../src/config.js';
import { TTSEngine } from '../src/tts.js';

const ROOT = resolve(import.meta.dirname, '..');
const BASE_URL = 'http://127.0.0.1:8000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const res = await fetch(`${BASE_URL}/openapi.json`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log(`[wait] 第 ${attempt} 次探测 -> 200`);
        return true;
      }
    } catch {
      // 未就绪
    }
    if (attempt % 3 === 0) console.log(`[wait] 第 ${attempt} 次探测，仍未就绪...`);
    await sleep(2000);
  }
  return false;
}

function startServer() {
  const child = spawn(
    resolve(ROOT, '.venv-genie', 'Scripts', 'python.exe'),
    [resolve(ROOT, 'scripts', 'start_genie_server.py')],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const lines = [];
  const collect = (stream, name) => {
    stream.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          lines.push(`${name}: ${line}`);
          console.log(`[genie] ${line}`);
        }
      }
    });
  };
  collect(child.stdout, 'OUT');
  collect(child.stderr, 'ERR');
  return { child, lines };
}

async function main() {
  const { child, lines } = startServer();
  try {
    if (!(await waitForServer())) {
      console.log('❌ Genie 服务器启动超时');
      process.exitCode = 1;
      return;
    }
    console.log('✅ Genie 服务器就绪');

    const store = new ConfigStore(resolve(ROOT, 'config', 'config.json'));
    const engine = new TTSEngine(store, (level, msg) => console.log(`[engine] ${msg}`));

    console.log('--- 预加载 ---');
    const results = await engine.preloadAll();
    console.log('预加载结果:', JSON.stringify(results));
    const okCount = results.filter((r) => r.ok).length;
    console.log(`预加载成功 ${okCount}/${results.length}`);

    console.log('--- shutdown ---');
    await engine.shutdown();
    console.log('shutdown 完成');

    await sleep(1000);
    const joined = lines.join('\n');
    const unloadCount = (joined.match(/POST \/unload_character HTTP\/1.1" 200/g) ?? []).length;
    const cleared = /POST \/clear_reference_audio_cache HTTP\/1.1" 200/.test(joined);
    const stopped = /POST \/stop HTTP\/1.1" 200/.test(joined);
    console.log(`服务端 /unload_character 200 次数: ${unloadCount}`);
    console.log(`服务端 /clear_reference_audio_cache 200: ${cleared}`);
    console.log(`服务端 /stop 200: ${stopped}`);

    const failed = (joined.match(/Failed to load ONNX model/g) ?? []).length;
    const keyErrors = (joined.match(/KeyError/g) ?? []).length;
    console.log(`加载失败行: ${failed} | KeyError: ${keyErrors}`);

    const pass = okCount === results.length && unloadCount === results.length && cleared && stopped && keyErrors === 0;
    console.log(pass ? '✅ 阶段 4 生命周期验证通过' : '❌ 验证未通过');
    process.exitCode = pass ? 0 : 1;
  } finally {
    child.kill();
  }
}

main();
