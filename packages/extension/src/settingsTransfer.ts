// 設定の書き出し・読み込み（別の PC への引き継ぎ、D-44）。コマンド「設定を書き出す」「設定を読み込む」。
// パスワードは書き出さない（読み込んだ接続は、初めてつなぐときにパスワードを聞く）。
// .sql の置き場所が違う PC では、書き出した PC のフォルダに当たるフォルダを選んでもらい、付け替える

import { randomUUID } from "node:crypto";
import {
  commonFolder,
  fileUris,
  parseSettingsExport,
  remapFolders,
  SETTINGS_FORMAT,
  SETTINGS_VERSION,
  type SettingsExport,
} from "@sql-editor-tool/host";
import * as vscode from "vscode";
import type { ConnectionProfile, ConnectionStore } from "./connections";
import { STATE_KEYS } from "./fileSettings";

const SECTION = "sqlEditorTool";

export async function exportSettings(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
): Promise<void> {
  const state = context.globalState;
  const data: SettingsExport = {
    format: SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    exportedAt: new Date().toISOString(),
    // id は PC ごとに振り直す。パスワードは SecretStorage にあり、ここには入らない
    connections: store.list().map(({ id: _id, ...profile }) => profile),
    fileConnections: state.get(STATE_KEYS.fileConnections, {}),
    paramSettings: state.get(STATE_KEYS.paramSettings, {}),
    formValues: state.get(STATE_KEYS.formValues, {}),
    tableSettings: state.get(STATE_KEYS.tableSettings, {}),
    diffCameras: state.get(STATE_KEYS.diffCameras, []),
    settings: userSettings(context),
  };
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const target = await vscode.window.showSaveDialog({
    title: "設定を書き出す（別の PC へ引き継ぐ）",
    saveLabel: "書き出す",
    defaultUri: vscode.Uri.joinPath(
      vscode.Uri.file(homeDir()),
      "Documents",
      `sql-editor-tool-settings-${today}.json`,
    ),
    filters: { 設定: ["json"] },
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(
    target,
    new TextEncoder().encode(JSON.stringify(data, null, 2)),
  );
  const answer = await vscode.window.showInformationMessage(
    `設定を書き出しました（接続 ${data.connections.length} 件、.sql ごとの設定 ${fileUris(data).length} 件、列の設定 ${Object.keys(data.tableSettings).length} 件、差分カメラ ${data.diffCameras.length} 件）。パスワードは入れていません。入力欄に入れた値は入っています`,
    "フォルダを開く",
  );
  if (answer) await vscode.commands.executeCommand("revealFileInOS", target);
}

export async function importSettings(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  /** 読み込んだ後（差分カメラの一覧を出し直す） */
  onImported?: () => void,
): Promise<void> {
  const [picked] =
    (await vscode.window.showOpenDialog({
      title: "設定を読み込む（別の PC で書き出したもの）",
      openLabel: "読み込む",
      canSelectMany: false,
      filters: { 設定: ["json"] },
    })) ?? [];
  if (!picked) return;
  let data: SettingsExport;
  try {
    const text = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(picked),
    );
    data = parseSettingsExport(JSON.parse(text));
  } catch (error) {
    void vscode.window.showErrorMessage(
      `設定を読み込めませんでした：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  // .sql の置き場所が違えば、フォルダを付け替える
  const folder = commonFolder(fileUris(data));
  if (folder && !(await exists(vscode.Uri.parse(folder)))) {
    const shown = vscode.Uri.parse(folder).fsPath;
    const answer = await vscode.window.showInformationMessage(
      `書き出した PC では、.sql が「${shown}」の下にありました。この PC にはこのフォルダがありません。この PC では、どのフォルダに当たりますか？`,
      { modal: true },
      "フォルダを選ぶ",
      "そのまま読み込む",
    );
    if (answer === undefined) return;
    if (answer === "フォルダを選ぶ") {
      const [target] =
        (await vscode.window.showOpenDialog({
          title: `「${shown}」に当たるフォルダ`,
          openLabel: "このフォルダにする",
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
        })) ?? [];
      if (!target) return;
      data = remapFolders(data, folder, target.toString());
    }
  }

  const state = context.globalState;
  const merge = async (key: string, imported: Record<string, unknown>) => {
    await state.update(key, {
      ...state.get<Record<string, unknown>>(key, {}),
      ...imported,
    });
  };
  await merge(STATE_KEYS.fileConnections, data.fileConnections);
  await merge(STATE_KEYS.paramSettings, data.paramSettings);
  await merge(STATE_KEYS.formValues, data.formValues);
  await merge(STATE_KEYS.tableSettings, data.tableSettings);
  // 差分カメラは ID で合わせる（同じ ID は読み込んだもので置き換える）
  const cameras = state.get<Record<string, unknown>[]>(
    STATE_KEYS.diffCameras,
    [],
  );
  const importedIds = new Set(data.diffCameras.map((c) => c.id));
  await state.update(STATE_KEYS.diffCameras, [
    ...cameras.filter((c) => !importedIds.has(c.id)),
    ...data.diffCameras,
  ]);

  // 接続は、同じ名前のものがなければ足す（パスワードは初めてつなぐときに聞く）
  const names = new Set(store.list().map((p) => p.name));
  const added: string[] = [];
  for (const profile of data.connections) {
    const name = String(profile.name);
    if (names.has(name)) continue;
    await store.add(
      { ...profile, id: randomUUID() } as ConnectionProfile,
      null,
    );
    names.add(name);
    added.push(name);
  }

  const config = vscode.workspace.getConfiguration(SECTION);
  const known = new Set(Object.keys(userSettingsSchema(context)));
  for (const [key, value] of Object.entries(data.settings)) {
    if (known.has(key)) {
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    }
  }

  void vscode.window.showInformationMessage(
    [
      `設定を読み込みました：接続 ${added.length} 件${added.length > 0 ? `（${added.join("、")}。パスワードは初めてつなぐときに入力してください）` : ""}`,
      `.sql ごとの設定 ${fileUris(data).length} 件`,
      `列の設定 ${Object.keys(data.tableSettings).length} 件`,
      `差分カメラ ${data.diffCameras.length} 件`,
    ].join("、"),
  );
  onImported?.();
}

/** 拡張の設定のうち、利用者が自分で変えたもの（ユーザーの設定） */
function userSettings(
  context: vscode.ExtensionContext,
): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(userSettingsSchema(context))) {
    const value = config.inspect(key)?.globalValue;
    if (value !== undefined) values[key] = value;
  }
  return values;
}

/** package.json の設定の一覧（sqlEditorTool. を除いた名前） */
function userSettingsSchema(
  context: vscode.ExtensionContext,
): Record<string, unknown> {
  const properties: Record<string, unknown> =
    context.extension.packageJSON?.contributes?.configuration?.properties ?? {};
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key.slice(SECTION.length + 1),
      value,
    ]),
  );
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? "/";
}
