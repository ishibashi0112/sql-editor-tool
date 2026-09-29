// テーブルから SQL を生成する（D-49。A5:SQL Mk-2 の「SQL の生成」をまねる）。SELECT・INSERT・UPDATE・DELETE。
// 接続のツリー・テーブル検索の右クリック（「SQL を生成 ▸ 種類」。コマンドパレットからは表の後に種類を選ぶ）では、
// 新しいエディタに開く。.sql の右クリックでは、表を選んでカーソルの位置に入れる。
// 開いたエディタには、表の接続を覚える（補完・論理名、SELECT は Ctrl+Enter ですぐ実行できる）。
// SELECT は主キーの入力欄に論理名と種類を付けておく。INSERT・UPDATE・DELETE はこのツールでは実行しない（読み取り専用）

import {
  applyTableSettings,
  DEFAULT_GENERATE_LAYOUT,
  DEFAULT_GENERATE_OPTIONS,
  GENERATE_OPTION_KEYS,
  type GeneratedParam,
  type GenerateKind,
  type GenerateLayout,
  type GenerateOptions,
  generatedTitle,
  generateSql,
  getDialect,
  paramTypeForColumn,
  type ReportParamConfig,
  sanitizeTableSettings,
  type TableRef,
} from "@sql-editor-tool/core";
import type { TableDescription } from "@sql-editor-tool/host";
import * as vscode from "vscode";
import type { ConnectionProfile, ConnectionStore } from "./connections";
import { tableSettingsKey } from "./dataViewPanel";
import { addParamSettings, forgetFileState, STATE_KEYS } from "./fileSettings";
import { dialectOf, isSqlDocument, type SqlEditing } from "./sqlEditing";
import { formatSettings } from "./sqlFormatting";
import { describe, type TreeNode } from "./tree";

/** 生成する表 */
type Target = {
  profile: ConnectionProfile;
  table: TableRef;
  logicalName?: string | undefined;
};

/** テーブル検索（Webview）の結果の行の右クリックで渡るもの（data-vscode-context） */
type SearchContext = {
  webviewSection: "object";
  connectionId: string;
  schema: string;
  name: string;
  logicalName?: string;
};

/** 生成した SQL をどこに出すか */
type Output = "editor" | "cursor";

type OptionItem = vscode.QuickPickItem & { key: keyof GenerateOptions };

const KINDS: readonly GenerateKind[] = ["select", "insert", "update", "delete"];

/** 種類の名前（メニュー・一覧の見出し） */
const KIND_LABELS: Record<GenerateKind, string> = {
  select: "SELECT",
  insert: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
};

/** 種類の説明（コマンドパレットから選ぶときの一覧） */
const KIND_DESCRIPTIONS: Record<GenerateKind, string> = {
  select: "取り出す（主キーで絞ると、実行したときに入力欄になります）",
  insert: "行を足す（このツールでは実行しません）",
  update: "主キーの行を変える（このツールでは実行しません）",
  delete: "主キーの行を消す（このツールでは実行しません）",
};

const COPY_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("copy"),
  tooltip: "クリップボードにコピー",
};

