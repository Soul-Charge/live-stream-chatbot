import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { ConfigStore } from './config.js';
import { RequestError, matchRole, parseRequest } from './request.js';
import { TTSEngine, whenSynthesisDone, isCachedSynthesis } from './tts.js';
import { PlayerQueue } from './player.js';
import { ensureTtsApi, setTtsWeights } from './api.js';
import { TtsWatchdog } from './watchdog.js';
import { openDanmakuRepository } from './db/DanmakuRepository.js';
import { handleDanmakuApi } from './db/danmakuApi.js';

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

function tryInsertDanmaku(repo, record, logFn) {
  if (!repo.enabled) return null;
  try {
    return repo.insert(record);
  } catch (err) {
    logFn('warn', `弹幕入库失败: ${err.message}`);
    return null;
  }
}

function tryUpdateTtsStatus(repo, id, update, logFn) {
  if (!repo.enabled || !id) return;
  try {
    repo.updateTtsStatus(id, update);
  } catch (err) {
    logFn('warn', `更新弹幕 TTS 状态失败: ${err.message}`);
  }
}

function buildDanmakuRecord(parsed, roleName, role) {
  return {
    receivedAtMs: Date.now(),
    uid: parsed.uid || null,
    username: parsed.name || '匿名用户',
    rawText: parsed.rawText ?? parsed.text,
    cleanText: parsed.text,
    speechText: parsed.speechText,
    textLen: parsed.speechText.length,
    roleKey: roleName,
    roleComment: role?.comment || null,
    accepted: true,
    ttsStatus: 'accepted',
    cacheKey: `${roleName}\n${parsed.speechText}`,
    metadata: { roleHint: parsed.roleHint || null },
  };
}

