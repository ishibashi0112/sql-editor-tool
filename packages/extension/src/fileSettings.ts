// VS Code の中（globalState）に覚えるもの（D-44）。.sql は書き換えない（BI ツールに貼る SQL を汚さないため）。
// 設定の書き出し・読み込み（別の PC への引き継ぎ）でも、このキーを使う。Settings Sync には載せない
// （社内の接続先や入力した値が、知らないうちに同期のクラウドに上がらないように）

import {
  hasReportHeader,
  parseReportConfig,
  type ReportConfig,
  type ReportParamConfig,
} from "@sql-editor-tool/core";
import * as vscode from "vscode";

export const STATE_KEYS = {
  /** .sql の URI → 補完・実行に使う接続名（空文字は「使わない」） */
  fileConnections: "sqlEditorTool.sqlConnections",
  /** .sql の URI → 入力欄の設定（表示名・種類・必須・既定値・選択肢） */
  paramSettings: "sqlEditorTool.paramSettings",
  /** .sql の URI → 入力欄に最後に入れた値 */
  formValues: "sqlEditorTool.reportValues",
  /** [接続名, スキーマ, テーブル] の JSON → 列の設定（D-36） */
  tableSettings: "sqlEditorTool.tableSettings",
  /** 差分カメラ（名前・接続・見る表と条件）の並び（D-47） */
  diffCameras: "sqlEditorTool.diffCameras",
  /** 「SQL を生成」で最後に選んだ付けるもの（D-49） */
  generateSqlOptions: "sqlEditorTool.generateSqlOptions",
  /** 「SQL を生成」で最後に作った種類（SELECT・INSERT・UPDATE・DELETE） */
  generateSqlKind: "sqlEditorTool.generateSqlKind",
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

/** 入力欄の設定を足す（ファイルごと）。設定してある入力欄は、そのままにする */
export async function addParamSettings(
  state: vscode.Memento,
  uri: string,
  params: ParamSettings,
): Promise<void> {
  const all = allParamSettings(state);
  await state.update(STATE_KEYS.paramSettings, {
    ...all,
    [uri]: { ...params, ...(Object.hasOwn(all, uri) ? all[uri] : {}) },
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

/** ファイル（URI）ごとに覚えるもの */
const FILE_STATE_KEYS = [
  STATE_KEYS.fileConnections,
  STATE_KEYS.paramSettings,
  STATE_KEYS.formValues,
] as const;

function hasFileState(state: vscode.Memento, uri: string): boolean {
  return FILE_STATE_KEYS.some((key) =>
    Object.hasOwn(state.get<Record<string, unknown>>(key, {}), uri),
  );
}

/** 覚えたものを別の URI にも写す。写す先に覚えたものがあれば、そちらを残す */
async function copyFileState(
  state: vscode.Memento,
  from: string,
  to: string,
): Promise<void> {
  for (const key of FILE_STATE_KEYS) {
    const all = state.get<Record<string, unknown>>(key, {});
    if (Object.hasOwn(all, from) && !Object.hasOwn(all, to)) {
      await state.update(key, { ...all, [to]: all[from] });
    }
  }
}

/** 覚えたものを捨てる */
export async function forgetFileState(
  state: vscode.Memento,
  uri: string,
): Promise<void> {
  for (const key of FILE_STATE_KEYS) {
    const all = state.get<Record<string, unknown>>(key, {});
    if (Object.hasOwn(all, uri)) {
      const { [uri]: _removed, ...rest } = all;
      await state.update(key, rest);
    }
  }
}

/** 閉じた名前のないファイルの覚えたものを、保存したファイルに写せるように残しておく間（ミリ秒） */
const UNTITLED_GRACE_MS = 5000;

/**
 * 名前のないファイル（「SQL を生成」で開いたものなど。D-49）に覚えた接続・入力欄の設定・値を、
 * 名前を付けて保存したファイルに引き継ぐ。VS Code は保存した先を知らせないので、中身が同じファイルを探す。
 * 名前を付けて保存すると、VS Code は保存先を空で開いてから中身を入れて保存するので、保存したときに比べる。
 * 保存せずに閉じたものは、覚えたものを捨てる
 */
export function carryOverUntitled(
  state: vscode.Memento,
  /** 引き継いだとき（ステータスバーの接続の表示などを出し直す） */
  onCopied: (document: vscode.TextDocument) => void,
): vscode.Disposable {
  /** 閉じたばかりの名前のないファイル（URI → 中身） */
  const closed = new Map<string, string>();
  const isUntitled = (document: vscode.TextDocument) =>
    document.uri.scheme === "untitled";
  /** 中身が同じ名前のないファイル（開いているもの・閉じたばかりのもの）のうち、覚えたものがあるもの */
  const sourceFor = (text: string) => {
    const open = vscode.workspace.textDocuments
      .filter((d) => isUntitled(d) && d.getText() === text)
      .map((d) => d.uri.toString());
    const recent = [...closed].flatMap(([u, t]) => (t === text ? [u] : []));
    return [...open, ...recent].find((u) => hasFileState(state, u));
  };
  return vscode.Disposable.from(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isUntitled(document)) return;
      const uri = document.uri.toString();
      if (hasFileState(state, uri)) return;
      const from = sourceFor(document.getText());
      if (!from) return;
      void copyFileState(state, from, uri).then(() => onCopied(document));
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (!isUntitled(document)) return;
      const uri = document.uri.toString();
      if (!hasFileState(state, uri)) return;
      const text = document.getText();
      closed.set(uri, text);
      setTimeout(() => {
        if (closed.get(uri) !== text) return;
        closed.delete(uri);
        // 同じ名前（Untitled-1 など）で開き直していれば、そちらのものなので捨てない
        const reopened = vscode.workspace.textDocuments.some(
          (d) => d.uri.toString() === uri,
        );
        if (!reopened) void forgetFileState(state, uri);
      }, UNTITLED_GRACE_MS);
    }),
  );
}
