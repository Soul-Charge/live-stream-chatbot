import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_BASE_URL = 'http://127.0.0.1:9880';

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function normalizeTtsBaseUrl(baseUrl) {
  return normalizeBaseUrl(baseUrl);
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

function openApiLogFiles() {
  const logsDir = resolve('logs');
  try {
    mkdirSync(logsDir, { recursive: true });
    return {
      outPath: join(logsDir, 'gpt-sovits-api.out.log'),
      errPath: join(logsDir, 'gpt-sovits-api.err.log'),
      outFd: openSync(join(logsDir, 'gpt-sovits-api.out.log'), 'a'),
      errFd: openSync(join(logsDir, 'gpt-sovits-api.err.log'), 'a'),
    };
  } catch (err) {
    console.error(`[api] 打开推理 API 日志失败，将丢弃子进程输出: ${err.message}`);
    return null;
  }
}

function ttsEndpoint(tts) {
  const baseUrl = String(tts?.baseUrl ?? DEFAULT_BASE_URL);
  try {
    const url = new URL(baseUrl);
    return {
      host: url.hostname || '127.0.0.1',
      port: url.port ? String(url.port) : url.protocol === 'https:' ? '443' : '80',
    };
  } catch {
    return { host: '127.0.0.1', port: '9880' };
  }
}

function startTtsApi(gptSoVits, tts, log) {
  const script = resolve(gptSoVits.path, gptSoVits.startScript || 'API.bat');
  log('info', `推理 API 未启动，正在启动: ${script}`);

  const extraEnv =
    gptSoVits.env && typeof gptSoVits.env === 'object' && !Array.isArray(gptSoVits.env)
      ? gptSoVits.env
      : {};

  const logFiles = openApiLogFiles();
  if (logFiles) {
    log('info', `推理 API 输出将写入: ${logFiles.outPath} / ${logFiles.errPath}`);
  }

  const env = { ...process.env, ...extraEnv };
  // 本机 torch 2.0.0 不认识 expandable_segments；除非用户在 gptSoVits.env 显式设置，
  // 否则强制移除继承到的该变量，避免 API 启动即崩。
  if (!Object.prototype.hasOwnProperty.call(extraEnv, 'PYTORCH_CUDA_ALLOC_CONF')) {
    delete env.PYTORCH_CUDA_ALLOC_CONF;
  }

  const python = resolve(gptSoVits.path, 'runtime', 'python.exe');
  let child;
  if (existsSync(python)) {
    const endpoint = ttsEndpoint(tts);
    // 直接启动 python 并加 -u：避免 API.bat 的 pause，且 stdout/stderr 立即落盘，
    // 冷启动慢或加载失败时日志里能马上看到进度。
    log('info', `使用内嵌 Python 直接启动推理 API: ${python}`);
    child = spawn(
      python,
      ['-u', 'api_v2.py', '-a', endpoint.host, '-p', endpoint.port, '-c', 'GPT_SoVITS/configs/tts_infer.yaml'],
      {
        cwd: gptSoVits.path,
        detached: true,
        stdio: logFiles ? ['ignore', logFiles.outFd, logFiles.errFd] : 'ignore',
        windowsHide: true,
        env,
      },
    );
  } else {
    child = spawn(`"${script}"`, [], {
      cwd: gptSoVits.path,
      shell: true,
      detached: true,
      stdio: logFiles ? ['ignore', logFiles.outFd, logFiles.errFd] : 'ignore',
      windowsHide: true,
      env,
    });
  }

  let logsClosed = false;
  const closeLogs = () => {
    if (logsClosed || !logFiles) return;
    logsClosed = true;
    try { closeSync(logFiles.outFd); } catch {}
    try { closeSync(logFiles.errFd); } catch {}
  };

  const readLogTail = (path, lines = 20) => {
    try {
      return readFileSync(path, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
    } catch {
      return '';
    }
  };

  child.logFiles = logFiles;
  child.on('error', (err) => {
    log('error', `推理 API 启动失败: ${err.message}`);
    closeLogs();
  });
  child.on('exit', (code) => {
    closeLogs();
    if (code && code !== 0 && logFiles) {
      const tail = readLogTail(logFiles.errPath);
      log('warn', `推理 API 进程提前退出，code=${code}${tail ? `\n--- API stderr tail ---\n${tail}` : ''}`);
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
    return { started: false, running: true, pid: null };
  }

  if (!gptSoVits.path || gptSoVits.autoStart === false) {
    log('warn', `推理 API 未运行: ${baseUrl}（未启用自动启动）`);
    return { started: false, running: false, pid: null };
  }

  const child = startTtsApi(gptSoVits, tts, log);

  const timeoutMs = Number(gptSoVits.startupTimeoutMs) || 180000;
  const pollIntervalMs = Number(gptSoVits.pollIntervalMs) || 2000;
  const deadline = Date.now() + timeoutMs;
  log('info', `等待推理 API 就绪，最长 ${timeoutMs}ms ...`);

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if (await isTtsApiUp(baseUrl)) {
      log('info', `推理 API 已就绪: ${baseUrl}`);
      return { started: true, running: true, pid: child.pid ?? null };
    }
  }

  let timeoutTail = '';
  if (child.logFiles) {
    try {
      timeoutTail = readFileSync(child.logFiles.errPath, 'utf8').split(/\r?\n/).slice(-20).join('\n');
    } catch {}
  }
  log('error', `等待推理 API 启动超时（${timeoutMs}ms）${timeoutTail ? `\n--- API stderr tail ---\n${timeoutTail}` : ''}`);
  return { started: true, running: false, pid: child.pid ?? null };
}
