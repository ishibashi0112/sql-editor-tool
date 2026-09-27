// 「SQL の結果」のパネルのホスト側の制御（D-41）。.sql を実行すると、ファイルごとにタブを作り、
// タブの中身はレポートの制御（ReportController）で動かす（:名前 のフォーム、画面での絞り込みと取り直し、論理名）。
// VS Code に依存しないので、ブラウザの開発用ページでも動かせる

import {
  type LogicalName,
  type ReportConfig,
  writeReportConfig,
} from "@sql-editor-tool/core";
import type { ReportFormValues } from "./reportProtocol";
import { type ReportConnection, ReportController } from "./reportView";
import type { FromResults, ResultTab, ToResults } from "./resultsProtocol";
import type { DbSession } from "./session";

/** 実行する文 */
export type RunStatement = {
  /** 文の SQL（区切りの ; は含まない） */
  sql: string;
  /** ファイルの中の位置（「SQL へ移動」で選ぶ範囲） */
  start: number;
  end: number;
  /** 文の始まりの行（0 から） */
  line: number;
};

export type RunRequest = {
  /** 結果をまとめる単位（.sql の URI）。同じ source の前の結果は、閉じて置き換える */
  source: string;
  /** タブに出す名前（ファイル名） */
  label: string;
  statements: RunStatement[];
  /** ファイルの先頭の設定のコメント（入力欄の表示名・種類など）。なければ null */
  config: ReportConfig | null;
  connection: ReportConnection | null;
};

export type ResultsDeps = {
  post(message: ToResults): void;
  /** source の接続を開く（まだ開いていなければ開く） */
  openSession(source: string): Promise<DbSession>;
  settings: { maxRows: number };
  copyText(text: string): Promise<void>;
  /** 入力欄に最初に入れる値（前回の値） */
  savedValues(source: string): ReportFormValues | undefined;
  saveValues(source: string, values: ReportFormValues): void;
  /** 入力欄の設定を VS Code の中に覚える（D-44）。覚えた後、拡張が update で新しい設定を渡す */
  saveConfig(source: string, config: ReportConfig): Promise<void>;
  /** エディタで、その文を選んで見せる */
  reveal(source: string, statement: RunStatement): void;
  chooseConnection(source: string): void;
  /** 結果の列の論理名（D-40） */
  describeColumns?(
    source: string,
    text: string,
    names: readonly string[],
  ): Promise<LogicalName[]>;
  /** 入力欄に値を入れてもらうため、パネルにフォーカスを移す */
  focus(): void;
  /** 今の時刻（相対の日付の既定値。テストで差し替える） */
  now?(): Date;
  /** 実行の経過を記録する（SQL の本文・入力した値・パスワードは渡さない） */
  log?(message: string): void;
  /**
   * タブの文の、今のエディタの中身（保存していない書き換えも。位置は shift で追っている）。
   * 結果のタブの「▶ 実行」は、実行したときの SQL ではなく、これで実行する（D-46）。分からなければ null
   */
  currentStatement?(
    source: string,
    statement: RunStatement,
  ): RunStatement | null;
};

/** 文書の書き換え（書き換える前の位置で。rangeOffset・rangeLength・text.length） */
export type TextChange = { offset: number; deleted: number; inserted: number };

type Tab = {
  info: ResultTab;
  source: string;
  statement: RunStatement;
  /** 入力欄の設定と接続（「▶ 実行」で SQL を読み直すときに使う） */
  config: ReportConfig | null;
  connection: ReportConnection | null;
  controller: ReportController;
  /** 画面のタブの準備ができたら実行する */
  pending: boolean;
};

/** タブの数の上限。超えたら古いものから閉じる（結果の行は画面が持つので、増えすぎないように） */
export const MAX_RESULT_TABS = 12;

export class ResultsController {
  private tabs: Tab[] = [];
  private active: string | null = null;
  private seq = 0;

  constructor(private readonly deps: ResultsDeps) {}

