import { isAbortError } from "@sql-editor-tool/host";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Pool } from "./pool";

type Fake = { id: number; broken: boolean; destroyed: boolean };

function setup(max = 2, idleMs = 1000) {
  let next = 0;
  const created: Fake[] = [];
  let failNext = false;
  const pool = new Pool<Fake>({
    create: async () => {
      if (failNext) {
        failNext = false;
        throw new Error("ログインに失敗しました");
      }
      const fake = { id: ++next, broken: false, destroyed: false };
      created.push(fake);
      return fake;
    },
    destroy: (fake) => {
      fake.destroyed = true;
    },
    isBroken: (fake) => fake.broken,
    max,
    idleMs,
  });
  return { pool, created, failOnce: () => (failNext = true) };
}

/** 外から終わらせられる処理 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Pool", () => {
  test("返された接続を使い回す", async () => {
    const { pool, created } = setup();
    const a = await pool.use(undefined, async (c) => c.id);
    const b = await pool.use(undefined, async (c) => c.id);
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  test("上限まで同時に開き、それを超えたら空くのを待つ", async () => {
    const { pool, created } = setup(2);
    const first = deferred();
    const running = [
      pool.use(undefined, () => first.promise),
      pool.use(undefined, () => first.promise),
    ];
    let thirdStarted = false;
    const third = pool.use(undefined, async (c) => {
      thirdStarted = true;
      return c.id;
    });
    await Promise.resolve();
    expect(created).toHaveLength(2);
    expect(thirdStarted).toBe(false);
    first.resolve();
    await Promise.all(running);
    expect(await third).toBeLessThanOrEqual(2);
    expect(created).toHaveLength(2);
  });

  test("空きを待っている間に中断されたら AbortError", async () => {
    const { pool } = setup(1);
    const hold = deferred();
    const running = pool.use(undefined, () => hold.promise);
    const abort = new AbortController();
    const waiting = pool.use(abort.signal, async () => "実行されない");
    abort.abort();
    await expect(waiting).rejects.toSatisfy(isAbortError);
    hold.resolve();
    await running;
  });

  test("切れた接続は返されたときに捨て、次は新しく開く", async () => {
    const { pool, created } = setup();
    await pool.use(undefined, async (c) => {
      c.broken = true;
    });
    expect(created[0]?.destroyed).toBe(true);
    await pool.use(undefined, async () => {});
    expect(created).toHaveLength(2);
  });

  test("待機中に切れた接続は使わない", async () => {
    const { pool, created } = setup();
    await pool.use(undefined, async () => {});
    const first = created[0];
    if (first) first.broken = true;
    const id = await pool.use(undefined, async (c) => c.id);
    expect(id).toBe(2);
    expect(first?.destroyed).toBe(true);
  });

  test("使われないまま時間が過ぎた接続は閉じる", async () => {
    vi.useFakeTimers();
    const { pool, created } = setup(2, 1000);
    await pool.use(undefined, async () => {});
    vi.advanceTimersByTime(999);
    expect(created[0]?.destroyed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(created[0]?.destroyed).toBe(true);
  });

  test("開けなかったときはエラーを返し、次はまた開こうとする", async () => {
    const { pool, failOnce } = setup(1);
    failOnce();
    await expect(pool.use(undefined, async () => {})).rejects.toThrow(
      "ログインに失敗しました",
    );
    await expect(pool.use(undefined, async (c) => c.id)).resolves.toBe(1);
  });

  test("閉じると使用中・待機中の接続を閉じ、それ以降は使えない", async () => {
    const { pool, created } = setup(2);
    await pool.use(undefined, async () => {});
    const hold = deferred();
    const running = pool.use(undefined, () => hold.promise);
    const busy = pool.use(undefined, () => hold.promise);
    await Promise.resolve();
    pool.close();
    expect(created.every((c) => c.destroyed)).toBe(true);
    hold.resolve();
    await Promise.all([running, busy]);
    await expect(pool.use(undefined, async () => {})).rejects.toThrow(
      "閉じられています",
    );
  });
});
