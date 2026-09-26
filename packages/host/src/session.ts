// DB ドライバのインターフェイス。driver-mssql / driver-oracle / デモ用ドライバが実装する

import type {
  BoundParam,
  ColumnInfo,
  DialectName,
  QuerySource,
  SortEntry,
  TableRef,
} from "@sql-editor-tool/core";

/**
 * 画面に送るセルの値。ドライバが DB の値をこの形にする。
 * 日付・時刻は 'YYYY-MM-DD HH:mm:ss' などの文字列にする（Date はタイムゾーンの変換で日がずれることがあるため）。
 * 15 桁を超えうる数値は文字列にする（docs/handover.md §6）
 */
export type CellValue = string | number | boolean | null;

export type DbObject = { name: string; kind: "table" | "view" };

export type TableDescription = {
  /** 列の並びは DB 上の順（SELECT * の順） */
  columns: ColumnInfo[];
  /** 主キーの列。ないときは空 */
  primaryKey: string[];
};

/**
 * 実行する問い合わせ。intent はデモ用ドライバが SQL を解釈せずに結果を作るための情報で、実際のドライバは使わない
 */
export type QueryRequest = {
  sql: string;
  params: BoundParam[];
  intent: {
    kind: "rows";
    source: QuerySource;
    sort: SortEntry[];
    limit: number;
  };
};

export type QueryHandlers = {
  signal: AbortSignal;
  /** 結果の列名。行より先に 1 回だけ呼ぶ */
  onColumns(names: string[]): void;
  /** 行をまとめて渡す（1 行ずつではなく、数百〜数千行ずつ）。値の並びは onColumns の順 */
  onRows(rows: CellValue[][]): void;
};

export interface DbSession {
  readonly dialect: DialectName;
  listSchemas(): Promise<string[]>;
  listObjects(schema: string): Promise<DbObject[]>;
  describeTable(table: TableRef): Promise<TableDescription>;
  /** signal が中断されたら、DB 側の実行も止めて AbortError を投げる */
  query(request: QueryRequest, handlers: QueryHandlers): Promise<void>;
  close(): Promise<void>;
}

export function abortError(): Error {
  const error = new Error("中断しました");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
