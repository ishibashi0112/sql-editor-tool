// 差分カメラ（D-47）の操作：カメラを作る・表を足す・条件を付ける・前を撮る・後を撮って比べる。
// 撮ったもの（前・後）はここに持つ（VS Code を閉じるまで）。VS Code に依存しないので、画面の操作は deps で受け取る

import {
  type ColumnInfo,
  checkCondition,
  type DialectName,
  getDialect,
  type TableRef,
} from "@sql-editor-tool/core";
import {
  type CameraTable,
  compareShots,
  comparisonSummary,
  comparisonText,
  type DiffCamera,
  diffView,
  type Shot,
  shoot,
  type TableComparison,
} from "./diffCamera";
import type {
  CameraItem,
  ConditionColumn,
  DiffHistoryItem,
  DiffView,
  FromCameraView,
  FromDiffView,
  ToCameraView,
} from "./diffCameraProtocol";
import { diffSheet, type SheetRow } from "./diffSheet";
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
  /** 接続の方言（条件の検査に使う。接続しない） */
  dialect(connection: string): DialectName;

  // 画面の操作（入力を聞く）。やめたら undefined
  askName(current?: string): Promise<string | undefined>;
  chooseConnection(): Promise<string | undefined>;
  pickTables(
    connection: string,
    current: readonly TableRef[],
  ): Promise<TableRef[] | undefined>;
  confirmDelete(name: string): Promise<boolean>;

  postView(message: ToCameraView): void;
  /** 差分のタブを開く（開いていれば中身を替える） */
  showDiff(cameraId: string, view: DiffView): void;
  /** 差分のタブで「後」を撮り直しているところか */
  diffBusy?(cameraId: string, busy: boolean): void;
  copyText(text: string): Promise<void>;
  /** Excel のファイルに保存する（保存先を聞く）。fileName は保存先の既定の名前 */
  saveExcel(fileName: string, rows: SheetRow[]): Promise<void>;
  /** ステータスバーに少しの間だけ出す */
  showStatus?(message: string): void;
  showMessage(message: string, kind: "info" | "error"): void;
  log?(message: string): void;
  now?(): number;
  newId?(): string;
};

/** 比べた記録（カメラごとに、新しいものから覚えておく数） */
export const DIFF_HISTORY_LIMIT = 20;

