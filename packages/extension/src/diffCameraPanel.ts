// 差分カメラ（D-47）：サイドバーの「差分カメラ」（Webview のビュー）と、差分のタブ（エディタの Webview）。
// 撮る・比べるは host の DiffCameraController。ここは VS Code の画面の操作（表を選ぶ・条件を聞くなど）と保存

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { sanitizeTableSettings, type TableRef } from "@sql-editor-tool/core";
import {
  type CameraTable,
  DEFAULT_SHOT_MAX_ROWS,
  type DiffCamera,
  DiffCameraController,
  type DiffView,
  type FromCameraView,
  type FromDiffView,
  type SchemaObject,
  type SheetRow,
} from "@sql-editor-tool/host";
import * as vscode from "vscode";
import type { ConnectionProfile, ConnectionStore } from "./connections";
import { tableSettingsKey } from "./dataViewPanel";
import { sheetXlsx } from "./excelSheet";
import { STATE_KEYS } from "./fileSettings";
import type { SessionManager } from "./sessions";
import { dialectOf, type SqlEditing } from "./sqlEditing";

export const DIFF_CAMERA_VIEW_ID = "sqlEditorTool.diffCamera";

/** 「Excel で保存」で最後に保存したフォルダ（PC ごと。設定の書き出しには入れない） */
const SAVE_DIR_KEY = "sqlEditorTool.diffCamera.saveDir";

export type DiffCameraPanelDeps = {
  extensionUri: vscode.Uri;
  store: ConnectionStore;
  sessions: SessionManager;
  editing: SqlEditing;
  state: vscode.Memento;
  output: vscode.LogOutputChannel;
};

