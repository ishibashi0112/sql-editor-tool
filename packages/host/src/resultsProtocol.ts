// 拡張と「SQL の結果」のパネル（下のパネルの Webview、D-41）の間のメッセージ。
// 結果はタブに分け、タブの中身はレポートの画面と同じメッセージ（ToReport / FromReport）で動かす

import type { PrefsMessage, SetHeaderModeMessage } from "./protocol";
import type { FromReport, ToReport } from "./reportProtocol";

export type ResultTab = {
  id: string;
  /** タブの名前（ファイル名。文が複数なら番号を付ける） */
  label: string;
  /** どの SQL の結果か（例：受注一覧.sql の 12 行目） */
  detail: string;
};

export type ToResults =
  /** タブの並びと、前に出すタブ */
  | { type: "tabs"; tabs: ResultTab[]; active: string | null }
  | { type: "tab"; tabId: string; message: ToReport }
  | PrefsMessage;

export type FromResults =
  | { type: "ready" }
  | { type: "tab"; tabId: string; message: FromReport }
  | { type: "selectTab"; tabId: string }
  | { type: "closeTab"; tabId: string }
  | SetHeaderModeMessage;
