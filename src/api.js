import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_BASE_URL = 'http://127.0.0.1:9880';

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export async function isTtsApiUp(baseUrl, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 2000);
  try {
    await fetch(`${normalizeBaseUrl(baseUrl)}/`, {
      method: 'GET',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(baseUrl, path, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 30000);
  try {
    const url = `${baseUrl}${path}?${new URLSearchParams(params)}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`${path} 返回 ${response.status}: ${detail.slice(0, 200)}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function setTtsWeights(baseUrl, gptPath, sovitsPath, timeoutMs = 180000, log = () => {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!gptPath || !sovitsPath) return false;

  log('info', `设置推理模型 GPT: ${gptPath}`);
  await requestJson(normalized, '/set_gpt_weights', { weights_path: gptPath }, timeoutMs);
  log('info', `设置推理模型 SoVITS: ${sovitsPath}`);
  await requestJson(normalized, '/set_sovits_weights', { weights_path: sovitsPath }, timeoutMs);
  log('info', '推理模型设置完成');
  return true;
}

function startTtsApi(gptSoVits, log) {
  const script = resolve(gptSoVits.path, gptSoVits.startScript || 'API.bat');
  log('info', `推理 API 未启动，正在启动: ${script}`);

  const child = spawn(`"${script}"`, [], {
    cwd: gptSoVits.path,
    shell: true,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  child.on('error', (err) => {
    log('error', `推理 API 启动失败: ${err.message}`);
  });
  child.on('exit', (code) => {
    if (code && code !== 0) {
      log('warn', `推理 API 进程提前退出，code=${code}`);
    }
  });
  child.unref();
  return child;
}

export async function ensureTtsApi(config, log) {
  const tts = config.tts ?? {};
  const gptSoVits = config.gptSoVits ?? {};
  const baseUrl = normalizeBaseUrl(tts.baseUrl);

  if (await isTtsApiUp(baseUrl)) {
    log('info', `推理 API 已就绪: ${baseUrl}`);
    return { started: false, running: true };
  }

  if (!gptSoVits.path || gptSoVits.autoStart === false) {
    log('warn', `推理 API 未运行: ${baseUrl}（未启用自动启动）`);
    return { started: false, running: false };
  }

  startTtsApi(gptSoVits, log);

  const timeoutMs = Number(gptSoVits.startupTimeoutMs) || 180000;
  const pollIntervalMs = Number(gptSoVits.pollIntervalMs) || 2000;
  const deadline = Date.now() + timeoutMs;
  log('info', `等待推理 API 就绪，最长 ${timeoutMs}ms ...`);

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if (await isTtsApiUp(baseUrl)) {
      log('info', `推理 API 已就绪: ${baseUrl}`);
      return { started: true, running: true };
    }
  }

  log('error', `等待推理 API 启动超时（${timeoutMs}ms）`);
  return { started: true, running: false };
}
