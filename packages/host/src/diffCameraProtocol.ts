// 差分カメラ（D-47）の、拡張とサイドバーの「差分カメラ」・差分のタブ（Webview）の間のメッセージ

import type { CellValue } from "./session";

/** サイドバーに出すカメラ */
export type CameraItem = {
  id: string;
  name: string;
  connection: string;
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
  /** 差分のタブを開き直せる */
  hasDiff: boolean;
};

export type ToCameraView = { type: "state"; cameras: CameraItem[] };

export type FromCameraView =
  | { type: "ready" }
  | { type: "create" }
  | { type: "rename"; id: string }
  | { type: "delete"; id: string }
  | { type: "addTables"; id: string }
  | { type: "removeTable"; id: string; index: number }
  | { type: "editCondition"; id: string; index: number }
  | { type: "takeBefore"; id: string }
  | { type: "takeAfter"; id: string }
  | { type: "cancel"; id: string }
  | { type: "openDiff"; id: string };

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
  | { type: "copyText" }
  /** もう一度「後」を撮って、同じ「前」と比べる */
  | { type: "retakeAfter" };
