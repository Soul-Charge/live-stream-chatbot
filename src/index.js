import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { ConfigStore } from './config.js';
import { RequestError, matchRole, parseRequest } from './request.js';
import { TTSEngine } from './tts.js';
import { PlayerQueue } from './player.js';
import { ensureTtsApi } from './api.js';

const CONFIG_FILE = resolve('config', 'config.json');
const EXAMPLE_FILE = resolve('config', 'config.example.json');

let logLevel = 'info';

function log(level, message) {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if (order[level] >= (order[logLevel] ?? 1)) {
    console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`);
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function main() {
  const configFile = existsSync(CONFIG_FILE) ? CONFIG_FILE : EXAMPLE_FILE;
  const store = new ConfigStore(configFile);
  logLevel = store.get().log?.level ?? 'info';

  const player = new PlayerQueue(
    () => store.get().player ?? {},
    (err) => log('error', `播放器错误: ${err.message}`),
  );
  const tts = new TTSEngine(store, log);

  store.onChange((config) => {
    logLevel = config.log?.level ?? 'info';
    tts.setConcurrency(config.tts?.concurrency ?? 1);
    log('info', '配置已热重载');
  });
  store.watch();

  const apiState = await ensureTtsApi(store.get(), log);
  if (!apiState.running) {
    log('warn', '推理后端未确认就绪，预加载将自动重试');
  }

  const genieConfig = store.get().genie ?? {};
  if (genieConfig.preloadRoles !== false) {
    log('info', '开始预加载 Genie 角色（native 语言，合成时按弹幕检测 zh/jp）...');
    const preloadResults = await tts.preloadAll();
    const failed = preloadResults.filter((result) => !result.ok);
    if (failed.length > 0) {
      log(
        'error',
        `角色预加载失败 ${failed.length}/${preloadResults.length}: ${failed.map((item) => item.key).join(', ')}`,
      );
    } else {
      log('info', `角色预加载完成（${preloadResults.length} 个）`);
    }
  }

  const server = createServer(async (req, res) => {
    const config = store.get();
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        configFile: store.file,
        listening: `${config.server.host}:${config.server.port}${config.server.path}`,
      });
      return;
    }

    if (pathname !== config.server.path) {
      sendJson(res, 404, { ok: false, error: 'Not Found' });
      return;
    }

    try {
      const parsed = await parseRequest(req, config);
      const { roleName, role } = matchRole(parsed.text, config.roles, parsed.roleHint);
      log('info', `收到播报: 用户=${parsed.name || '-'} 角色=${roleName} 文本=${parsed.text}`);

      tts
        .enqueue(parsed.speechText, role)
        .then((stream) => player.enqueue(stream))
        .catch((err) => log('error', `TTS 合成失败: ${err.message}`));

      sendJson(res, 202, { ok: true, message: '已加入播报队列', role: roleName });
    } catch (err) {
      const status = err instanceof RequestError ? err.status : 500;
      if (status >= 500) log('error', `请求处理失败: ${err.message}`);
      sendJson(res, status, { ok: false, error: err.message });
    }
  });

  const { host, port, path } = store.get().server;
  server.listen(port, host, () => {
    log('info', `弹幕 TTS 中间件已启动: http://${host}:${port}${path}`);
    log('info', `配置文件: ${store.file}（保存后自动热重载）`);
    if (store.file === EXAMPLE_FILE) {
      log('warn', '当前使用示例配置，请复制为 config/config.json 后再修改');
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', '正在关闭服务...');
    server.close();
    store.close();
    player.close();
    const exitTimer = setTimeout(() => process.exit(0), 15000);
    exitTimer.unref();
    try {
      await tts.shutdown();
    } catch (err) {
      log('error', `Genie 关闭清理失败: ${err.message}`);
    }
    clearTimeout(exitTimer);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log('error', `启动失败: ${err.message}`);
  process.exit(1);
});
