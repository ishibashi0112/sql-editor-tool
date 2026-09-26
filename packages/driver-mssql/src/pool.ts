// 接続のプール。行の取得中でも、候補値の取得やツリーの展開を待たせないよう、接続を何本か使い回す。
// tedious の接続は 1 本で同時に 1 つの要求しか扱えないため

import { abortError } from "@sql-editor-tool/host";

export type PoolOptions<C> = {
  create(): Promise<C>;
  destroy(connection: C): void;
  /** 切断されたなど、もう使えない接続か */
  isBroken(connection: C): boolean;
  /** 同時に開く接続の上限 */
  max: number;
  /** 使われないままこの時間が過ぎた接続は閉じる（ミリ秒） */
  idleMs: number;
};

type Idle<C> = { connection: C; timer: ReturnType<typeof setTimeout> };

export class Pool<C> {
  private readonly idle: Idle<C>[] = [];
  private readonly busy = new Set<C>();
  private creating = 0;
  /** 接続が空くのを待っている取得。空いたかもしれないときに先頭から呼ぶ */
  private readonly waiters: (() => void)[] = [];
  private closed = false;

  constructor(private readonly options: PoolOptions<C>) {}

  /** 接続を借りて fn を実行し、終わったら返す。signal が中断されたら、空きを待つのをやめる */
  async use<T>(
    signal: AbortSignal | undefined,
    fn: (connection: C) => Promise<T>,
  ): Promise<T> {
    const connection = await this.acquire(signal);
    try {
      return await fn(connection);
    } finally {
      this.release(connection);
    }
  }

  /** 接続を 1 本開いて、つながることを確かめる */
  async warmUp(): Promise<void> {
    this.release(await this.acquire(undefined));
  }

  /** 待機中の接続を閉じる。使用中の接続も閉じる（実行中の要求はエラーで終わる） */
  close(): void {
    this.closed = true;
    for (const { connection, timer } of this.idle.splice(0)) {
      clearTimeout(timer);
      this.options.destroy(connection);
    }
    for (const connection of this.busy) this.options.destroy(connection);
    this.busy.clear();
    for (const wake of this.waiters.splice(0)) wake();
  }

  private async acquire(signal: AbortSignal | undefined): Promise<C> {
    for (;;) {
      if (this.closed) throw new Error("接続は閉じられています");
      if (signal?.aborted) throw abortError();
      const idle = this.takeIdle();
      if (idle !== undefined) {
        this.busy.add(idle);
        return idle;
      }
      if (this.size() < this.options.max) {
        this.creating += 1;
        let connection: C;
        try {
          connection = await this.options.create();
        } catch (error) {
          this.wakeOne();
          throw error;
        } finally {
          this.creating -= 1;
        }
        if (this.closed) {
          this.options.destroy(connection);
          continue;
        }
        this.busy.add(connection);
        return connection;
      }
      await this.waitForSlot(signal);
    }
  }

  private release(connection: C): void {
    // close() で閉じた接続
    if (!this.busy.delete(connection)) return;
    if (this.closed || this.options.isBroken(connection)) {
      this.options.destroy(connection);
    } else {
      const timer = setTimeout(() => {
        const index = this.idle.findIndex((e) => e.connection === connection);
        if (index >= 0) this.idle.splice(index, 1);
        this.options.destroy(connection);
      }, this.options.idleMs);
      this.idle.push({ connection, timer });
    }
    this.wakeOne();
  }

  /** 最後に返された接続から使う。切れていたら捨てる */
  private takeIdle(): C | undefined {
    for (let entry = this.idle.pop(); entry; entry = this.idle.pop()) {
      clearTimeout(entry.timer);
      if (!this.options.isBroken(entry.connection)) return entry.connection;
      this.options.destroy(entry.connection);
    }
    return undefined;
  }

  private size(): number {
    return this.idle.length + this.busy.size + this.creating;
  }

  private waitForSlot(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError());
      };
      this.waiters.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private wakeOne(): void {
    this.waiters.shift()?.();
  }
}
