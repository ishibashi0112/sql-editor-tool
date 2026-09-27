// 差分カメラ（D-47）の操作：カメラを作る・表を足す・条件を付ける・前を撮る・後を撮って比べる。
// 撮ったもの（前・後）はここに持つ（VS Code を閉じるまで）。VS Code に依存しないので、画面の操作は deps で受け取る

import type { DialectName, TableRef } from "@sql-editor-tool/core";
import {
  type CameraTable,
  compareShots,
  comparisonText,
  type DiffCamera,
  diffView,
  type Shot,
  shoot,
  type TableComparison,
} from "./diffCamera";
import type {
  CameraItem,
  DiffView,
  FromCameraView,
  FromDiffView,
  ToCameraView,
} from "./diffCameraProtocol";
import { type DbSession, isAbortError } from "./session";

export type DiffCameraDeps = {
  load(): DiffCamera[];
  save(cameras: DiffCamera[]): Promise<void>;
  /** 名前の接続を開く（まだ開いていなければ開く） */
  openSession(
    connection: string,
  ): Promise<{ session: DbSession; dialect: DialectName }>;
  /** 主キーのない表のキー（列の設定、D-36） */
  keyColumns?(
    connection: string,
    table: TableRef,
  ): readonly string[] | undefined;
  /** 表の論理名（D-40） */
  logicalName?(connection: string, table: TableRef): string | undefined;
  /** 表ごとの行数の上限 */
  maxRows(): number;

  // 画面の操作（入力を聞く）。やめたら undefined
  askName(current?: string): Promise<string | undefined>;
  chooseConnection(): Promise<string | undefined>;
  pickTables(
    connection: string,
    current: readonly TableRef[],
  ): Promise<TableRef[] | undefined>;
  /** 条件式を聞く。空にしたら ""（条件を外す） */
  askCondition(
    connection: string,
    table: CameraTable,
  ): Promise<string | undefined>;
  confirmDelete(name: string): Promise<boolean>;

  postView(message: ToCameraView): void;
  /** 差分のタブを開く（開いていれば中身を替える） */
  showDiff(cameraId: string, view: DiffView): void;
  /** 差分のタブで「後」を撮り直しているところか */
  diffBusy?(cameraId: string, busy: boolean): void;
  copyText(text: string): Promise<void>;
  showMessage(message: string, kind: "info" | "error"): void;
  log?(message: string): void;
  now?(): number;
  newId?(): string;
};

type Busy = {
  what: "before" | "after";
  done: number;
  total: number;
  abort: AbortController;
};

export class DiffCameraController {
  private cameras: DiffCamera[];
  private readonly befores = new Map<string, Shot>();
  private readonly lasts = new Map<
    string,
    { after: Shot; comparisons: TableComparison[] }
  >();
  private readonly busy = new Map<string, Busy>();

  constructor(private readonly deps: DiffCameraDeps) {
    this.cameras = deps.load();
  }

  /** サイドバーからのメッセージ */
  async handle(message: FromCameraView): Promise<void> {
    switch (message.type) {
      case "ready":
        this.post();
        return;
      case "create":
        return this.create();
      case "rename":
        return this.rename(message.id);
      case "delete":
        return this.remove(message.id);
      case "addTables":
        return this.addTables(message.id);
      case "removeTable":
        return this.editTables(message.id, (tables) =>
          tables.filter((_, i) => i !== message.index),
        );
      case "editCondition":
        return this.editCondition(message.id, message.index);
      case "takeBefore":
        return this.take(message.id, "before");
      case "takeAfter":
        return this.take(message.id, "after");
      case "cancel":
        this.busy.get(message.id)?.abort.abort();
        return;
      case "openDiff":
        this.openDiff(message.id);
        return;
    }
  }

  /** 差分のタブからのメッセージ */
  async handleDiff(cameraId: string, message: FromDiffView): Promise<void> {
    switch (message.type) {
      case "ready":
        this.openDiff(cameraId);
        return;
      case "copyText":
        return this.copyText(cameraId);
      case "retakeAfter":
        return this.take(cameraId, "after");
    }
  }

