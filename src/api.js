import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
const DEFAULT_START_SCRIPT = 'scripts/start_genie_server.py';

// 中间件自己拉起的 Genie 子进程；用户手动开的进程不受管理。
let spawnedChild = null;
let pendingEnsure = null;

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export async function isTtsApiUp(baseUrl, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 3000);
  try {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/openapi.json`, {
      method: 'GET',
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startTtsApi(genie, log) {
  const root = resolve(import.meta.dirname, '..');
  const python = resolve(root, '.venv-genie', 'Scripts', 'python.exe');
  const script = resolve(root, genie.startScript || DEFAULT_START_SCRIPT);
  const logsDir = resolve(root, 'logs');
  mkdirSync(logsDir, { recursive: true });

  const outFd = openSync(resolve(logsDir, 'genie_auto.out.log'), 'a');
  const errFd = openSync(resolve(logsDir, 'genie_auto.err.log'), 'a');
  let fdsClosed = false;
  const closeFds = () => {
    if (fdsClosed) return;
    fdsClosed = true;
    try {
      closeSync(outFd);
      closeSync(errFd);
    } catch {
      // 忽略关闭已失效描述符的异常
    }
  };

  log('info', `Genie 未运行，自动启动: ${python} ${script}`);
  const child = spawn(python, [script], {
    cwd: root,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  });
  spawnedChild = child;

  child.on('error', (err) => {
    closeFds();
    if (spawnedChild === child) spawnedChild = null;
    log('error', `Genie 自动启动失败: ${err.message}`);
  });
  child.on('exit', (code) => {
    closeFds();
    if (spawnedChild === child) spawnedChild = null;
    if (code && code !== 0) {
      log('warn', `Genie 自动启动进程提前退出，code=${code}`);
    }
  });
  return child;
}

async function doEnsureTtsApi(config, log, { quiet = false } = {}) {
  const tts = config.tts ?? {};
  const genie = config.genie ?? {};
  const baseUrl = normalizeBaseUrl(tts.baseUrl);

  if (await isTtsApiUp(baseUrl)) {
    if (!quiet) log('info', `推理 API 已就绪: ${baseUrl}`);
    return { started: false, running: true, child: null };
  }

  if (genie.autoStart === false) {
    if (!quiet) log('warn', `推理 API 未运行: ${baseUrl}（autoStart=false，不自动拉起）`);
    return { started: false, running: false, child: null };
  }

  let child = spawnedChild && spawnedChild.exitCode === null ? spawnedChild : null;
  if (!child) {
    child = startTtsApi(genie, log);
  }

  const timeoutMs = Number(genie.startupTimeoutMs) || 180000;
  const pollIntervalMs = Number(genie.pollIntervalMs) || 2000;
  const deadline = Date.now() + timeoutMs;
  if (!quiet) log('info', `等待推理 API 就绪，最长 ${timeoutMs}ms ...`);

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if (await isTtsApiUp(baseUrl)) {
      if (!quiet) log('info', `推理 API 已就绪: ${baseUrl}`);
      return { started: true, running: true, child };
    }
    if (child.exitCode !== null) break;
  }

  if (!quiet) log('error', `等待推理 API 启动超时（${timeoutMs}ms）`);
  return { started: true, running: false, child };
}

export async function ensureTtsApi(config, log, options = {}) {
  if (pendingEnsure) return pendingEnsure;
  pendingEnsure = doEnsureTtsApi(config, log, options).finally(() => {
    pendingEnsure = null;
  });
  return pendingEnsure;
}

/**
 * 运行中守护：按 genie.pollIntervalMs 周期探测，Genie 掉线且 autoStart=true 时
 * 自动重新拉起；恢复后通过 onRestarted(child) 通知调用方重新预加载角色。
 */
export function startTtsApiGuard(getConfig, log, { onRestarted } = {}) {
  let timer = null;
  let ticking = false;
  let stopped = false;
  let lastKnown = null;

  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const config = getConfig();
      const genie = config?.genie ?? {};
      if (genie.autoStart === false) {
        lastKnown = null;
        return;
      }
      if (await isTtsApiUp(normalizeBaseUrl(config.tts?.baseUrl))) {
        lastKnown = true;
        return;
      }
      if (lastKnown !== false) {
        // 本轮只记录掉线，下一轮再拉起，避免把启动初期的探测误判为“恢复”。
        lastKnown = false;
        return;
      }
      const result = await ensureTtsApi(config, log, { quiet: true });
      lastKnown = result.running;
      if (!result.running) return;
      log('info', 'Genie 已恢复，重新预加载角色...');
      try {
        await onRestarted?.(result.child);
      } catch (err) {
        log('error', `恢复后重新预加载失败: ${err.message}`);
      }
    } catch (err) {
      log('error', `Genie 守护检查失败: ${err.message}`);
    } finally {
      ticking = false;
    }
  }

  const pollIntervalMs = Number(getConfig()?.genie?.pollIntervalMs) || 2000;
  timer = setInterval(tick, pollIntervalMs);
  tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
    },
  };
}

export function stopSpawnedTtsApi(log = () => {}) {
  if (spawnedChild && spawnedChild.exitCode === null) {
    log('info', '关闭自动启动的 Genie 进程');
    spawnedChild.kill();
  }
  spawnedChild = null;
}