export class SqlGeneration implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly deps: {
      store: ConnectionStore;
      editing: SqlEditing;
      state: vscode.Memento;
    },
  ) {
    this.disposables.push(
      // コマンドパレット：表の後に種類を選ぶ
      vscode.commands.registerCommand(
        "sqlEditorTool.generateSql",
        (arg?: unknown) => this.run(() => this.generateNew(arg, undefined)),
      ),
      vscode.commands.registerCommand("sqlEditorTool.generateSqlHere", () =>
        this.run(() => this.generateHere(undefined)),
      ),
      // 右クリックの「SQL を生成 ▸ 種類」
      ...KINDS.flatMap((kind) => [
        vscode.commands.registerCommand(
          `sqlEditorTool.generateSql.${kind}`,
          (arg?: unknown) => this.run(() => this.generateNew(arg, kind)),
        ),
        vscode.commands.registerCommand(
          `sqlEditorTool.generateSqlHere.${kind}`,
          () => this.run(() => this.generateHere(kind)),
        ),
      ]),
    );
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      void vscode.window.showErrorMessage(
        `SQL を生成できませんでした：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * ツリー・テーブル検索の右クリック（表が決まっている）か、コマンドパレット（接続と表を選ぶ）から、新しいエディタに。
   * kind がなければ選ぶ
   */
  private async generateNew(
    arg: unknown,
    kind: GenerateKind | undefined,
  ): Promise<void> {
    const target = this.targetOf(arg) ?? (await this.chooseTarget(kind));
    if (!target) return;
    const chosen = kind ?? (await this.pickKind(target));
    if (chosen) await this.generate(target, chosen, "editor");
  }

  /** .sql の右クリック：その .sql の接続の表を選び、カーソルの位置に入れる */
  private async generateHere(kind: GenerateKind | undefined): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSqlDocument(editor.document)) return;
    let { profile } = this.deps.editing.connectionFor(editor.document);
    if (!profile) {
      if (!(await this.deps.editing.choose(editor.document))) return;
      profile = this.deps.editing.connectionFor(editor.document).profile;
      if (!profile) return;
    }
    const picked = await this.pickTable(profile, kind);
    if (!picked) return;
    const target = { profile, ...picked };
    const chosen = kind ?? (await this.pickKind(target));
    if (chosen) await this.generate(target, chosen, "cursor", editor);
  }

  /** 種類を選ぶ（前に選んだ種類から始める） */
  private async pickKind(target: Target): Promise<GenerateKind | undefined> {
    const last = this.deps.state.get<string>(STATE_KEYS.generateSqlKind);
    type KindItem = vscode.QuickPickItem & { sqlKind: GenerateKind };
    const items: KindItem[] = KINDS.map((kind) => ({
      label: KIND_LABELS[kind],
      description: KIND_DESCRIPTIONS[kind],
      sqlKind: kind,
    }));
    const quickPick = vscode.window.createQuickPick<KindItem>();
    quickPick.title = `SQL を生成：${generatedTitle(target)}`;
    quickPick.placeholder = "作る SQL の種類";
    quickPick.items = items;
    quickPick.activeItems = items.filter((item) => item.sqlKind === last);
    return runQuickPick(
      quickPick,
      async () => {},
      () => quickPick.selectedItems[0]?.sqlKind,
    );
  }

  private targetOf(arg: unknown): Target | undefined {
    if (!isObject(arg)) return undefined;
    // 接続のツリーの表・ビュー
    if (arg.kind === "object") {
      const node = arg as TreeNode & { kind: "object" };
      return {
        profile: node.profile,
        table: node.table,
        logicalName: node.logicalName,
      };
    }
    // テーブル検索の結果の行
    if (arg.webviewSection === "object") {
      const context = arg as SearchContext;
      const profile = this.deps.store.get(context.connectionId);
      if (!profile) return undefined;
      return {
        profile,
        table: { schema: context.schema, name: context.name },
        logicalName: context.logicalName,
      };
    }
    return undefined;
  }

  /** コマンドパレットから：接続（1 つならそれ）と表を選ぶ */
  private async chooseTarget(
    kind: GenerateKind | undefined,
  ): Promise<Target | undefined> {
    const profiles = this.deps.store.list();
    if (profiles.length === 0) {
      void vscode.window.showWarningMessage(
        "接続がありません。サイドバーの「接続」で接続を追加してください",
      );
      return undefined;
    }
    let profile = profiles.length === 1 ? profiles[0] : undefined;
    if (!profile) {
      const picked = await vscode.window.showQuickPick(
        profiles.map((p) => ({ label: p.name, description: describe(p), p })),
        { title: "SQL を生成：どの接続の表ですか" },
      );
      profile = picked?.p;
    }
    if (!profile) return undefined;
    const picked = await this.pickTable(profile, kind);
    return picked ? { profile, ...picked } : undefined;
  }

  /** 表を選ぶ（論理名でも探せる） */
  private pickTable(
    profile: ConnectionProfile,
    kind: GenerateKind | undefined,
  ): Promise<Omit<Target, "profile"> | undefined> {
    const quickPick = vscode.window.createQuickPick<
      vscode.QuickPickItem & Omit<Target, "profile">
    >();
    quickPick.title = `${kind ? KIND_LABELS[kind] : "SQL"} を生成：表を選ぶ（${profile.name}）`;
    quickPick.placeholder = "表の名前か論理名の一部";
    quickPick.matchOnDescription = true;
    return runQuickPick(
      quickPick,
      async () => {
        const objects = await this.deps.editing.cacheFor(profile).objects();
        quickPick.items = objects.map((o) => ({
          label: `${o.schema}.${o.name}`,
          description: [o.logicalName, o.kind === "view" ? "ビュー" : ""]
            .filter(Boolean)
            .join("　"),
          table: { schema: o.schema, name: o.name },
          logicalName: o.logicalName,
        }));
      },
      () => {
        const [item] = quickPick.selectedItems;
        return item
          ? { table: item.table, logicalName: item.logicalName }
          : undefined;
      },
    );
  }

  private async generate(
    target: Target,
    kind: GenerateKind,
    output: Output,
    editor?: vscode.TextEditor,
  ): Promise<void> {
    const picked = await this.pickOptions(target, kind, output);
    if (!picked) return;
    const { description, options, copy } = picked;
    await this.deps.state.update(STATE_KEYS.generateSqlOptions, options);
    await this.deps.state.update(STATE_KEYS.generateSqlKind, kind);
    const { profile, table } = target;
    const keys = this.keysOf(profile, table, description);
    const { sql, params } = generateSql(
      getDialect(dialectOf(profile)),
      kind,
      {
        table,
        logicalName: target.logicalName,
        // yyyymmdd の日付にした列（D-36）は、入力欄も日付にする
        columns: this.columnsOf(profile, table, description),
        keys,
      },
      options,
      layoutFor(output === "cursor" ? editor : undefined),
    );
    // 入力欄の設定は、実行できる SELECT だけ
    const presets = kind === "select" ? paramPresets(params) : {};
    const run = process.platform === "darwin" ? "Cmd+Enter" : "Ctrl+Enter";
    const hint =
      kind !== "select"
        ? "このツールは読み取り専用なので実行しません。A5 やプログラムに貼って使ってください"
        : params.length > 0
          ? `${run} で実行（${params.map((p) => p.column.logicalName ?? p.name).join("・")}は入力欄に）`
          : `${run} で実行`;
    const what = KIND_LABELS[kind];

    if (copy) {
      await vscode.env.clipboard.writeText(sql);
      void vscode.window.setStatusBarMessage(`${what} をコピーしました`, 4000);
      return;
    }
    if (output === "cursor" && editor) {
      const { document, selection } = editor;
      // 行の途中なら、次の行から入れる
      const before = document
        .lineAt(selection.start.line)
        .text.slice(0, selection.start.character);
      const text = before.trim() === "" ? sql : `\n${sql}`;
      const done = await editor.edit((edit) => edit.replace(selection, text));
      if (!done) return;
      await addParamSettings(this.deps.state, document.uri.toString(), presets);
      void vscode.window.setStatusBarMessage(
        `${what} を入れました。${hint}`,
        8000,
      );
      return;
    }
    const document = await vscode.workspace.openTextDocument({
      language: "sql",
      content: sql,
    });
    const uri = document.uri.toString();
    // 同じ名前（Untitled-1 など）で前に覚えたものは、別のファイルのもの
    await forgetFileState(this.deps.state, uri);
    await addParamSettings(this.deps.state, uri, presets);
    await this.deps.editing.setConnection(document, profile.name);
    await vscode.window.showTextDocument(document, { preview: false });
    void vscode.window.setStatusBarMessage(
      `${what} を生成しました。${hint}`,
      8000,
    );
  }

  /** 付けるものを選ぶ（前に選んだものから始める）。列を読み込む間も画面を出しておく */
  private pickOptions(
    target: Target,
    kind: GenerateKind,
    output: Output,
  ): Promise<
    | {
        description: TableDescription;
        options: GenerateOptions;
        copy: boolean;
      }
    | undefined
  > {
    const { profile, table } = target;
    const quickPick = vscode.window.createQuickPick<OptionItem>();
    quickPick.title = `${KIND_LABELS[kind]} を生成：${generatedTitle(target)}`;
    const where =
      output === "cursor"
        ? "カーソルの位置に入れます"
        : "新しいエディタに開きます";
    quickPick.placeholder = `付けるものを選んで Enter（${where}）`;
    quickPick.canSelectMany = true;
    quickPick.buttons = [COPY_BUTTON];
    const saved: GenerateOptions = {
      ...DEFAULT_GENERATE_OPTIONS,
      ...this.deps.state.get<Partial<GenerateOptions>>(
        STATE_KEYS.generateSqlOptions,
        {},
      ),
    };
    let description: TableDescription | undefined;
    return runQuickPick(
      quickPick,
      async () => {
        description = await this.deps.editing.cacheFor(profile).describe(table);
        const shown = new Set(GENERATE_OPTION_KEYS[kind]);
        quickPick.items = this.optionItems(target, description).filter((item) =>
          shown.has(item.key),
        );
        quickPick.selectedItems = quickPick.items.filter(
          (item) => saved[item.key],
        );
        // UPDATE・DELETE でキーがなければ、全部の行を変えないよう WHERE を空けておく
        if (
          (kind === "update" || kind === "delete") &&
          this.keysOf(profile, table, description).length === 0
        ) {
          quickPick.placeholder = `主キーがないので、WHERE の条件は書いてください。付けるものを選んで Enter（${where}）`;
        }
      },
      (copy) => {
        if (!description) return undefined;
        const chosen = new Set(quickPick.selectedItems.map((i) => i.key));
        // この種類で出していないものは、前に選んだまま
        const pick = (key: keyof GenerateOptions) =>
          quickPick.items.some((i) => i.key === key)
            ? chosen.has(key)
            : saved[key];
        return {
          description,
          options: {
            title: pick("title"),
            whereKeys: pick("whereKeys"),
            orderByKeys: pick("orderByKeys"),
            comments: pick("comments"),
            qualifySchema: pick("qualifySchema"),
          },
          copy,
        };
      },
    );
  }

  /** 付けるものの一覧。右に、この表で付く中身の例を出す */
  private optionItems(
    target: Target,
    description: TableDescription,
  ): OptionItem[] {
    const { profile, table } = target;
    const keys = this.keysOf(profile, table, description);
    const keyWord = description.primaryKey.length > 0 ? "主キー" : "キー";
    const named = description.columns.find((c) => c.logicalName);
    // 列に論理名がなくても、表に論理名があれば表の行に付く
    const commentExample = named
      ? `${named.name}  -- ${named.logicalName}`
      : target.logicalName
        ? `${table.name}  -- ${target.logicalName}`
        : undefined;
    return [
      {
        key: "title",
        label: "先頭に表の名前",
        description: `-- ${generatedTitle(target)}（エディタのタブの名前になります）`,
      },
      {
        key: "whereKeys",
        label: `${keyWord}で絞る`,
        description:
          keys.length > 0
            ? `WHERE ${keys.map((k) => `${k} = :${k}`).join(" AND ")}（実行すると入力欄になります）`
            : "主キーがないので付きません（データを開いて「⚙ 列」でキーを決めると付きます）",
      },
      {
        key: "orderByKeys",
        label: `${keyWord}の順に並べる`,
        description:
          keys.length > 0
            ? `ORDER BY ${keys.join(", ")}`
            : "主キーがないので付きません",
      },
      {
        key: "comments",
        label: "論理名をコメントで付ける",
        description:
          commentExample ?? "論理名（DB のコメント）がないので付きません",
      },
      {
        key: "qualifySchema",
        label: "スキーマ名を付ける",
        description: `${table.schema}.${table.name}`,
      },
    ];
  }

  /** 列の設定（D-36）。接続名・スキーマ・表ごと */
  private settingsOf(profile: ConnectionProfile, table: TableRef) {
    const all = this.deps.state.get<Record<string, unknown>>(
      STATE_KEYS.tableSettings,
      {},
    );
    const key = tableSettingsKey(profile.name, table);
    return sanitizeTableSettings(Object.hasOwn(all, key) ? all[key] : {});
  }

  /** 主キー（主キーの順）。なければ列の設定のキー（表の列の順） */
  private keysOf(
    profile: ConnectionProfile,
    table: TableRef,
    description: TableDescription,
  ): string[] {
    if (description.primaryKey.length > 0) return description.primaryKey;
    const keys = new Set(this.settingsOf(profile, table).keyColumns ?? []);
    return description.columns
      .filter((c) => keys.has(c.name))
      .map((c) => c.name);
  }

  private columnsOf(
    profile: ConnectionProfile,
    table: TableRef,
    description: TableDescription,
  ) {
    return applyTableSettings(
      description.columns,
      description.primaryKey,
      this.settingsOf(profile, table),
    );
  }
}

/**
 * 生成する SQL の形。.sql の整形（D-45）と同じく、インデントはエディタの設定（入れる先のエディタ。新しいエディタなら
 * SQL の言語の設定）、AND の位置は整形の設定に合わせる（生成した SQL を整形しても形が変わらないように）
 */
function layoutFor(editor: vscode.TextEditor | undefined): GenerateLayout {
  const { logicalOperatorNewline, expressionWidth } = formatSettings();
  if (editor) {
    const { tabSize, insertSpaces } = editor.options;
    return {
      tabWidth:
        typeof tabSize === "number"
          ? tabSize
          : DEFAULT_GENERATE_LAYOUT.tabWidth,
      useTabs: insertSpaces === false,
      logicalOperatorNewline,
      expressionWidth,
    };
  }
  const config = vscode.workspace.getConfiguration("editor", {
    languageId: "sql",
  });
  return {
    tabWidth: config.get<number>("tabSize", DEFAULT_GENERATE_LAYOUT.tabWidth),
    useTabs: config.get<boolean>("insertSpaces", true) === false,
    logicalOperatorNewline,
    expressionWidth,
  };
}

/** 主キーの入力欄の表示名（論理名）と種類（列の型から） */
function paramPresets(
  params: readonly GeneratedParam[],
): Record<string, ReportParamConfig> {
  const presets: Record<string, ReportParamConfig> = {};
  for (const { name, column } of params) {
    const config: ReportParamConfig = {};
    if (column.logicalName) config.label = column.logicalName;
    const type = paramTypeForColumn(column);
    if (type) config.type = type;
    if (Object.keys(config).length > 0) presets[name] = config;
  }
  return presets;
}

/**
 * 一覧を出してから中身を読み込む（読み込む間は「読み込み中」の一覧を出しておく）。
 * 読み込む間に閉じても（Esc）コマンドが終わらずに残らないよう、閉じたときの処理を先に付ける。
 * accept は、選んだもの（copy はコピーのボタンで決めたとき）。undefined なら決めずにそのまま
 */
function runQuickPick<T extends vscode.QuickPickItem, R>(
  quickPick: vscode.QuickPick<T>,
  load: () => Promise<void>,
  accept: (copy: boolean) => R | undefined,
): Promise<R | undefined> {
  return new Promise((resolve, reject) => {
    let done = false;
    quickPick.onDidHide(() => {
      if (!done) {
        done = true;
        resolve(undefined);
      }
      quickPick.dispose();
    });
    const take = (copy: boolean) => {
      if (done || quickPick.busy) return;
      const result = accept(copy);
      if (result === undefined) return;
      done = true;
      resolve(result);
      quickPick.hide();
    };
    quickPick.onDidAccept(() => take(false));
    quickPick.onDidTriggerButton(() => take(true));
    quickPick.busy = true;
    quickPick.show();
    load().then(
      () => {
        if (!done) quickPick.busy = false;
      },
      (error: unknown) => {
        if (done) return;
        done = true;
        reject(error);
        quickPick.hide();
      },
    );
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