  /** 設定を読み込んだときなど、覚えたカメラが変わったとき */
  reload(): void {
    this.cameras = this.deps.load();
    this.post();
  }

  private async create(): Promise<void> {
    const connection = await this.deps.chooseConnection();
    if (!connection) return;
    const name = await this.deps.askName();
    if (!name) return;
    const camera: DiffCamera = {
      id: this.deps.newId?.() ?? globalThis.crypto.randomUUID(),
      name,
      connection,
      tables: [],
    };
    await this.save([...this.cameras, camera]);
    await this.addTables(camera.id);
  }

  private async rename(id: string): Promise<void> {
    const camera = this.find(id);
    if (!camera) return;
    const name = await this.deps.askName(camera.name);
    if (!name || name === camera.name) return;
    await this.save(
      this.cameras.map((c) => (c.id === id ? { ...c, name } : c)),
    );
  }

  private async remove(id: string): Promise<void> {
    const camera = this.find(id);
    if (!camera || !(await this.deps.confirmDelete(camera.name))) return;
    this.busy.get(id)?.abort.abort();
    this.befores.delete(id);
    this.lasts.delete(id);
    await this.save(this.cameras.filter((c) => c.id !== id));
  }

  private async addTables(id: string): Promise<void> {
    const camera = this.find(id);
    if (!camera) return;
    const picked = await this.deps.pickTables(camera.connection, camera.tables);
    if (!picked) return;
    const same = (a: TableRef, b: TableRef) =>
      a.schema === b.schema && a.name === b.name;
    // 選んだ順。前からある表は、条件を残す
    const tables = picked.map(
      (t) =>
        camera.tables.find((c) => same(c, t)) ?? {
          schema: t.schema,
          name: t.name,
        },
    );
    await this.editTables(id, () => tables);
  }

  private async editCondition(id: string, index: number): Promise<void> {
    const camera = this.find(id);
    const table = camera?.tables[index];
    if (!camera || !table) return;
    const where = await this.deps.askCondition(camera.connection, table);
    if (where === undefined) return;
    await this.editTables(id, (tables) =>
      tables.map((t, i) => {
        if (i !== index) return t;
        const { where: _old, ...rest } = t;
        return where.trim() === "" ? rest : { ...rest, where: where.trim() };
      }),
    );
  }

  /** 表や条件を変えたら、前に撮ったものは比べられないので捨てる */
  private async editTables(
    id: string,
    change: (tables: CameraTable[]) => CameraTable[],
  ): Promise<void> {
    const camera = this.find(id);
    if (!camera) return;
    const tables = change(camera.tables);
    if (this.befores.delete(id)) {
      this.deps.showMessage(
        `「${camera.name}」の表や条件を変えたので、「前」を撮り直してください`,
        "info",
      );
    }
    await this.save(
      this.cameras.map((c) => (c.id === id ? { ...c, tables } : c)),
    );
  }