export class DiffCameraPanel
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined;
  private readonly controller: DiffCameraController;
  /** カメラの ID → 差分のタブ */
  private readonly diffPanels = new Map<string, vscode.WebviewPanel>();
  /** 接続名 → 「スキーマ\0表」→ 論理名（接続を開いているときに取る。起動しただけでは接続しない） */
  private readonly logicalNames = new Map<string, Map<string, string>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: DiffCameraPanelDeps) {
    const { state } = deps;
    this.controller = new DiffCameraController({
      load: () => sanitizeCameras(state.get(STATE_KEYS.diffCameras, [])),
      save: async (cameras) => {
        await state.update(STATE_KEYS.diffCameras, cameras);
      },
      openSession: async (connection) => {
        const profile = this.profile(connection);
        const session = await deps.sessions.get(profile);
        // 撮るときには接続しているので、論理名も取っておく
        void this.loadLogicalNames(connection);
        return { session, dialect: dialectOf(profile) };
      },
      keyColumns: (connection, table) => {
        const all = state.get<Record<string, unknown>>(
          STATE_KEYS.tableSettings,
          {},
        );
        const key = tableSettingsKey(connection, table);
        return Object.hasOwn(all, key)
          ? sanitizeTableSettings(all[key]).keyColumns
          : undefined;
      },
      logicalName: (connection, table) =>
        this.logicalNames.get(connection)?.get(nameKey(table)),
      maxRows: () =>
        vscode.workspace
          .getConfiguration("sqlEditorTool")
          .get<number>("diffCamera.maxRows", DEFAULT_SHOT_MAX_ROWS),
      dialect: (connection) => dialectOf(this.findProfile(connection)),
      askName: (current) => this.askName(current),
      chooseConnection: () => this.chooseConnection(),
      pickTables: (connection, current) => this.pickTables(connection, current),
      confirmDelete: async (name) =>
        (await vscode.window.showWarningMessage(
          `差分カメラ「${name}」を消しますか？（撮ったものも消えます）`,
          { modal: true },
          "消す",
        )) === "消す",
      postView: (message) => void this.view?.webview.postMessage(message),
      showDiff: (id, view) => this.showDiff(id, view),
      diffBusy: (id, busy) =>
        void this.diffPanels
          .get(id)
          ?.webview.postMessage({ type: "busy", busy }),
      copyText: async (text) => {
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage("差分をコピーしました", 3000);
      },
      saveExcel: (fileName, rows) => this.saveExcel(fileName, rows),
      showStatus: (message) =>
        void vscode.window.setStatusBarMessage(message, 4000),
      showMessage: (message, kind) =>
        void (kind === "error"
          ? vscode.window.showWarningMessage(message)
          : vscode.window.showInformationMessage(message)),
      log: (message) => deps.output.info(message),
    });
    this.disposables.push(
      vscode.commands.registerCommand(
        "sqlEditorTool.diffCamera.create",
        async () => {
          // コマンドパレットから作ったときも、作ったカメラが見えるように
          await vscode.commands.executeCommand(`${DIFF_CAMERA_VIEW_ID}.focus`);
          await this.controller.handle({ type: "create" });
        },
      ),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const root = webviewRoot(this.deps.extensionUri);
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = html(view.webview, root, "camera");
    view.webview.onDidReceiveMessage((message: FromCameraView) => {
      if (message.type === "ready") {
        // 開いている接続のカメラは、表の論理名を出す
        for (const camera of sanitizeCameras(
          this.deps.state.get(STATE_KEYS.diffCameras, []),
        )) {
          const profile = this.findProfile(camera.connection);
          if (profile && this.deps.sessions.isOpen(profile.id)) {
            void this.loadLogicalNames(camera.connection);
          }
        }
      }
      this.run(this.controller.handle(message));
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  /** 設定を読み込んだとき（カメラが増えた・変わった） */
  reload(): void {
    this.controller.reload();
  }

  dispose(): void {
    for (const panel of this.diffPanels.values()) panel.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  private run(promise: Promise<void>): void {
    promise.catch((error: unknown) => {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  private showDiff(id: string, view: DiffView): void {
    let panel = this.diffPanels.get(id);
    if (panel) {
      panel.title = `差分：${view.camera}`;
      panel.reveal(undefined, true);
      void panel.webview.postMessage({ type: "view", view });
      return;
    }
    const root = webviewRoot(this.deps.extensionUri);
    panel = vscode.window.createWebviewPanel(
      "sqlEditorTool.diff",
      `差分：${view.camera}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // 「後」を撮り直すまで、同じ差分を出し続ける
        retainContextWhenHidden: true,
        localResourceRoots: [root],
      },
    );
    this.diffPanels.set(id, panel);
    const created = panel;
    created.webview.html = html(created.webview, root, "diff");
    created.webview.onDidReceiveMessage((message: FromDiffView) =>
      this.run(this.controller.handleDiff(id, message)),
    );
    created.onDidDispose(() => {
      if (this.diffPanels.get(id) === created) this.diffPanels.delete(id);
    });
  }

  private profile(connection: string): ConnectionProfile {
    const profile = this.findProfile(connection);
    if (!profile) {
      throw new Error(
        `接続「${connection}」がありません（接続の名前を変えた・消したときは、カメラを作り直してください）`,
      );
    }
    return profile;
  }

  private findProfile(connection: string): ConnectionProfile | undefined {
    return this.deps.store.list().find((p) => p.name === connection);
  }

  private async objects(connection: string): Promise<SchemaObject[]> {
    const objects = await this.deps.editing
      .cacheFor(this.profile(connection))
      .objects();
    this.setLogicalNames(connection, objects);
    return objects;
  }

  private async loadLogicalNames(connection: string): Promise<void> {
    if (this.logicalNames.has(connection)) return;
    try {
      await this.objects(connection);
      this.controller.reload();
    } catch {
      // 論理名がなくても使える
    }
  }

  private setLogicalNames(connection: string, objects: SchemaObject[]): void {
    const names = new Map<string, string>();
    for (const o of objects) {
      if (o.logicalName) names.set(nameKey(o), o.logicalName);
    }
    this.logicalNames.set(connection, names);
  }

  private async askName(current?: string): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({
      title: current ? "カメラの名前を変える" : "差分カメラを作る（1/3）：名前",
      prompt: "何を確かめるカメラか（例：受注登録の確認）",
      value: current ?? "",
      validateInput: (value) =>
        value.trim() === "" ? "名前を入れてください" : undefined,
    });
    return name?.trim() || undefined;
  }

  private async chooseConnection(): Promise<string | undefined> {
    const profiles = this.deps.store.list();
    if (profiles.length === 0) {
      void vscode.window.showWarningMessage(
        "接続がありません。サイドバーの「接続」で接続を追加してください",
      );
      return undefined;
    }
    if (profiles.length === 1) return profiles[0]?.name;
    const picked = await vscode.window.showQuickPick(
      profiles.map((p) => ({ label: p.name })),
      { title: "差分カメラを作る（1/3）：撮る DB の接続" },
    );
    return picked?.label;
  }

  private async pickTables(
    connection: string,
    current: readonly TableRef[],
  ): Promise<TableRef[] | undefined> {
    const quickPick = vscode.window.createQuickPick<
      vscode.QuickPickItem & { table: TableRef }
    >();
    quickPick.title =
      "見る表を選ぶ（論理名でも探せます。選び終わったら Enter）";
    quickPick.placeholder = "表の名前か論理名の一部";
    quickPick.canSelectMany = true;
    quickPick.matchOnDescription = true;
    quickPick.busy = true;
    quickPick.show();
    try {
      const objects = await this.objects(connection);
      const same = (a: TableRef, b: TableRef) =>
        a.schema === b.schema && a.name === b.name;
      const items = objects.map((o) => ({
        label: `${o.schema}.${o.name}`,
        description: [o.logicalName, o.kind === "view" ? "ビュー" : ""]
          .filter(Boolean)
          .join("　"),
        table: { schema: o.schema, name: o.name },
      }));
      // 選んである表を上に
      items.sort(
        (a, b) =>
          Number(current.some((t) => same(t, b.table))) -
          Number(current.some((t) => same(t, a.table))),
      );
      quickPick.items = items;
      quickPick.selectedItems = items.filter((i) =>
        current.some((t) => same(t, i.table)),
      );
      quickPick.busy = false;
    } catch (error) {
      quickPick.hide();
      throw error;
    }
    return new Promise((resolve) => {
      let done = false;
      quickPick.onDidAccept(() => {
        done = true;
        resolve(quickPick.selectedItems.map((i) => i.table));
        quickPick.hide();
      });
      quickPick.onDidHide(() => {
        if (!done) resolve(undefined);
        quickPick.dispose();
      });
    });
  }

  private async saveExcel(fileName: string, rows: SheetRow[]): Promise<void> {
    const dir = this.deps.state.get<string>(SAVE_DIR_KEY) ?? homedir();
    const uri = await vscode.window.showSaveDialog({
      title: "差分を Excel で保存",
      defaultUri: vscode.Uri.joinPath(vscode.Uri.file(dir), fileName),
      filters: { Excel: ["xlsx"] },
    });
    if (!uri) return;
    const data = await sheetXlsx(rows);
    await vscode.workspace.fs.writeFile(uri, data);
    await this.deps.state.update(
      SAVE_DIR_KEY,
      vscode.Uri.joinPath(uri, "..").fsPath,
    );
    this.deps.output.info(`差分を Excel で保存しました：${uri.fsPath}`);
    const answer = await vscode.window.showInformationMessage(
      `保存しました：${uri.fsPath}`,
      "開く",
      "フォルダを開く",
    );
    if (answer === "開く") await vscode.env.openExternal(uri);
    else if (answer === "フォルダを開く")
      await vscode.commands.executeCommand("revealFileInOS", uri);
  }
}

function nameKey(table: TableRef): string {
  return `${table.schema}\u0000${table.name}`;
}

/** 覚えたカメラを確かめる（形の違うものは捨てる） */
export function sanitizeCameras(value: unknown): DiffCamera[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): DiffCamera[] => {
    if (typeof item !== "object" || item === null) return [];
    const { id, name, connection, tables } = item as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      typeof connection !== "string" ||
      !Array.isArray(tables)
    ) {
      return [];
    }
    return [
      {
        id,
        name,
        connection,
        tables: tables.flatMap((t): CameraTable[] => {
          if (typeof t !== "object" || t === null) return [];
          const { schema, name: table, where } = t as Record<string, unknown>;
          if (typeof schema !== "string" || typeof table !== "string")
            return [];
          return [
            {
              schema,
              name: table,
              ...(typeof where === "string" && where.trim() !== ""
                ? { where }
                : {}),
            },
          ];
        }),
      },
    ];
  });
}

function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, "dist", "webview");
}

function html(
  webview: vscode.Webview,
  root: vscode.Uri,
  entry: "camera" | "diff",
): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, `${entry}.js`));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, `${entry}.css`));
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource}`,
  ].join("; ");
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${style}" />
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}
