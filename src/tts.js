import { Readable } from 'node:stream';
import { setTtsWeights } from './api.js';

const JAPANESE_RE = /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/;

function hasJapanese(text) {
  return JAPANESE_RE.test(String(text ?? ''));
}

function applyZhReplacements(text, textConfig) {
  let result = String(text ?? '');
  for (const [from, to] of Object.entries(textConfig?.zhReplacements ?? {})) {
    if (from) result = result.split(from).join(String(to));
  }
  return result;
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

  constructor(store, log = () => {}) {
    this.#store = store;
    this.#log = log;
    const config = store.get();
    this.#queue = new TaskQueue(effectiveConcurrency(config));
    this.#loadedModelKey = modelKeyOf(config.roles?.default?.params);
  }

  setConcurrency(value) {
    this.#queue.setConcurrency(effectiveConcurrency(this.#store.get()));
  }

  enqueue(text, role) {
    return this.#queue.push(() => this.#synthesize(text, role));
  }

  async #synthesize(text, role) {
    const config = this.#store.get();
    const tts = config.tts ?? {};
    const baseUrl = String(tts.baseUrl ?? 'http://127.0.0.1:9880').replace(/\/+$/, '');
    const endpoint = String(tts.endpoint ?? '/tts');
    const url = baseUrl + (endpoint.startsWith('/') ? endpoint : `/${endpoint}`);
    const textLang = String(tts.textLang ?? 'auto').toLowerCase();
    const isChineseMode = textLang === 'zh' || (textLang === 'auto' && !hasJapanese(text));
    const speechText = isChineseMode ? applyZhReplacements(text, config.text) : text;

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

    const payload = {
      text: speechText,
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
    const timer = setTimeout(() => controller.abort(), Number(tts.requestTimeoutMs) || 30000);
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
      const audio = Buffer.from(await response.arrayBuffer());
      return Readable.from(audio);
    } finally {
      clearTimeout(timer);
    }
  }
}
