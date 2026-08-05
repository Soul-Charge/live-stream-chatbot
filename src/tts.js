import { Readable } from 'node:stream';

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

  constructor(store) {
    this.#store = store;
    this.#queue = new TaskQueue(store.get().tts?.concurrency ?? 1);
  }

  setConcurrency(value) {
    this.#queue.setConcurrency(value);
  }

  enqueue(text, role) {
    return this.#queue.push(() => this.#synthesize(text, role));
  }

  async #synthesize(text, role) {
    const config = this.#store.get();
    const tts = config.tts ?? {};
    const payload = {
      text,
      text_lang: tts.textLang ?? 'zh',
      ref_audio_path: role?.refAudio ?? '',
      prompt_text: role?.refText ?? '',
      prompt_lang: tts.promptLang ?? 'zh',
      text_split_method: tts.textSplitMethod ?? 'cut0',
      batch_size: tts.batchSize ?? 1,
      media_type: tts.mediaType ?? 'wav',
      streaming_mode: tts.streamingMode ?? true,
      ...(tts.params ?? {}),
      ...(role?.params ?? {}),
    };
    if (role?.model) payload.model = role.model;

    const baseUrl = String(tts.baseUrl ?? 'http://127.0.0.1:9880').replace(/\/+$/, '');
    const endpoint = String(tts.endpoint ?? '/tts');
    const url = baseUrl + (endpoint.startsWith('/') ? endpoint : `/${endpoint}`);

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
      return Readable.fromWeb(response.body);
    } finally {
      clearTimeout(timer);
    }
  }
}
