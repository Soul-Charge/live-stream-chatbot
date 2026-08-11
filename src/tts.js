import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_LOAD_TIMEOUT_MS = 180000;
// 平假名 / 片假名 / 片假名扩展：出现即视为日语文本
const JP_CHAR_RE = /[\u3040-\u30ff\u31f0-\u31ff]/;

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * 简单语言分类：弹幕包含日语字符（平假名/片假名）按日语处理，否则按中文处理。
 */
export function detectLanguage(text) {
  return JP_CHAR_RE.test(String(text ?? '')) ? 'jp' : 'zh';
}

/**
 * 角色以 native 语言（role.language，如 jp）加载一次；
 * 合成时按弹幕内容检测 zh/jp，作为每次 /tts 请求的 language 传给 Genie。
 * 参考音频必须以模型 native 语言处理，否则音素序列错误会导致模型
 * 忽略目标文本、直接复读参考音频（阶段 5 阻塞根因）。
 */
export class TaskQueue {
  #tasks = [];
  #active = 0;

  constructor(concurrency = 1) {
    this.concurrency = Math.max(1, Math.floor(Number(concurrency)) || 1);
  }

  get pending() {
    return this.#tasks.length;
  }

  get active() {
    return this.#active;
  }

  setConcurrency(value) {
    this.concurrency = Math.max(1, Math.floor(Number(value)) || 1);
    this.#pump();
  }

  push(task) {
    return new Promise((resolve, reject) => {
      this.#tasks.push({ task, resolve, reject });
      this.#pump();
    });
  }

  async #pump() {
    while (this.#active < this.concurrency && this.#tasks.length > 0) {
      const job = this.#tasks.shift();
      this.#active += 1;
      try {
        job.resolve(await job.task());
      } catch (err) {
        job.reject(err);
      } finally {
        this.#active -= 1;
      }
    }
  }
}

/**
 * Genie-TTS 引擎客户端。
 *
 * 工作流：load_character -> set_reference_audio -> /tts(character_name + text)。
 * - preloadRoles=true 时由中间件启动阶段调用 preloadAll() 全量预加载；
 * - preloadRoles=false 时按需加载，空闲 idleTimeoutMs 后自动 /unload_character。
 * - 每次合成按弹幕内容检测 zh / jp，作为 language 随 /tts 请求发送；
 *   角色本身只以 native 语言加载一次。
 */
export class TTSEngine {
  #store;
  #queue;
  #log;
  #loaded = new Set();
  #idleTimers = new Map();

  constructor(store, log = () => {}) {
    this.#store = store;
    this.#log = log;
    const config = store.get();
    this.#queue = new TaskQueue(Math.max(1, Number(config.tts?.concurrency) || 1));
  }

  setConcurrency(value) {
    this.#queue.setConcurrency(Math.max(1, Math.floor(Number(value)) || 1));
  }