function runDanmakuRetention(repo, store, logFn) {
  if (!repo.enabled) return;
  const retentionDays = Number(store.get().database?.retentionDays) || 0;
  if (retentionDays <= 0) return;
  try {
    const deleted = repo.deleteBefore(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    if (deleted > 0) {
      logFn('info', `弹幕数据库保留清理完成，删除 ${deleted} 条过期弹幕`);
    }
  } catch (err) {
    logFn('warn', `弹幕数据库保留清理失败: ${err.message}`);
  }
}

function buildRejectedDanmakuRecord(err) {
  const rawText = err?.rawText ?? '';
  return {
    receivedAtMs: Date.now(),
    uid: err?.uid || null,
    username: err?.username || '未知用户',
    rawText,
    cleanText: '',
    speechText: '',
    textLen: rawText.length,
    roleKey: err?.roleHint || 'default',
    roleComment: null,
    accepted: false,
    rejectReason: err?.message ?? '请求被拒绝',
    ttsStatus: 'skipped',
    metadata: { requestStatus: err?.status ?? null },
  };
}

async function warmupTts(tts, config, logFn) {
  const warmup = config.tts?.warmup;
  if (warmup?.enabled === false) {
    logFn('debug', 'TTS 启动预热已关闭');
    return;
  }

  const role = config.roles?.default;
  const text = String(warmup?.text ?? '测试。').trim();
  if (!role || !text) return;

  const startedAt = Date.now();
  try {
    const stream = await tts.enqueue(text, role, 'default');
    stream.resume();
    await whenSynthesisDone(stream);
    logFn('info', `TTS 预热完成，耗时 ${Date.now() - startedAt}ms`);
  } catch (err) {
    logFn('warn', `TTS 预热失败（首条弹幕可能较慢）: ${err.message}`);
  }
}

async function configureBackend(store, tts, logFn, options = {}) {
  const config = store.get();
  const ttsConfig = config.tts ?? {};
  const defaultParams = config.roles?.default?.params ?? {};
  await setTtsWeights(
    ttsConfig.baseUrl,
    defaultParams.gpt_path,
    defaultParams.sovits_path,
    Number(config.gptSoVits?.startupTimeoutMs) || 180000,
    logFn,
  );
  tts.resetLoadedModelKey();
  if (options.warmup !== false) {
    await warmupTts(tts, config, logFn);
  }
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
  const danmakuDb = openDanmakuRepository(store.get(), log);
  const watchdog = new TtsWatchdog(store, log, {
    onBeforeRestart: () => {
      tts.invalidateLoadedModelKey();
      tts.pauseForBackendRestart();
    },
    // 队列暂停期间只恢复默认模型；预热必须等队列恢复后走 TTSEngine，避免自等待。
    onRestarted: () => configureBackend(store, tts, log, { warmup: false }),
    onAfterRestart: async () => {
      tts.resumeAfterBackendRestart();
      await warmupTts(tts, store.get(), log);
    },
  });

  store.onChange((config) => {
    logLevel = config.log?.level ?? 'info';
    tts.setConcurrency(config.tts?.concurrency ?? 1);
    tts.clearCache();
    if (config.gptSoVits?.watchdog?.enabled === false) {
      watchdog.stop();
    } else {
      watchdog.start();
    }
    log('info', '配置已热重载');
  });
  store.watch();

  await ensureTtsApi(store.get(), log);
  await configureBackend(store, tts, log);

  const server = createServer(async (req, res) => {
    const config = store.get();
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        configFile: store.file,
        listening: `${config.server.host}:${config.server.port}${config.server.path}`,
        database: danmakuDb.getStats(),
      });
      return;
    }

    if (pathname.startsWith('/db/')) {
      await handleDanmakuApi(req, res, pathname, config, danmakuDb, log);
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

      // 先返回 202，数据库写入与 TTS 入队均不阻塞弹幕姬。
      sendJson(res, 202, { ok: true, message: '已加入播报队列', role: roleName });

      const record = buildDanmakuRecord(parsed, roleName, role);
      const danmakuId = tryInsertDanmaku(danmakuDb, record, log);
      tryUpdateTtsStatus(danmakuDb, danmakuId, {
        status: 'queued',
        cacheKey: record.cacheKey,
      }, log);

      tts
        .enqueue(parsed.speechText, role, roleName)
        .then((stream) => {
          const cacheHit = isCachedSynthesis(stream);
          tryUpdateTtsStatus(danmakuDb, danmakuId, {
            status: cacheHit ? 'cache_hit' : 'synthesizing',
            cacheKey: record.cacheKey,
            usedCache: cacheHit,
          }, log);
          return player.enqueue(stream).then(() => {
            tryUpdateTtsStatus(danmakuDb, danmakuId, {
              status: 'played',
              usedCache: cacheHit,
            }, log);
          });
        })
        .catch((err) => {
          tryUpdateTtsStatus(danmakuDb, danmakuId, {
            status: 'error',
            error: err.message,
          }, log);
          log('error', `TTS 合成失败: ${err.message}`);
        });
    } catch (err) {
      const status = err instanceof RequestError ? err.status : 500;
      if (status >= 500) log('error', `请求处理失败: ${err.message}`);
      if (!res.headersSent) {
        if (err instanceof RequestError && config.database?.storeRejected !== false) {
          tryInsertDanmaku(danmakuDb, buildRejectedDanmakuRecord(err), log);
        }
        sendJson(res, status, { ok: false, error: err.message });
      } else {
        log('warn', `请求已接受但后续处理异常: ${err.message}`);
      }
    }
  });

  const { host, port, path } = store.get().server;
  server.on('error', (err) => {
    if (err.code === 'EACCES') {
      log('error', `无法监听 ${host}:${port}：${err.message}`);
      log('error', 'Windows 上常见原因是该端口被系统保留（Hyper-V/WSL 排除端口段）。');
      log('error', '请先运行：netsh interface ipv4 show excludedportrange protocol=tcp');
      log('error', '然后在 config/config.json 中把 server.port 改成不在排除段内的端口（例如 8899）。');
    } else {
      log('error', `服务器监听失败: ${err.message}`);
    }
    process.exit(1);
  });
  server.listen(port, host, () => {
    log('info', `弹幕 TTS 中间件已启动: http://${host}:${port}${path}`);
    log('info', `配置文件: ${store.file}（保存后自动热重载）`);
    if (store.file === EXAMPLE_FILE) {
      log('warn', '当前使用示例配置，请复制为 config/config.json 后再修改');
    }
  });

  watchdog.start();

  const retentionTimer = setInterval(() => runDanmakuRetention(danmakuDb, store, log), 6 * 60 * 60 * 1000);
  retentionTimer.unref?.();
  const initialRetention = setTimeout(() => runDanmakuRetention(danmakuDb, store, log), 5000);
  initialRetention.unref?.();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', '正在关闭服务...');
    watchdog.stop();
    clearInterval(retentionTimer);
    clearTimeout(initialRetention);
    server.close();
    store.close();
    danmakuDb.close();
    player.close();
    setTimeout(() => process.exit(0), 300).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log('error', `启动失败: ${err.message}`);
  process.exit(1);
});
