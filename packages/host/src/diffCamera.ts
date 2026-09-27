// 差分カメラ（D-47）のホスト側：表を撮る（スナップショット）と、前後を比べる。VS Code に依存しない

import {
  buildSelect,
  type ColumnInfo,
  type DialectName,
  diffTable,
  diffText,
  type SortEntry,
  type TableDiff,
  type TableRef,
} from "@sql-editor-tool/core";
import type { DiffRow, DiffTableView, DiffView } from "./diffCameraProtocol";
import { type CellValue, type DbSession, isAbortError } from "./session";

/** カメラで見る表。where は SQL の条件式（なければ全部の行） */
export type CameraTable = TableRef & { where?: string };

/** カメラ（名前・接続・見る表）。VS Code の中に覚える */
export type DiffCamera = {
  id: string;
  name: string;
  /** 接続の名前（接続の ID は PC ごとに違うので、名前で結び付ける） */
  connection: string;
  tables: CameraTable[];
};

/** 表ごとの行数の上限の既定（D-47） */
export const DEFAULT_SHOT_MAX_ROWS = 100_000;

/** 撮った表 */
export type TableShot = {
  table: CameraTable;
  logicalName?: string;
  columns: ColumnInfo[];
  /** 行の同一性を決める列と、どこから決めたか（主キー・列の設定・なし） */
  key: string[];
  keySource: "primary" | "settings" | "none";
  rows: CellValue[][];
  /** 撮れなかった理由（行が多すぎた、表がないなど） */
  error?: string;
};

export type Shot = { takenAt: number; elapsedMs: number; tables: TableShot[] };

export type ShootInput = {
  session: DbSession;
  dialect: DialectName;
  tables: readonly CameraTable[];
  /** 表ごとの行数の上限 */
  maxRows: number;
  /** 主キーのない表のキー（列の設定、D-36） */
  keyColumns?(table: TableRef): readonly string[] | undefined;
  /** 表の論理名（D-40） */
  logicalName?(table: TableRef): string | undefined;
  signal?: AbortSignal;
  /** 表を 1 つ撮るたび（done 個目まで撮った） */
  onProgress?(done: number, total: number): void;
  now?(): number;
};

/** カメラの表を順に撮る。表ごとの失敗（行が多すぎたなど）は、その表の error にして続ける */
export async function shoot(input: ShootInput): Promise<Shot> {
  const now = input.now ?? Date.now;
  const started = now();
  const tables: TableShot[] = [];
  for (const table of input.tables) {
    if (input.signal?.aborted) throw abortSignalError();
    tables.push(await shootTable(input, table));
    input.onProgress?.(tables.length, input.tables.length);
  }
  return { takenAt: started, elapsedMs: now() - started, tables };
}

