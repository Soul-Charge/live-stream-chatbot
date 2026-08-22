import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

import { ensureTtsApi, isTtsApiUp, normalizeTtsBaseUrl } from './api.js';

const execFileAsync = promisify(execFile);

function positiveInt(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function findTtsApiPid(port) {
  const normalizedPort = positiveInt(port, 9880);

  if (process.platform === 'win32') {
    const script =
      `Get-NetTCPConnection -LocalPort ${normalizedPort} -State Listen -ErrorAction SilentlyContinue | ` +
      'Select-Object -First 1 -ExpandProperty OwningProcess';
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 8000, windowsHide: true, encoding: 'utf8' },
      );
      return parseInteger(stdout);
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync('ss', ['-H', '-tlnp', `sport = :${normalizedPort}`], {
      timeout: 5000,
      encoding: 'utf8',
    });
    const match = stdout.match(/pid=(\d+)/);
    if (match) return parseInteger(match[1]);
  } catch {
    // fallthrough to netstat
  }

  try {
    const { stdout } = await execFileAsync('netstat', ['-tlnp'], {
      timeout: 5000,
      encoding: 'utf8',
    });
    const line = stdout.split(/\r?\n/).find((item) => item.includes(`:${normalizedPort}`));
    const match = line?.match(/(\d+)\/\S+\s*$/);
    if (match) return parseInteger(match[1]);
  } catch {
    return null;
  }

  return null;
}

export async function getPrivateMemoryMB(pid) {
  const normalizedPid = positiveInt(pid, 0);
  if (!normalizedPid) return null;

  if (process.platform === 'win32') {
    const script =
      `(Get-Process -Id ${normalizedPid} -ErrorAction Stop).PrivateMemorySize64`;
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 8000, windowsHide: true, encoding: 'utf8' },
      );
      const bytes = parseInteger(stdout);
      return bytes === null ? null : Math.round((bytes / 1048576) * 10) / 10;
    } catch {
      return null;
    }
  }

  try {
    const status = readFileSync(`/proc/${normalizedPid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    if (match) return Math.round((Number(match[1]) / 1024) * 10) / 10;
  } catch {
    return null;
  }

  return null;
}

function ttsPort(baseUrl) {
  try {
    return Number(new URL(baseUrl ?? 'http://127.0.0.1:9880').port) || 80;
  } catch {
    return 9880;
  }
}

async function waitForPortDown(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isTtsApiUp(baseUrl, 1000))) return true;
    await sleep(1000);
  }
  return !(await isTtsApiUp(baseUrl, 1000));
}

export class TtsWatchdog {
  #store;
  #log;
  #onBeforeRestart;
  #onRestarted;
  #onAfterRestart;
  #timer = null;
  #checking = false;
  #lastRestartAt = 0;

  constructor(store, log = () => {}, callbacks = {}) {
    this.#store = store;
    this.#log = log;
    this.#onBeforeRestart = callbacks.onBeforeRestart ?? (() => {});
    this.#onRestarted = callbacks.onRestarted ?? (async () => {});
    this.#onAfterRestart = callbacks.onAfterRestart ?? (() => {});
  }

  start() {
    if (this.#timer) return;
    if (this.#store.get().gptSoVits?.watchdog?.enabled === false) return;
    this.#schedule();
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule() {
    if (this.#timer) clearTimeout(this.#timer);
    const intervalMs = positiveInt(
      this.#store.get().gptSoVits?.watchdog?.intervalMs,
      30000,
    );
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#check();
    }, intervalMs);
    this.#timer.unref?.();
  }

  async #check() {
    if (this.#checking) return;
    this.#checking = true;
    try {
      const config = this.#store.get();
      const watchdog = config.gptSoVits?.watchdog ?? {};
      if (watchdog.enabled === false) return;

      const cooldownMs = positiveInt(watchdog.restartCooldownMs, 120000);
      if (Date.now() - this.#lastRestartAt < cooldownMs) {
        this.#log('debug', `推理 API watchdog 冷却中，跳过本轮检查`);
        return;
      }

      const baseUrl = normalizeTtsBaseUrl(config.tts?.baseUrl);
      const pid = await findTtsApiPid(ttsPort(baseUrl));
      if (!pid) {
        this.#log('debug', 'watchdog 未能定位推理 API 进程，跳过内存检查');
        return;
      }

      const privateMB = await getPrivateMemoryMB(pid);
      if (privateMB === null) {
        this.#log('debug', `watchdog 无法读取推理 API 进程 ${pid} 的内存`);
        return;
      }

      const thresholdMB = positiveInt(watchdog.maxPrivateMemoryMB, 8192);
      this.#log('debug', `推理 API 私有内存: ${privateMB}MB / 阈值 ${thresholdMB}MB`);
      if (privateMB > thresholdMB) {
        await this.#restart(baseUrl);
      }
    } catch (err) {
      this.#log('warn', `推理 API watchdog 检查失败: ${err.message}`);
    } finally {
      this.#checking = false;
      this.#schedule();
    }
  }

  async #restart(baseUrl) {
    const config = this.#store.get();
    this.#lastRestartAt = Date.now();
    this.#log('warn', `推理 API 内存超阈值，正在重启后端...`);

    try {
      this.#onBeforeRestart();

      const pid = await findTtsApiPid(ttsPort(baseUrl));
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (err) {
          if (err?.code !== 'ESRCH') {
            this.#log('warn', `结束推理 API 进程 ${pid} 失败: ${err.message}`);
          }
        }
      }

      const stopped = await waitForPortDown(baseUrl, 60000);
      if (!stopped) {
        this.#log('error', '推理 API 未能在 60s 内停止，放弃本次重启');
        return;
      }

      const result = await ensureTtsApi(config, this.#log);
      if (!result.running) {
        this.#log('error', '推理 API 重启失败，请检查 gptSoVits.path 与 startScript 配置');
        return;
      }

      let modelRestored = false;
      try {
        await this.#onRestarted?.(config);
        modelRestored = true;
      } catch (err) {
        this.#log('error', `重启后恢复默认模型失败: ${err.message}`);
      }
      if (modelRestored) {
        this.#log('info', '推理 API 已由 watchdog 重启完成');
      } else {
        this.#log('warn', '推理 API 已重启，但默认模型恢复失败，后续切换角色时会重新设置');
      }
    } finally {
      await this.#onAfterRestart();
    }
  }
}
