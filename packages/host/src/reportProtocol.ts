// 拡張とレポートの画面（Webview のパネル）の間のメッセージ（docs/handover.md §16）

import type {
  ColumnFilterValue,
  DialectName,
  ReportParam,
  ReportParamConfig,
  SortEntry,
} from "@sql-editor-tool/core";
import type { SqlPreview, ViewColumn } from "./protocol";
import type { QueryMessage } from "./queryRunner";

/** フォームの値（入力欄の名前 → 入力した文字列） */
export type ReportFormValues = Record<string, string>;

/** 選択肢の候補（1 列目＝値、2 列目＝表示名。D-34） */
export type ReportOption = { value: string; label: string };

/** 選択肢の候補の取得の状況 */
export type ReportOptionsState =
  | { status: "loading" }
  | {
      status: "ok";
      options: ReportOption[] /** 上限で打ち切った */;
      truncated: boolean;
    }
  | { status: "error"; message: string };

export type ReportInit = {
  /** ファイル名（.sql を除く） */
  title: string;
  /** 実行する接続。まだ選んでいなければ null */
  connection: { name: string; dialect: DialectName; demo: boolean } | null;
  params: ReportParam[];
  /** 入力欄に最初に入れる値（前回の値、なければ既定値） */
  values: ReportFormValues;
  /** 取得の上限（D-11） */
  maxRows: number;
  /** 先頭の設定のコメントを読めなかった理由 */
  configError: string | null;
  /** 選択肢の入力欄の候補（入力欄の名前 → 取得の状況） */
  options: Record<string, ReportOptionsState>;
};

export type ToReport =
  | { type: "init"; view: ReportInit }
  | { type: "preview"; preview: SqlPreview }
  /** 選択肢の候補が届いた・取得に失敗した */
  | { type: "options"; name: string; state: ReportOptionsState }
  /** 結果の列（実行するたびに、行より先に届く） */
  | { type: "columns"; queryId: number; columns: ViewColumn[] }
  | QueryMessage;

export type FromReport =
  | { type: "ready" }
  | { type: "valuesChanged"; values: ReportFormValues }
  | {
      type: "conditionsChanged";
      filters: Record<string, ColumnFilterValue>;
      sort: SortEntry[];
    }
  /** all はフォームの値で SQL をそのまま実行、filtered は画面の絞り込みを WHERE にして取り直す（D-25） */
  | { type: "execute"; mode: "all" | "filtered" }
  | { type: "cancel" }
  | { type: "copySql"; variant: "bind" | "literal" }
  /** 入力欄の設定を保存する（.sql の先頭のコメントに書く） */
  | { type: "saveParams"; params: Record<string, ReportParamConfig> }
  | { type: "editSql" }
  | { type: "chooseConnection" };