/** 比べた 1 回分。撮ったもの全体ではなく、差分だけを持つ */
type HistoryEntry = {
  id: string;
  seq: number;
  beforeAt: number;
  afterAt: number;
  comparisons: TableComparison[];
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
  /** カメラの ID → 比べた記録（古い順） */
  private readonly history = new Map<string, HistoryEntry[]>();
  /** カメラの ID → 比べた回の数（記録から消えても数える） */
  private readonly seqs = new Map<string, number>();
  /** 「接続\0スキーマ\0表」→ 列（条件の入力欄の候補） */
  private readonly columnCache = new Map<string, ColumnInfo[]>();
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
      case "loadColumns":
        return this.loadColumns(message.id, message.index);
      case "setCondition":
        return this.setCondition(message.id, message.index, message.where);
      case "takeBefore":
        return this.take(message.id, "before");
      case "takeAfter":
        return this.take(message.id, "after");
      case "cancel":
        this.busy.get(message.id)?.abort.abort();
        return;
      case "openDiff":
        this.openDiff(message.id, message.entry);
        return;
    }
  }

  /** 差分のタブからのメッセージ */
  async handleDiff(cameraId: string, message: FromDiffView): Promise<void> {
    switch (message.type) {
      case "ready":
        this.openDiff(cameraId, this.shown.get(cameraId));
        return;
      case "show":
        this.openDiff(cameraId, message.entry);
        return;
      case "copyText":
        return this.copyText(cameraId, message.entry);
      case "copiedTable":
        this.deps.showStatus?.(
          message.truncated
            ? "差分を表でコピーしました（出している行まで。全部は「Excel で保存」で）"
            : "差分を表でコピーしました（Excel に貼れます）",
        );
        return;
      case "copyPlain":
        return this.deps.copyText(message.text);
      case "saveExcel":
        return this.saveExcel(cameraId, message.entry, message.changedOnly);
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
    this.history.delete(id);
    this.shown.delete(id);
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

  /** 条件の入力欄の列の候補を送る（接続していなければ接続する） */
  private async loadColumns(id: string, index: number): Promise<void> {
    const camera = this.find(id);
    const table = camera?.tables[index];
    if (!camera || !table) return;
    const cacheKey = [camera.connection, table.schema, table.name].join("\0");
    try {
      let columns = this.columnCache.get(cacheKey);
      if (!columns) {
        const { session } = await this.deps.openSession(camera.connection);
        columns = (
          await session.describeTable({
            schema: table.schema,
            name: table.name,
          })
        ).columns;
        this.columnCache.set(cacheKey, columns);
      }
      this.deps.postView({
        type: "columns",
        id,
        index,
        columns: columns.map(conditionColumn),
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.deps.postView({
        type: "columns",
        id,
        index,
        columns: [],
        error: `列の候補を出せませんでした：${text}`,
      });
    }
  }

  private async setCondition(
    id: string,
    index: number,
    text: string,
  ): Promise<void> {
    const camera = this.find(id);
    const table = camera?.tables[index];
    if (!camera || !table) return;
    const where = text.trim();
    if (where !== "") {
      try {
        checkCondition(getDialect(this.deps.dialect(camera.connection)), where);
      } catch (error) {
        this.deps.showMessage(
          error instanceof Error ? error.message : String(error),
          "error",
        );
        return;
      }
    }
    if (where === (table.where ?? "")) return;
    await this.editTables(id, (tables) =>
      tables.map((t, i) => {
        if (i !== index) return t;
        const { where: _old, ...rest } = t;
        return where === "" ? rest : { ...rest, where };
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
        const entry = this.record(id, before, shot);
        this.openDiff(id, entry.id);
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

  /** 比べた回を記録に足す（古いものから捨てる） */
  private record(id: string, before: Shot, after: Shot): HistoryEntry {
    const seq = (this.seqs.get(id) ?? 0) + 1;
    this.seqs.set(id, seq);
    const entry: HistoryEntry = {
      id: `${id}:${seq}`,
      seq,
      beforeAt: before.takenAt,
      afterAt: after.takenAt,
      comparisons: compareShots(before, after),
    };
    const list = [...(this.history.get(id) ?? []), entry];
    this.history.set(id, list.slice(-DIFF_HISTORY_LIMIT));
    return entry;
  }

  /** 差分のタブで出している回（カメラの ID → 回の ID） */
  private readonly shown = new Map<string, string>();

  private entry(id: string, entry?: string): HistoryEntry | undefined {
    const list = this.history.get(id) ?? [];
    return (entry && list.find((e) => e.id === entry)) || list.at(-1);
  }

  private historyItems(id: string): DiffHistoryItem[] {
    return (this.history.get(id) ?? [])
      .map((e) => ({
        id: e.id,
        seq: e.seq,
        beforeAt: e.beforeAt,
        afterAt: e.afterAt,
        summary: comparisonSummary(e.comparisons),
      }))
      .reverse();
  }

  private view(
    camera: DiffCamera,
    entry: HistoryEntry,
    maxRows?: number,
  ): DiffView {
    return diffView({
      camera: camera.name,
      connection: camera.connection,
      entry: entry.id,
      history: this.historyItems(camera.id),
      beforeAt: entry.beforeAt,
      afterAt: entry.afterAt,
      comparisons: entry.comparisons,
      ...(maxRows !== undefined ? { maxRows } : {}),
    });
  }

  private openDiff(id: string, entryId?: string): void {
    const camera = this.find(id);
    const entry = this.entry(id, entryId);
    if (!camera || !entry) return;
    this.shown.set(id, entry.id);
    this.deps.showDiff(id, this.view(camera, entry));
  }

  private async copyText(id: string, entryId: string): Promise<void> {
    const camera = this.find(id);
    const entry = this.entry(id, entryId);
    if (!camera || !entry) return;
    const heading = `差分カメラ「${camera.name}」（${camera.connection}）　前 ${clock(entry.beforeAt)} → 後 ${clock(entry.afterAt)}`;
    await this.deps.copyText(comparisonText(heading, entry.comparisons));
  }

  /** 全部の行を Excel に保存する（差分のタブの行の上限なし） */
  private async saveExcel(
    id: string,
    entryId: string,
    changedOnly: boolean,
  ): Promise<void> {
    const camera = this.find(id);
    const entry = this.entry(id, entryId);
    if (!camera || !entry) return;
    const rows = diffSheet(this.view(camera, entry, Infinity), {
      changedOnly,
    });
    await this.deps.saveExcel(
      `差分_${fileSafe(camera.name)}_${stamp(entry.afterAt)}.xlsx`,
      rows,
    );
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
          dialect: this.deps.dialect(camera.connection),
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
          history: this.historyItems(camera.id),
        };
      }),
    });
  }
}

function conditionColumn(column: ColumnInfo): ConditionColumn {
  return {
    name: column.name,
    ...(column.logicalName ? { logicalName: column.logicalName } : {}),
    typeLabel: typeLabel(column),
  };
}

/** 条件を書くときの手がかりになる型の名前 */
function typeLabel(column: ColumnInfo): string {
  if (column.semantic?.kind === "date") return "日付（yyyymmdd）";
  const { type } = column;
  switch (type.kind) {
    case "string":
      return type.length === null ? "文字" : `文字 ${type.length}`;
    case "number":
      return "数値";
    case "datetime":
      return type.hasTime ? "日時" : "日付";
    case "other":
      return type.dbTypeName;
  }
}

/** ファイル名に使えない文字を「_」にする */
function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
}

/** 20260927_101532 */
function stamp(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 時:分:秒（その PC の時刻） */
export function clock(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
