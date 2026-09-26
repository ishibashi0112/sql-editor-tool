// ホストと Webview の間のメッセージ（postMessage で送る。値は構造化複製できるものだけ）

import type {
  ColumnFilterValue,
  ColumnInfo,
  DialectName,
  SemanticType,
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
  /** デモ接続。SQL は作るが、DB で取り直すときに条件で絞り込まない（画面の絞り込みは効く） */
  demo: boolean;
  /** DB の主キー。ないときは空で、そのときだけ「⚙ 列」でキーを指定できる（D-36） */
  primaryKey: string[];
  /** yyyymmdd の日付らしい列で、まだ日付として扱っていないもの（「⚙ 列」で（候補）と出す） */
  candidates: string[];
  /** 開いたときに案内する候補。列の設定を一度も保存していないテーブルだけ（D-37）。なければ空 */
  suggestion: string[];
  /** 列の設定を保存したことがある（ないときは、「⚙ 列」で候補を日付にした状態から始める） */
  settingsSaved: boolean;
};

export type SqlPreview =
  | { ok: true; sql: string; literalSql: string }
  | { ok: false; message: string; columnKey?: string | undefined };

export type ToWebview =
  | { type: "init"; view: ViewInit }
  | { type: "initFailed"; message: string }
  | { type: "preview"; preview: SqlPreview }
  | {
      type: "queryStarted";
      queryId: number;
      /** DB で絞り込んだ条件（WHERE にした画面の絞り込み）。条件なしで取るときは空 */
      filters: Record<string, ColumnFilterValue>;
    }
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
    };

export type FromWebview =
  | { type: "ready" }
  | {
      type: "conditionsChanged";
      filters: Record<string, ColumnFilterValue>;
      sort: SortEntry[];
    }
  /**
   * DB から取得する（D-25）。all は条件なし（主キーの順）、
   * filtered は画面の絞り込みと並べ替えを WHERE と ORDER BY にして取り直す（上限で打ち切ったとき用）
   */
  | { type: "execute"; mode: "all" | "filtered" }
  | { type: "cancel" }
  | { type: "copySql"; variant: "bind" | "literal" }
  /** 列の設定を保存する（D-36）。semantic は意味型を当てる列、keyColumns は主キーの代わりのキー */
  | {
      type: "saveColumnSettings";
      semantic: Record<string, SemanticType>;
      keyColumns: string[];
    }
  /** 案内の候補を、まとめて日付として扱う（D-37） */
  | { type: "acceptSuggestion" }
  /** 案内の候補を使わない（このテーブルでは、もう案内しない） */
  | { type: "dismissSuggestion" };
