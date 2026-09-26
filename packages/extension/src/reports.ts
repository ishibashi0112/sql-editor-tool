// レポートの保存先（レポートのフォルダ）と呼び出し（D-29、docs/handover.md §16）。
// レポートは .sql ファイル。フォルダを 1 か所にまとめ、一覧・最近使ったもの・新規作成をここで扱う

import * as vscode from "vscode";

const FOLDER_SETTING = "reports.folder";
const RECENT_KEY = "sqlEditorTool.recentReports";
const RECENT_MAX = 20;

export type ReportFile = {
  uri: vscode.Uri;
  /** ファイル名（.sql を除く） */
  name: string;
  /** レポートのフォルダからの相対のフォルダ（直下なら空） */
  folder: string;
};

/** 設定されたレポートのフォルダ。なければ undefined */
export function reportsFolder(): vscode.Uri | undefined {
  const path = vscode.workspace
    .getConfiguration("sqlEditorTool")
    .get<string>(FOLDER_SETTING, "")
    .trim();
  return path ? vscode.Uri.file(path) : undefined;
}

/** レポートのフォルダを選んで設定に保存する。選ばなければ undefined */
export async function chooseReportsFolder(): Promise<vscode.Uri | undefined> {
  const current = reportsFolder();
  const picked = await vscode.window.showOpenDialog({
    title: "レポートを保存するフォルダを選んでください",
    openLabel: "このフォルダにする",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    // 初めは「ドキュメント」を候補にする
    defaultUri:
      current ?? vscode.Uri.joinPath(vscode.Uri.file(homeDir()), "Documents"),
  });
  const folder = picked?.[0];
  if (!folder) return undefined;
  await vscode.workspace
    .getConfiguration("sqlEditorTool")
    .update(FOLDER_SETTING, folder.fsPath, vscode.ConfigurationTarget.Global);
  return folder;
}

/** レポートのフォルダ。まだ決めていなければ選んでもらう */
export async function ensureReportsFolder(): Promise<vscode.Uri | undefined> {
  return reportsFolder() ?? (await chooseReportsFolder());
}

/** フォルダの中の .sql（サブフォルダも含む）。フォルダがなければ空 */
export async function listReports(root: vscode.Uri): Promise<ReportFile[]> {
  const found: ReportFile[] = [];
  const walk = async (dir: vscode.Uri, rel: string[]) => {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      if (name.startsWith(".")) continue;
      const uri = vscode.Uri.joinPath(dir, name);
      if (type & vscode.FileType.Directory) {
        await walk(uri, [...rel, name]);
      } else if (name.toLowerCase().endsWith(".sql")) {
        found.push({ uri, name: reportName(uri), folder: rel.join("/") });
      }
    }
  };
  await walk(root, []);
  return found;
}

/** ファイル名から .sql を除いた名前 */
export function reportName(uri: vscode.Uri): string {
  const base = uri.path.split("/").pop() ?? "";
  return base.replace(/\.sql$/i, "");
}

/** 最近開いたレポート（新しい順） */
export class RecentReports {
  constructor(private readonly state: vscode.Memento) {}

  list(): string[] {
    return this.state.get<string[]>(RECENT_KEY, []);
  }

  async add(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const next = [key, ...this.list().filter((k) => k !== key)].slice(
      0,
      RECENT_MAX,
    );
    await this.state.update(RECENT_KEY, next);
  }
}

const TEMPLATE = `-- :名前 と書いたところが、フォームの入力欄になります（例：WHERE 受注日 >= :開始日）
-- 入力欄の表示名や種類（日付・数値など）は、レポートの画面の「⚙ 入力欄」で設定します
SELECT *
FROM `;

/** 新しいレポートを作る（名前を聞き、テンプレートの .sql を作る）。作らなければ undefined */
export async function createReport(): Promise<vscode.Uri | undefined> {
  const folder = await ensureReportsFolder();
  if (!folder) return undefined;
  const name = await vscode.window.showInputBox({
    title: "新しいレポート：名前",
    prompt:
      "ファイル名になります。「/」で区切ると、サブフォルダに作ります（例：受注/受注一覧）",
    ignoreFocusOut: true,
    validateInput: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return "名前を入力してください";
      if (/[\\:*?"<>|]/.test(trimmed)) {
        return '名前に \\ : * ? " < > | は使えません';
      }
      return undefined;
    },
  });
  if (name === undefined) return undefined;
  const parts = name
    .trim()
    .replace(/\.sql$/i, "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  const uri = vscode.Uri.joinPath(
    folder,
    ...parts.slice(0, -1),
    `${parts.at(-1)}.sql`,
  );
  try {
    await vscode.workspace.fs.stat(uri);
    void vscode.window.showErrorMessage(`「${name}」はすでにあります`);
    return undefined;
  } catch {
    // まだない
  }
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(TEMPLATE));
  return uri;
}

function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? "/";
}