  private async take(id: string, what: "before" | "after"): Promise<void> {
    const camera = this.find(id);
    if (!camera || this.busy.has(id)) return;
    if (camera.tables.length === 0) {
      this.deps.showMessage(
        `「${camera.name}」に表がありません。「＋ 表を足す」で見る表を選んでください`,
        "error",
      );
      return;
    }
    const before = this.befores.get(id);
    if (what === "after" && !before) {
      this.deps.showMessage(
        "先に「前を撮る」を押してから、画面を操作してください",
        "error",
      );
      return;
    }
    const busy: Busy = {
      what,
      done: 0,
      total: camera.tables.length,
      abort: new AbortController(),
    };
    this.busy.set(id, busy);
    if (what === "after") this.deps.diffBusy?.(id, true);
    this.post();
    const label = what === "before" ? "前" : "後";
    try {
      const { session, dialect } = await this.deps.openSession(
        camera.connection,
      );
      const shot = await shoot({
        session,
        dialect,
        tables: camera.tables,
        maxRows: this.deps.maxRows(),
        keyColumns: (t) => this.deps.keyColumns?.(camera.connection, t),
        logicalName: (t) => this.deps.logicalName?.(camera.connection, t),
        signal: busy.abort.signal,
        onProgress: (done) => {
          busy.done = done;
          this.post();
        },
        ...(this.deps.now ? { now: this.deps.now } : {}),
      });
      const rows = shot.tables.reduce((n, t) => n + t.rows.length, 0);
      const errors = shot.tables.filter((t) => t.error).length;
      this.deps.log?.(
        `差分カメラ「${camera.name}」：${label}を撮りました（${shot.tables.length} 表・${rows} 行・${shot.elapsedMs} ms${errors > 0 ? `・撮れなかった表 ${errors}` : ""}）`,
      );
      if (what === "before") {
        this.befores.set(id, shot);
        if (errors > 0) {
          this.deps.showMessage(
            `撮れなかった表があります：${shot.tables
              .filter((t) => t.error)
              .map((t) => `${t.table.name}（${t.error}）`)
              .join("、")}`,
            "error",
          );
        }
      } else if (before) {
        const comparisons = compareShots(before, shot);
        this.lasts.set(id, { after: shot, comparisons });
        this.openDiff(id);
      }
    } catch (error) {
      if (!isAbortError(error)) {
        const text = error instanceof Error ? error.message : String(error);
        this.deps.log?.(
          `差分カメラ「${camera.name}」：${label}を撮れませんでした：${text}`,
        );
        this.deps.showMessage(
          `「${label}」を撮れませんでした：${text}`,
          "error",
        );
      }
    } finally {
      this.busy.delete(id);
      if (what === "after") this.deps.diffBusy?.(id, false);
      this.post();
    }
  }

  private openDiff(id: string): void {
    const camera = this.find(id);
    const before = this.befores.get(id);
    const last = this.lasts.get(id);
    if (!camera || !before || !last) return;
    this.deps.showDiff(
      id,
      diffView({
        camera: camera.name,
        connection: camera.connection,
        before,
        after: last.after,
        comparisons: last.comparisons,
      }),
    );
  }

  private async copyText(id: string): Promise<void> {
    const camera = this.find(id);
    const before = this.befores.get(id);
    const last = this.lasts.get(id);
    if (!camera || !before || !last) return;
    const heading = `差分カメラ「${camera.name}」（${camera.connection}）　前 ${clock(before.takenAt)} → 後 ${clock(last.after.takenAt)}`;
    await this.deps.copyText(comparisonText(heading, last.comparisons));
  }

  private find(id: string): DiffCamera | undefined {
    return this.cameras.find((c) => c.id === id);
  }

  private async save(cameras: DiffCamera[]): Promise<void> {
    this.cameras = cameras;
    this.post();
    await this.deps.save(cameras);
  }

  private post(): void {
    this.deps.postView({
      type: "state",
      cameras: this.cameras.map((camera): CameraItem => {
        const before = this.befores.get(camera.id);
        const busy = this.busy.get(camera.id);
        return {
          id: camera.id,
          name: camera.name,
          connection: camera.connection,
          tables: camera.tables.map((t) => {
            const logicalName = this.deps.logicalName?.(camera.connection, t);
            return {
              schema: t.schema,
              name: t.name,
              ...(logicalName ? { logicalName } : {}),
              ...(t.where ? { where: t.where } : {}),
            };
          }),
          before: before
            ? {
                takenAt: before.takenAt,
                elapsedMs: before.elapsedMs,
                rows: before.tables.reduce((n, t) => n + t.rows.length, 0),
                tables: before.tables.length,
                errors: before.tables.filter((t) => t.error).length,
              }
            : null,
          busy: busy
            ? { what: busy.what, done: busy.done, total: busy.total }
            : null,
          hasDiff: this.lasts.has(camera.id) && before !== undefined,
        };
      }),
    });
  }
}

/** 時:分:秒（その PC の時刻） */
export function clock(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