  /** 文を実行する。source の前の結果のタブは閉じ、同じ位置に新しいタブを作る */
  run(request: RunRequest): void {
    const at = this.tabs.findIndex((t) => t.source === request.source);
    for (const tab of this.tabs) {
      if (tab.source === request.source) tab.controller.dispose();
    }
    const kept = this.tabs.filter((t) => t.source !== request.source);
    const many = request.statements.length > 1;
    const created = request.statements.map((statement, i) =>
      this.createTab(request, statement, many ? i + 1 : null),
    );
    const index = at < 0 ? kept.length : at;
    this.tabs = [...kept.slice(0, index), ...created, ...kept.slice(index)];
    while (this.tabs.length > MAX_RESULT_TABS) {
      // 今作ったタブは残す
      const old = this.tabs.find((t) => !created.includes(t));
      if (!old) break;
      old.controller.dispose();
      this.tabs = this.tabs.filter((t) => t !== old);
    }
    this.active = created[0]?.info.id ?? this.active;
    this.postTabs();
  }

  /** ファイルの設定のコメントや接続が変わったとき（そのファイルのタブの入力欄と接続を作り直す） */
  update(
    source: string,
    config: ReportConfig | null,
    connection: ReportConnection | null,
  ): void {
    for (const tab of this.tabs) {
      if (tab.source !== source) continue;
      tab.config = config;
      tab.connection = connection;
      tab.controller.update(textOf(tab.statement, config), connection);
    }
  }

  /**
   * source の文書が書き換わったとき、タブの文の位置を追う（「▶ 実行」で今の SQL を読むため）。
   * 文の中と、文の終わりのすぐ後ろの書き換えは文に含め、文の前の書き換えは位置をずらす
   */
  shift(source: string, changes: readonly TextChange[]): void {
    // 後ろの書き換えから当てれば、前の書き換えの位置は変わらない
    const sorted = [...changes].sort((a, b) => b.offset - a.offset);
    for (const tab of this.tabs) {
      if (tab.source !== source) continue;
      let { start, end } = tab.statement;
      for (const { offset, deleted, inserted } of sorted) {
        const delta = inserted - deleted;
        if (offset > end) continue;
        if (offset + deleted <= start && offset < start) {
          // 文より前
          start += delta;
          end += delta;
        } else {
          // 文に掛かる（はみ出した分は、書き換えた範囲の端に寄せる）
          if (offset < start) start = offset;
          end = Math.max(start, Math.max(end, offset + deleted) + delta);
        }
      }
      tab.statement = { ...tab.statement, start, end };
    }
  }

  /** エディタで source を前に出したとき、そのファイルの結果のタブを前に出す */
  activate(source: string): void {
    const current = this.tabs.find((t) => t.info.id === this.active);
    if (current?.source === source) return;
    const tab = this.tabs.find((t) => t.source === source);
    if (!tab) return;
    this.active = tab.info.id;
    this.postTabs();
  }

  /** source の結果のタブがあるか */
  has(source: string): boolean {
    return this.tabs.some((t) => t.source === source);
  }

  async handle(message: FromResults): Promise<void> {
    switch (message.type) {
      case "ready":
        // 画面を作り直したとき（パネルを閉じて開いたときなど）。行は画面と一緒に消えている
        this.postTabs();
        return;
      case "selectTab":
        this.active = message.tabId;
        return;
      case "closeTab":
        this.close(message.tabId);
        return;
      case "setHeaderMode":
      case "toggleMaximize":
        // 列見出しの表示の設定と、パネルの大きさは拡張が扱う
        return;
      case "tab": {
        const tab = this.tabs.find((t) => t.info.id === message.tabId);
        if (!tab) {
          this.deps.log?.(
            `閉じたタブ（${message.tabId}）からのメッセージ（${message.message.type}）は使いません`,
          );
          return;
        }
        try {
          const inner = message.message;
          if (inner.type === "execute" && inner.mode === "all") {
            // 「▶ 実行」と入力欄の Enter：エディタの今の SQL で実行する（D-46）
            this.refreshStatement(tab);
            const missing = await tab.controller.executeIfReady();
            if (missing !== null) this.deps.focus();
            return;
          }
          await tab.controller.handle(inner);
          if (inner.type === "ready" && tab.pending) {
            tab.pending = false;
            // その間に実行し直して、タブを閉じていたら実行しない
            if (!this.tabs.includes(tab)) return;
            // 値がそろっていなければ、入力欄にカーソルを置いてもらう
            const missing = await tab.controller.executeIfReady();
            if (missing !== null) this.deps.focus();
          }
        } catch (error) {
          // 思わぬ例外でも、何も起きないように見えないよう、タブにエラーとして出す
          const text = error instanceof Error ? error.message : String(error);
          this.deps.log?.(`${tab.info.detail}：思わぬエラー：${text}`);
          this.deps.post({
            type: "tab",
            tabId: tab.info.id,
            message: {
              type: "queryFailed",
              queryId: 0,
              message: `思わぬエラーで止まりました：${text}`,
              cancelled: false,
            },
          });
        }
        return;
      }
    }
  }

