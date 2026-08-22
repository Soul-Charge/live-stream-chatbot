import { Readable, PassThrough } from 'node:stream';
import { setTtsWeights } from './api.js';

const SYNTHESIS_DONE = Symbol('ttsSynthesisDone');
const SYNTHESIS_CACHE_HIT = Symbol('ttsSynthesisCacheHit');

// 平假名、片假名、半角片假名与“々”。出现假名时优先交给引擎 auto 做中日切分，
// 否则默认语言即可（中文直播间的弹幕以中文为主，避免短中文片段被 auto 误判为 ja）。
const KANA_RE = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F\u3005]/u;

export function resolveTextLang(text, ttsConfig) {
  const textLang = String(ttsConfig?.textLang ?? 'auto').toLowerCase();
  const whenKana = String(ttsConfig?.textLangWhenKana ?? '').toLowerCase();
  if (whenKana && KANA_RE.test(String(text ?? ''))) {
    return whenKana;
  }
  return textLang;
}

export function whenSynthesisDone(stream) {
  return stream?.[SYNTHESIS_DONE] ?? Promise.resolve();
}

export function isCachedSynthesis(stream) {
  return stream?.[SYNTHESIS_CACHE_HIT] === true;
}

function modelKeyOf(params) {
  const gptPath = params?.gpt_path;
  const sovitsPath = params?.sovits_path;
  return gptPath && sovitsPath ? `${gptPath}\n${sovitsPath}` : null;
}

function hasRoleModels(roles) {
  return Object.values(roles ?? {}).some((role) => modelKeyOf(role?.params));
}

function effectiveConcurrency(config) {
  const configured = Number(config.tts?.concurrency) || 1;
  return hasRoleModels(config.roles) ? 1 : configured;
}

function positiveInt(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function deferred() {
  const out = {};
  out.promise = new Promise((resolve, reject) => {
    out.resolve = resolve;
    out.reject = reject;
    out.settled = false;
  });
  const originalResolve = out.resolve;
  const originalReject = out.reject;
  out.resolve = (value) => {
    if (out.settled) return;
    out.settled = true;
    originalResolve(value);
  };
  out.reject = (err) => {
    if (out.settled) return;
    out.settled = true;
    originalReject(err);
  };
  return out;
}

function waitForDrain(stream) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed) {
      reject(new Error('音频流在合成完成前被关闭'));
      return;
    }
    const cleanup = () => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('音频流在合成完成前被关闭'));
    };
    stream.once('drain', onDrain);
    stream.once('close', onClose);
  });
}

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

export class TTSEngine {
  #store;
  #queue;
  #loadedModelKey;
  #log;
  // A4 过渡内存缓存：默认已关闭（tts.cache.enabled=false），A5 文件缓存稳定后移除。
  #cache = new Map();
  #cacheBytes = 0;
  #cacheGeneration = 0;
  #backendRestarting = false;
  #backendWaiters = new Set();

  constructor(store, log = () => {}) {
    this.#store = store;
    this.#log = log;
    const config = store.get();
    this.#queue = new TaskQueue(effectiveConcurrency(config));
    this.#loadedModelKey = modelKeyOf(config.roles?.default?.params);
  }

  get loadedModelKey() {
    return this.#loadedModelKey;
  }

  setConcurrency(_configured) {
    this.#queue.setConcurrency(effectiveConcurrency(this.#store.get()));
  }

  resetLoadedModelKey() {
    this.#loadedModelKey = modelKeyOf(this.#store.get().roles?.default?.params);
  }

  invalidateLoadedModelKey() {
    this.#loadedModelKey = null;
  }

  pauseForBackendRestart() {
    this.#backendRestarting = true;
  }

  resumeAfterBackendRestart() {
    this.#backendRestarting = false;
    for (const resolve of [...this.#backendWaiters]) {
      this.#backendWaiters.delete(resolve);
      resolve();
    }
  }

  async #waitForBackendReady() {
    while (this.#backendRestarting) {
      await new Promise((resolve) => {
        this.#backendWaiters.add(resolve);
      });
    }
  }

  clearCache() {
    this.#cacheGeneration += 1;
    this.#cache.clear();
    this.#cacheBytes = 0;
  }

