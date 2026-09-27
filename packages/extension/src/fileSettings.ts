// VS Code の中（globalState）に覚えるもの（D-44）。.sql は書き換えない（BI ツールに貼る SQL を汚さないため）。
// 設定の書き出し・読み込み（別の PC への引き継ぎ）と Settings Sync でも、このキーを使う

import {
  hasReportHeader,
  parseReportConfig,
  type ReportConfig,
  type ReportParamConfig,
} from "@sql-editor-tool/core";
import type * as vscode from "vscode";

export const STATE_KEYS = {
  /** .sql の URI → 補完・実行に使う接続名（空文字は「使わない」） */
  fileConnections: "sqlEditorTool.sqlConnections",
  /** .sql の URI → 入力欄の設定（表示名・種類・必須・既定値・選択肢） */
  paramSettings: "sqlEditorTool.paramSettings",
  /** .sql の URI → 入力欄に最後に入れた値 */
  formValues: "sqlEditorTool.reportValues",
  /** [接続名, スキーマ, テーブル] の JSON → 列の設定（D-36） */
  tableSettings: "sqlEditorTool.tableSettings",
} as const;

type ParamSettings = Record<string, ReportParamConfig>;

function allParamSettings(
  state: vscode.Memento,
): Record<string, ParamSettings> {
  return state.get<Record<string, ParamSettings>>(STATE_KEYS.paramSettings, {});
}

/** 入力欄の設定を覚える（ファイルごと） */
export async function saveParamSettings(
  state: vscode.Memento,
  uri: string,
  params: ParamSettings,
): Promise<void> {
  await state.update(STATE_KEYS.paramSettings, {
    ...allParamSettings(state),
    [uri]: params,
  });
}

/**
 * .sql の入力欄の設定。覚えた設定と、先頭の設定のコメント（0.8 までのレポートの .sql。読むだけ）を合わせる。
 * 同じ入力欄なら覚えた設定を使う。どちらもなければ null
 */
export function fileConfig(
  state: vscode.Memento,
  uri: string,
  text: string,
): ReportConfig | null {
  const header = hasReportHeader(text) ? parseReportConfig(text).config : null;
  const all = allParamSettings(state);
  const saved = Object.hasOwn(all, uri) ? all[uri] : undefined;
  if (!header && !saved) return null;
  return {
    ...header,
    params: { ...header?.params, ...saved },
  };
}