async function shootTable(
  input: ShootInput,
  table: CameraTable,
): Promise<TableShot> {
  const ref: TableRef = { schema: table.schema, name: table.name };
  const logicalName = input.logicalName?.(ref);
  const base = {
    table,
    ...(logicalName ? { logicalName } : {}),
  };
  try {
    const description = await input.session.describeTable(ref);
    const names = new Set(description.columns.map((c) => c.name));
    const settingsKey = (input.keyColumns?.(ref) ?? []).filter((k) =>
      names.has(k),
    );
    const key =
      description.primaryKey.length > 0 ? description.primaryKey : settingsKey;
    const keySource =
      description.primaryKey.length > 0
        ? "primary"
        : settingsKey.length > 0
          ? "settings"
          : "none";
    // キーの順に撮る（キーがなければ、DB の返す順）
    const sort: SortEntry[] = key.map((columnKey) => ({
      columnKey,
      direction: "asc",
    }));
    const limit = input.maxRows + 1;
    const built = buildSelect({
      dialect: input.dialect,
      source: { kind: "table", table: ref },
      columns: description.columns,
      sort,
      limit,
      ...(table.where ? { where: table.where } : {}),
    });
    const rows: CellValue[][] = [];
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await input.session.query(
        {
          sql: built.sql,
          params: built.params,
          intent: {
            kind: "rows",
            source: { kind: "table", table: ref },
            sort,
            limit,
          },
        },
        {
          signal: abort.signal,
          onColumns: () => {},
          onRows: (chunk) => {
            for (const row of chunk) rows.push(row);
            if (rows.length > input.maxRows) abort.abort();
          },
        },
      );
    } catch (error) {
      if (!(isAbortError(error) && rows.length > input.maxRows)) throw error;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
    const shot = {
      ...base,
      columns: description.columns,
      key,
      keySource,
      rows,
    } satisfies TableShot;
    if (rows.length > input.maxRows) {
      return {
        ...shot,
        rows: [],
        error: `${input.maxRows.toLocaleString("ja-JP")} 行を超えるので撮りませんでした。表に条件を付けて、行を絞ってください`,
      };
    }
    return shot;
  } catch (error) {
    if (input.signal?.aborted) throw abortSignalError();
    return {
      ...base,
      columns: [],
      key: [],
      keySource: "none",
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function abortSignalError(): Error {
  const error = new Error("中断しました");
  error.name = "AbortError";
  return error;
}

/** 比べた表 */
export type TableComparison = {
  table: CameraTable;
  logicalName?: string;
  columns: ColumnInfo[];
  keySource: TableShot["keySource"];
  diff?: TableDiff;
  error?: string;
};

/** 前と後を表ごとに比べる（後の表の並び）。どちらかで撮れなかった表は error */
export function compareShots(before: Shot, after: Shot): TableComparison[] {
  return after.tables.map((a) => {
    const b = before.tables.find(
      (t) => t.table.schema === a.table.schema && t.table.name === a.table.name,
    );
    const common = {
      table: a.table,
      ...(a.logicalName ? { logicalName: a.logicalName } : {}),
      columns: a.columns,
      keySource: a.keySource,
    };
    if (a.error) return { ...common, error: `後：${a.error}` };
    if (!b) return { ...common, error: "「前」を撮った後に足した表です" };
    if (b.error) return { ...common, error: `前：${b.error}` };
    const names = (shot: TableShot) => shot.columns.map((c) => c.name);
    return {
      ...common,
      diff: diffTable(
        { columns: names(b), key: b.key, rows: b.rows },
        { columns: names(a), key: a.key, rows: a.rows },
      ),
    };
  });
}

/** 表の見出し（論理名があれば「論理名 物理名」） */
export function tableTitle(t: {
  table: TableRef;
  logicalName?: string | undefined;
}): string {
  return t.logicalName ? `${t.logicalName} ${t.table.name}` : t.table.name;
}

/** 「テキストでコピー」の文（D-47） */
export function comparisonText(
  heading: string,
  tables: readonly TableComparison[],
): string {
  return diffText(
    heading,
    tables.map((t) => ({
      title: tableTitle(t),
      diff: t.diff ?? emptyDiff(),
      labels: (t.diff?.columns ?? []).map(
        (name) => t.columns.find((c) => c.name === name)?.logicalName ?? name,
      ),
      ...(t.error ? { error: t.error } : {}),
    })),
  );
}

function emptyDiff(): TableDiff {
  return {
    columns: [],
    key: [],
    changes: [],
    added: 0,
    deleted: 0,
    changedRows: 0,
    unchanged: 0,
    columnsChanged: false,
  };
}

/** 差分のタブに出す行の上限（表ごと）。多すぎる差分は「テキストでコピー」で見る */
export const DIFF_VIEW_MAX_ROWS = 1000;

/** 差分のタブに出す形にする */
export function diffView(input: {
  camera: string;
  connection: string;
  before: Shot;
  after: Shot;
  comparisons: readonly TableComparison[];
  maxRows?: number;
}): DiffView {
  const maxRows = input.maxRows ?? DIFF_VIEW_MAX_ROWS;
  return {
    camera: input.camera,
    connection: input.connection,
    beforeAt: input.before.takenAt,
    afterAt: input.after.takenAt,
    tables: input.comparisons.map((t): DiffTableView => {
      const { diff } = t;
      const key = new Set(diff?.key ?? []);
      const columns = (diff?.columns ?? []).map((name) => {
        const info = t.columns.find((c) => c.name === name);
        return {
          name,
          ...(info?.logicalName ? { logicalName: info.logicalName } : {}),
          key: key.has(name),
        };
      });
      const changes = diff?.changes ?? [];
      const rows = changes.slice(0, maxRows).map(
        (c): DiffRow =>
          c.kind === "changed"
            ? {
                kind: "changed",
                before: [...c.before] as CellValue[],
                values: [...c.after] as CellValue[],
                changed: [...c.changed],
              }
            : { kind: c.kind, values: [...c.row] as CellValue[] },
      );
      return {
        schema: t.table.schema,
        name: t.table.name,
        ...(t.logicalName ? { logicalName: t.logicalName } : {}),
        ...(t.table.where ? { where: t.table.where } : {}),
        columns,
        keySource: t.keySource,
        counts: {
          added: diff?.added ?? 0,
          deleted: diff?.deleted ?? 0,
          changed: diff?.changedRows ?? 0,
          unchanged: diff?.unchanged ?? 0,
        },
        rows,
        more: Math.max(0, changes.length - rows.length),
        columnsChanged: diff?.columnsChanged ?? false,
        ...(t.error ? { error: t.error } : {}),
      };
    }),
  };
}
