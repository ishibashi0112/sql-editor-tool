// ホストと Webview の間のメッセージ（postMessage で送る。値は構造化複製できるものだけ）

import type {
  ColumnFilterValue,
  ColumnInfo,
  DialectName,
  FilterOptionsResult,
  SortEntry,
} from "@sql-editor-tool/core";
import type { CellValue } from "./session";

export type ViewColumn = ColumnInfo & {
  /** 主キー（またはユーザーが指定したキー）の列 */
  isKey: boolean;
};

export type ViewInit = {
  /** タブと画面上部に出す名前（例：APP.ORDERS） */
  title: string;
  dialect: DialectName;
  columns: ViewColumn[];
  /** 取得の上限（D-11） */
  maxRows: number;
  /** デモ接続。SQL は作るが、条件で絞り込まない */
  demo: boolean;
};

export type SqlPreview =
  | { ok: true; sql: string; literalSql: string }
  | { ok: false; message: string; columnKey?: string | undefined };

export type ToWebview =
  | { type: "init"; view: ViewInit }
  | { type: "initFailed"; message: string }
  | { type: "preview"; preview: SqlPreview }
  | { type: "queryStarted"; queryId: number }
  | { type: "rows"; queryId: number; rows: CellValue[][] }
  | {
      type: "queryDone";
      queryId: number;
      rowCount: number;
      /** 上限を超える行があった（上限までを表示している） */
      truncated: boolean;
      elapsedMs: number;
    }
  | {
      type: "queryFailed";
      queryId: number;
      message: string;
      cancelled: boolean;
    }
  | { type: "filterOptions"; requestId: number; result: FilterOptionsResult }
  | { type: "filterOptionsFailed"; requestId: number; message: string };

export type FromWebview =
  | { type: "ready" }
  | {
      type: "conditionsChanged";
      filters: Record<string, ColumnFilterValue>;
      sort: SortEntry[];
    }
  | { type: "execute" }
  | { type: "cancel" }
  | {
      type: "getFilterOptions";
      requestId: number;
      columnKey: string;
      /** 開いている列を除いた、ほかの列のフィルタ */
      columnFilters: Record<string, ColumnFilterValue>;
    }
  | { type: "abortFilterOptions"; requestId: number }
  | { type: "copySql"; variant: "bind" | "literal" };