  dispose(): void {
    for (const tab of this.tabs) tab.controller.dispose();
    this.tabs = [];
  }

  /** タブの文を、エディタの今の中身に合わせる（変わっていれば入力欄と SQL を作り直す） */
  private refreshStatement(tab: Tab): void {
    const current = this.deps.currentStatement?.(tab.source, tab.statement);
    if (!current) return;
    const changed = current.sql !== tab.statement.sql;
    const moved = current.line !== tab.statement.line;
    tab.statement = current;
    if (moved) {
      tab.info = {
        ...tab.info,
        detail: tab.info.detail.replace(
          / の \d+ 行目$/,
          ` の ${current.line + 1} 行目`,
        ),
      };
      this.postTabs();
    }
    if (changed) {
      this.deps.log?.(`${tab.info.detail}：エディタの今の SQL で実行します`);
      tab.controller.update(textOf(current, tab.config), tab.connection);
    }
  }

  private createTab(
    request: RunRequest,
    statement: RunStatement,
    number: number | null,
  ): Tab {
    const { deps } = this;
    const { source } = request;
    const id = `tab${++this.seq}`;
    const info: ResultTab = {
      id,
      label: number === null ? request.label : `${request.label} (${number})`,
      detail: `${request.label} の ${statement.line + 1} 行目`,
    };
    const { describeColumns } = deps;
    const controller = new ReportController({
      title: info.detail,
      text: textOf(statement, request.config),
      connection: request.connection,
      openSession: () => deps.openSession(source),
      settings: deps.settings,
      initialValues: deps.savedValues(source),
      post: (message) => deps.post({ type: "tab", tabId: id, message }),
      copyText: (text) => deps.copyText(text),
      saveConfig: (config) => deps.saveConfig(source, config),
      editSql: () => deps.reveal(source, statement),
      chooseConnection: () => deps.chooseConnection(source),
      onValuesChanged: (values) => deps.saveValues(source, values),
      ...(describeColumns
        ? {
            describeColumns: (text: string, names: readonly string[]) =>
              describeColumns(source, text, names),
          }
        : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
    deps.log?.(
      `${info.detail}：実行します（${request.connection?.name ?? "接続が決まっていません"}）`,
    );
    return {
      info,
      source,
      statement,
      config: request.config,
      connection: request.connection,
      controller,
      pending: true,
    };
  }

  private close(id: string): void {
    const index = this.tabs.findIndex((t) => t.info.id === id);
    const tab = this.tabs[index];
    if (!tab) return;
    tab.controller.dispose();
    this.tabs.splice(index, 1);
    if (this.active === id) {
      // 右隣（なければ左隣）を前に出す
      this.active = (this.tabs[index] ?? this.tabs[index - 1])?.info.id ?? null;
    }
    this.postTabs();
  }

  private postTabs(): void {
    this.deps.post({
      type: "tabs",
      tabs: this.tabs.map((t) => t.info),
      active: this.active,
    });
  }
}

/** タブの SQL。ファイルの先頭の設定のコメントを付ける（入力欄の表示名・種類・既定値を使うため） */
function textOf(statement: RunStatement, config: ReportConfig | null): string {
  return config ? writeReportConfig(statement.sql, config) : statement.sql;
}
