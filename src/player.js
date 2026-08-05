import { spawn } from 'node:child_process';

export class PlayerQueue {
  #getConfig;
  #onError;
  #tail = Promise.resolve();
  #current = null;

  constructor(getConfig, onError = () => {}) {
    this.#getConfig = getConfig;
    this.#onError = onError;
  }

  get busy() {
    return this.#current !== null;
  }

  enqueue(stream) {
    stream.on('error', () => {});
    const run = this.#tail.then(() => this.#play(stream));
    this.#tail = run.catch(() => {});
    return run;
  }

  #play(stream) {
    return new Promise((resolve) => {
      const cfg = this.#getConfig() ?? {};
      const command = cfg.command;
      if (!command) {
        this.#onError(new Error('播放器命令未配置'));
        resolve();
        return;
      }

      let child;
      try {
        child = spawn(command, Array.isArray(cfg.args) ? cfg.args : [], {
          stdio: ['pipe', 'ignore', 'pipe'],
        });
      } catch (err) {
        this.#onError(err);
        resolve();
        return;
      }
      this.#current = child;

      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        this.#current = null;
        try {
          stream.destroy();
        } catch {
          // 忽略销毁已结束流的异常
        }
        if (err) this.#onError(err);
        resolve();
      };

      child.on('error', (err) => settle(err));
      child.on('exit', (code, signal) => {
        if (code !== 0) {
          this.#onError(new Error(`播放器退出: code=${code}, signal=${signal ?? ''}`));
        }
        settle();
      });
      child.stdin?.on('error', () => {});
      stream.on('error', (err) => {
        child.kill();
        settle(err);
      });

      stream.pipe(child.stdin);
    });
  }

  close() {
    this.#current?.kill();
    this.#current = null;
  }
}