  enqueue(text, role, roleName = 'default') {
    const ready = deferred();
    const slot = this.#queue.push(async () => {
      // watchdog 重启后端期间不发起新的合成，避免在 set_weights 竞态中拿错模型。
      await this.#waitForBackendReady();
      const handle = await this.#synthesize(text, role, String(roleName || 'default'));
      Object.defineProperty(handle.stream, SYNTHESIS_DONE, {
        value: handle.done,
        enumerable: false,
      });
      ready.resolve(handle.stream);
      await handle.done;
    });

    slot.catch((err) => {
      if (!ready.settled) {
        ready.reject(err);
      } else {
        this.#log('error', `TTS 合成流读取中断: ${err.message}`);
      }
    });

    return ready.promise;
  }

  async #synthesize(text, role, roleName) {
    const config = this.#store.get();
    const tts = config.tts ?? {};
    const baseUrl = String(tts.baseUrl ?? 'http://127.0.0.1:9880').replace(/\/+$/, '');
    const endpoint = String(tts.endpoint ?? '/tts');
    const url = baseUrl + (endpoint.startsWith('/') ? endpoint : `/${endpoint}`);
    const textLang = resolveTextLang(text, tts);

    const roleParams = role?.params ?? {};
    const modelKey = modelKeyOf(roleParams);
    if (modelKey && modelKey !== this.#loadedModelKey) {
      this.#log('info', `切换推理模型: ${roleParams.gpt_path}`);
      await setTtsWeights(
        baseUrl,
        roleParams.gpt_path,
        roleParams.sovits_path,
        Math.max(Number(tts.requestTimeoutMs) || 30000, 180000),
        this.#log,
      );
      this.#loadedModelKey = modelKey;
    }

    // A4 过渡命中路径：A5 落地后改为 tts_audio_cache 表查询 + createReadStream。
    const cacheConfig = tts.cache ?? {};
    const cacheKey =
      cacheConfig.enabled === false ? null : `${roleName}\n${text}`;
    if (cacheKey) {
      const cached = this.#cacheGet(cacheKey);
      if (cached) {
        this.#log('debug', `TTS 缓存命中: ${roleName}`);
        const stream = Readable.from(cached);
        stream.on('error', () => {});
        Object.defineProperty(stream, SYNTHESIS_CACHE_HIT, {
          value: true,
          enumerable: false,
        });
        return { stream, done: Promise.resolve() };
      }
    }

    const payload = {
      text,
      text_lang: textLang,
      ref_audio_path: role?.refAudio ?? '',
      prompt_text: role?.refText ?? '',
      prompt_lang: tts.promptLang ?? 'zh',
      text_split_method: tts.textSplitMethod ?? 'cut0',
      batch_size: tts.batchSize ?? 1,
      media_type: tts.mediaType ?? 'wav',
      streaming_mode: tts.streamingMode ?? true,
      ...(tts.params ?? {}),
      ...roleParams,
    };
    if (role?.model) payload.model = role.model;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Number(tts.requestTimeoutMs) || 30000,
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
        throw new Error(`TTS 后端返回 ${response.status}: ${detail.slice(0, 200)}`);
      }
      if (!response.body) throw new Error('TTS 后端未返回音频流');

      // A2 安全流式：任务 Promise 只等到“源流读完”（服务器生成结束），
      // 但 PassThrough 在拿到响应体后立刻交给播放器，首块音频无需等整段合成完。
      const stream = new PassThrough({
        highWaterMark: positiveInt(tts.streamHighWaterMark, 16 * 1024 * 1024),
      });
      stream.on('error', () => {});
      const source = Readable.fromWeb(response.body);
      const generation = this.#cacheGeneration;
      const done = this.#pumpResponse(source, stream, cacheKey, cacheConfig, generation).finally(
        () => clearTimeout(timer),
      );
      return { stream, done };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async #pumpResponse(source, stream, cacheKey, cacheConfig, generation) {
    const maxEntryBytes = positiveInt(cacheConfig.maxEntryBytes, 4 * 1024 * 1024);
    const chunks = [];
    let cacheBytes = 0;
    let cacheEligible = Boolean(cacheKey);

    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (cacheEligible) {
          if (cacheBytes + buffer.length > maxEntryBytes) {
            cacheEligible = false;
            chunks.length = 0;
          } else {
            chunks.push(buffer);
            cacheBytes += buffer.length;
          }
        }
        if (stream.destroyed) {
          throw new Error('音频流在合成完成前被关闭');
        }
        if (!stream.write(buffer)) {
          await waitForDrain(stream);
        }
      }

      if (cacheEligible && cacheKey && cacheBytes > 0 && generation === this.#cacheGeneration) {
        this.#cacheSet(cacheKey, Buffer.concat(chunks, cacheBytes));
      }
      stream.end();
    } catch (err) {
      stream.destroy(err);
      throw err;
    }
  }

  #cacheGet(key) {
    const entry = this.#cache.get(key);
    if (!entry) return null;
    // Map 按插入序迭代，命中后重新插入即 LRU 置顶。
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    return entry.buffer;
  }

  #cacheSet(key, buffer) {
    const cacheConfig = this.#store.get().tts?.cache ?? {};
    const maxEntryBytes = positiveInt(cacheConfig.maxEntryBytes, 4 * 1024 * 1024);
    if (!key || buffer.length === 0 || buffer.length > maxEntryBytes) return;

    const previous = this.#cache.get(key);
    if (previous) this.#cacheBytes -= previous.size;
    this.#cache.set(key, { buffer, size: buffer.length });
    this.#cacheBytes += buffer.length;

    const maxEntries = positiveInt(cacheConfig.maxEntries, 64);
    const maxBytes = positiveInt(cacheConfig.maxBytes, 32 * 1024 * 1024);
    while (this.#cache.size > maxEntries || this.#cacheBytes > maxBytes) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      const evicted = this.#cache.get(oldest.value);
      this.#cache.delete(oldest.value);
      this.#cacheBytes -= evicted?.size ?? 0;
    }
  }
}
