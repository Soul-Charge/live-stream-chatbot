import { existsSync, readFileSync, watch } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export const DEFAULT_CONFIG = {
  server: {
    host: '127.0.0.1',
    port: 7788,
    path: '/tts',
    maxBodyBytes: 16 * 1024,
  },
  text: {
    maxTextLength: 200,
    blockedWords: [],
    blockedMode: 'reject',
    replacements: {},
  },
  roles: {
    default: {
      refAudio: '',
      refText: '',
      params: {},
    },
  },
  tts: {
    baseUrl: 'http://127.0.0.1:9880',
    endpoint: '/tts',
    concurrency: 1,
    requestTimeoutMs: 30000,
    textLang: 'zh',
    promptLang: 'zh',
    textSplitMethod: 'cut0',
    batchSize: 1,
    mediaType: 'wav',
    streamingMode: true,
    params: {},
  },
  player: {
    command: 'ffplay',
    args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-i', '-'],
  },
  log: {
    level: 'info',
  },
};

function deepMerge(base, override) {
  const out = { ...base };
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return out;
  }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const baseValue = out[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === 'object' &&
      !Array.isArray(baseValue)
    ) {
      out[key] = deepMerge(baseValue, value);
    } else {
      out[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return out;
}

export class ConfigStore {
  #file;
  #config;
  #watcher = null;
  #listeners = new Set();
  #debounceTimer = null;

  constructor(file) {
    this.#file = resolve(file);
    this.#config = deepMerge(DEFAULT_CONFIG, this.#readFile());
  }

  get file() {
    return this.#file;
  }

  get() {
    return this.#config;
  }

  #readFile() {
    if (!existsSync(this.#file)) return {};
    try {
      return JSON.parse(readFileSync(this.#file, 'utf8'));
    } catch (err) {
      console.error(`[config] 读取配置文件失败: ${err.message}`);
      return {};
    }
  }

  reload() {
    const next = deepMerge(DEFAULT_CONFIG, this.#readFile());
    this.#config = next;
    for (const listener of [...this.#listeners]) {
      try {
        listener(next);
      } catch (err) {
        console.error(`[config] 监听器执行失败: ${err.message}`);
      }
    }
    return next;
  }

  watch() {
    if (this.#watcher) return this;
    const dir = dirname(this.#file);
    const name = basename(this.#file);
    this.#watcher = watch(dir, (_event, filename) => {
      if (filename && basename(String(filename)) !== name) return;
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = setTimeout(() => {
        try {
          this.reload();
        } catch (err) {
          console.error(`[config] 热重载失败: ${err.message}`);
        }
      }, 200);
    });
    this.#watcher.on('error', (err) => {
      console.error(`[config] 文件监听出错: ${err.message}`);
    });
    return this;
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    clearTimeout(this.#debounceTimer);
    this.#watcher?.close();
    this.#watcher = null;
  }
}