  #config() {
    return this.#store.get();
  }

  #genieConfig() {
    return this.#config().genie ?? {};
  }

  #baseUrl() {
    return normalizeBaseUrl(this.#config().tts?.baseUrl);
  }

  #loadTimeoutMs() {
    const genie = this.#genieConfig();
    return Math.max(Number(genie.startupTimeoutMs) || DEFAULT_LOAD_TIMEOUT_MS, DEFAULT_LOAD_TIMEOUT_MS);
  }

  async #postJson(path, payload, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Genie ${path} 返回 ${response.status}: ${detail.slice(0, 300)}`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async #postJsonWithRetry(path, payload, timeoutMs, attempts = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.#postJson(path, payload, timeoutMs);
      } catch (err) {
        lastErr = err;
        const httpError = /^(Genie |TTS 后端返回)/.test(err.message);
        if (httpError || attempt === attempts) break;
        this.#log('warn', `${path} 请求失败（${err.message}），第 ${attempt}/${attempts} 次重试...`);
        await sleep(1500 * attempt);
      }
    }
    throw lastErr;
  }

  isLoaded(characterName) {
    return this.#loaded.has(characterName);
  }

  async loadCharacter(role) {
    const name = role?.characterName;
    if (!name) throw new Error('角色缺少 characterName');
    if (this.#loaded.has(name)) return;
    if (!role.onnxModelDir) throw new Error(`角色 ${name} 缺少 onnxModelDir`);
    if (!role.refAudio) throw new Error(`角色 ${name} 缺少 refAudio`);

    const language = role.language ?? 'jp';
    const timeout = this.#loadTimeoutMs();

    this.#log('info', `Genie 加载角色: ${name}（${role.comment ?? ''}，native 语言 ${language}）`);
    await this.#postJsonWithRetry('/load_character', {
      character_name: name,
      onnx_model_dir: role.onnxModelDir,
      language,
    }, timeout);
    // 注意：/load_character 即使模型加载失败也返回 200，这里无法直接区分；
    // 若后续 /tts 输出为空，需检查服务端日志或模型目录。

    this.#log('info', `Genie 设置参考音频: ${name}`);
    await this.#postJsonWithRetry('/set_reference_audio', {
      character_name: name,
      audio_path: role.refAudio,
      audio_text: role.refText ?? '',
      language,
    }, timeout);

    this.#loaded.add(name);
  }

  async unloadCharacter(characterName, timeoutMs = 30000) {
    if (!characterName || !this.#loaded.has(characterName)) return;
    this.#clearIdleTimer(characterName);
    try {
      await this.#postJson('/unload_character', { character_name: characterName }, timeoutMs);
      this.#log('info', `Genie 卸载角色: ${characterName}`);
    } finally {
      this.#loaded.delete(characterName);
    }
  }

  async preloadAll() {
    const roles = this.#config().roles ?? {};
    const results = [];
    for (const [key, role] of Object.entries(roles)) {
      try {
        await this.loadCharacter(role);
        results.push({ key, ok: true });
      } catch (err) {
        this.#log('error', `角色 ${key} 预加载失败: ${err.message}`);
        results.push({ key, ok: false });
      }
    }
    return results;
  }

  /**
   * 关闭中间件时的 Genie 清理流程：
   * 1. 逐个 /unload_character 卸载已加载角色
   * 2. /clear_reference_audio_cache 清参考音频缓存
   * 3. /stop 停止合成任务
   */
  async shutdown() {
    const loaded = [...this.#loaded];
    for (const name of loaded) {
      try {
        await this.unloadCharacter(name, 3000);
      } catch (err) {
        this.#log('warn', `角色 ${name} 卸载失败: ${err.message}`);
      }
    }
    for (const [path, payload] of [
      ['/clear_reference_audio_cache', {}],
      ['/stop', {}],
    ]) {
      try {
        await this.#postJson(path, payload, 5000);
        this.#log('info', `Genie ${path} 已执行`);
      } catch (err) {
        this.#log('warn', `Genie ${path} 失败: ${err.message}`);
      }
    }
    this.dispose();
  }

  enqueue(text, role) {
    return this.#queue.push(() => this.#synthesize(text, role));
  }

  async #synthesize(text, role) {
    const config = this.#config();
    const tts = config.tts ?? {};
    const genie = config.genie ?? {};
    const language = detectLanguage(text);
    const name = role?.characterName;
    if (!name) throw new Error('角色缺少 characterName');

    if (genie.preloadRoles === false || !this.#loaded.has(name)) {
      await this.loadCharacter(role);
    }

    const endpoint = String(tts.endpoint ?? '/tts');
    const url = this.#baseUrl() + (endpoint.startsWith('/') ? endpoint : `/${endpoint}`);
    const payload = {
      character_name: name,
      text,
      language,
      split_sentence: tts.params?.split_sentence ?? true,
      ...(tts.params ?? {}),
    };
    this.#log('info', `合成: ${name}（语言 ${language}）`);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Number(tts.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`TTS 后端返回 ${response.status}: ${detail.slice(0, 300)}`);
      }
      if (!response.body) throw new Error('TTS 后端未返回音频流');
      this.#scheduleIdleUnload(name, genie);
      return Readable.fromWeb(response.body);
    } finally {
      clearTimeout(timer);
    }
  }

  #scheduleIdleUnload(characterName, genie) {
    if (genie.preloadRoles !== false) return;
    const idleTimeoutMs = Number(genie.idleTimeoutMs) || 0;
    if (idleTimeoutMs <= 0) return;
    this.#clearIdleTimer(characterName);
    const timer = setTimeout(() => {
      this.unloadCharacter(characterName).catch((err) => {
        this.#log('error', `角色 ${characterName} 空闲卸载失败: ${err.message}`);
      });
    }, idleTimeoutMs);
    this.#idleTimers.set(characterName, timer);
  }

  #clearIdleTimer(characterName) {
    const timer = this.#idleTimers.get(characterName);
    if (timer) {
      clearTimeout(timer);
      this.#idleTimers.delete(characterName);
    }
  }

  dispose() {
    for (const characterName of [...this.#idleTimers.keys()]) {
      this.#clearIdleTimer(characterName);
    }
    this.#loaded.clear();
  }
}
