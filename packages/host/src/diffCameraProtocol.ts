// 差分カメラ（D-47）の、拡張とサイドバーの「差分カメラ」・差分のタブ（Webview）の間のメッセージ

import type { DialectName } from "@sql-editor-tool/core";
import type { CellValue } from "./session";

/** 比べた記録の 1 回分（サイドバーと差分のタブに出す） */
export type DiffHistoryItem = {
  id: string;
  /** そのカメラで何回目に比べたか（1 から） */
  seq: number;
  beforeAt: number;
  afterAt: number;
  /** 「変更 2 行・追加 1 行」など（全部の表を合わせて） */
  summary: string;
};

/** サイドバーに出すカメラ */
export type CameraItem = {
  id: string;
  name: string;
  connection: string;
  /** 接続の方言（条件の入力欄の検査に使う） */
  dialect: DialectName;
  tables: {
    schema: string;
    name: string;
    logicalName?: string;
    where?: string;
  }[];
  /** 「前」を撮った時刻と中身。撮っていなければ null */
  before: {
    takenAt: number;
    elapsedMs: number;
    rows: number;
    tables: number;
    /** 撮れなかった表の数 */
    errors: number;
  } | null;
  /** 撮っているところ（done 個目の表まで撮った） */
  busy: { what: "before" | "after"; done: number; total: number } | null;
  /** 比べた記録（新しい順。VS Code を閉じるまで） */
  history: DiffHistoryItem[];
};

/** 条件の入力欄に出す列の候補 */
export type ConditionColumn = {
  name: string;
  logicalName?: string;
  /** 「文字 10」「数値」「日付」など */
  typeLabel: string;
};

export type ToCameraView =
  | { type: "state"; cameras: CameraItem[] }
  /** 条件の入力欄の列の候補（取れなければ error） */
  | {
      type: "columns";
      id: string;
      index: number;
      columns: ConditionColumn[];
      error?: string;
    };

export type FromCameraView =
  | { type: "ready" }
  | { type: "create" }
  | { type: "rename"; id: string }
  | { type: "delete"; id: string }
  | { type: "addTables"; id: string }
  | { type: "removeTable"; id: string; index: number }
  /** 条件の入力欄を開いた（列の候補を取る） */
  | { type: "loadColumns"; id: string; index: number }
  /** 条件を決めた。空なら条件を外す */
  | { type: "setCondition"; id: string; index: number; where: string }
  | { type: "takeBefore"; id: string }
  | { type: "takeAfter"; id: string }
  | { type: "cancel"; id: string }
  /** 比べた記録を差分のタブで開く（entry がなければ最後の回） */
  | { type: "openDiff"; id: string; entry?: string };

/** 差分のタブの列 */
export type DiffColumn = { name: string; logicalName?: string; key: boolean };

export type DiffRow =
  | { kind: "added" | "deleted"; values: CellValue[] }
  | {
      kind: "changed";
      before: CellValue[];
      values: CellValue[];
      /** 変わった列の添字 */
      changed: number[];
    };

export type DiffTableView = {
  schema: string;
  name: string;
  logicalName?: string;
  where?: string;
  columns: DiffColumn[];
  /** どれかの行で変わった列の添字（「変わった列だけ」に使う。出さなかった行も含む） */
  changedColumns: number[];
  /** 行の同一性をどこで決めたか（主キー・列の設定・なし＝行の中身全体） */
  keySource: "primary" | "settings" | "none";
  counts: {
    added: number;
    deleted: number;
    changed: number;
    unchanged: number;
  };
  rows: DiffRow[];
  /** 多すぎて出さなかった行の数 */
  more: number;
  /** 前と後で表の列が違う */
  columnsChanged: boolean;
  /** 撮れなかった理由 */
  error?: string;
};

export type DiffView = {
  camera: string;
  connection: string;
  /** 出している回と、そのカメラの比べた記録（新しい順） */
  entry: string;
  history: DiffHistoryItem[];
  beforeAt: number;
  afterAt: number;
  tables: DiffTableView[];
};

export type ToDiffView =
  | { type: "view"; view: DiffView }
  /** 「後」を撮り直しているところ */
  | { type: "busy"; busy: boolean };

export type FromDiffView =
  | { type: "ready" }
  /** 比べた記録のほかの回を出す */
  | { type: "show"; entry: string }
  | { type: "copyText"; entry: string }
  /** 「表でコピー」をした（画面がクリップボードに入れた。truncated は出していない行があった） */
  | { type: "copiedTable"; truncated: boolean }
  /** 画面がクリップボードに入れられなかったので、タブ区切りの文字だけ入れてほしい */
  | { type: "copyPlain"; text: string }
  | { type: "saveExcel"; entry: string; changedOnly: boolean }
  /** もう一度「後」を撮って、同じ「前」と比べる */
  | { type: "retakeAfter" };
