// 接続プロファイル。パスワード以外は globalState、パスワードは SecretStorage に保存する（表示もログ出力もしない。§8）

import { randomUUID } from "node:crypto";
import type { DialectName } from "@sql-editor-tool/core";
import * as vscode from "vscode";

export type ConnectionProfile =
  | {
      id: string;
      name: string;
      driver: "mssql";
      host: string;
      port: number;
      database: string;
      user: string;
    }
  | {
      id: string;
      name: string;
      driver: "oracle";
      host: string;
      port: number;
      serviceName: string;
      user: string;
    }
  | {
      id: string;
      name: string;
      /** DB なしで画面を確かめるための接続 */
      driver: "demo";
      dialect: DialectName;
    };

const PROFILES_KEY = "sqlEditorTool.connections";
const passwordKey = (id: string) => `sqlEditorTool.password.${id}`;

export class ConnectionStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionProfile[] {
    return this.context.globalState.get<ConnectionProfile[]>(PROFILES_KEY, []);
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((profile) => profile.id === id);
  }

  async add(
    profile: ConnectionProfile,
    password: string | null,
  ): Promise<void> {
    if (password !== null) {
      await this.context.secrets.store(passwordKey(profile.id), password);
    }
    await this.context.globalState.update(PROFILES_KEY, [
      ...this.list(),
      profile,
    ]);
    this.changed.fire();
  }

  async remove(id: string): Promise<void> {
    await this.context.secrets.delete(passwordKey(id));
    await this.context.globalState.update(
      PROFILES_KEY,
      this.list().filter((profile) => profile.id !== id),
    );
    this.changed.fire();
  }

  /** ドライバに渡すときだけ読む */
  password(id: string): Thenable<string | undefined> {
    return this.context.secrets.get(passwordKey(id));
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** 接続を追加する入力の流れ。途中で Esc を押したら undefined */
export async function promptConnection(): Promise<
  { profile: ConnectionProfile; password: string | null } | undefined
> {
  const driver = await vscode.window.showQuickPick(
    [
      { label: "SQL Server", driver: "mssql" as const },
      { label: "Oracle", driver: "oracle" as const },
      {
        label: "デモ（DB なし）",
        description: "架空のデータで画面の動きを確かめる",
        driver: "demo" as const,
      },
    ],
    { title: "接続を追加：DB の種類" },
  );
  if (!driver) return undefined;
  const id = randomUUID();

  if (driver.driver === "demo") {
    const dialect = await vscode.window.showQuickPick(
      [
        { label: "SQL Server の SQL を作る", dialect: "mssql" as const },
        { label: "Oracle の SQL を作る", dialect: "oracle" as const },
      ],
      { title: "接続を追加：作る SQL の方言" },
    );
    if (!dialect) return undefined;
    const name = await input(
      "接続名",
      `デモ（${dialect.dialect === "mssql" ? "SQL Server" : "Oracle"}）`,
    );
    if (name === undefined) return undefined;
    return {
      profile: { id, name, driver: "demo", dialect: dialect.dialect },
      password: null,
    };
  }

  const host = await input("ホスト名");
  if (host === undefined) return undefined;
  const port = await input(
    "ポート",
    driver.driver === "mssql" ? "1433" : "1521",
    validatePort,
  );
  if (port === undefined) return undefined;
  const target = await input(
    driver.driver === "mssql" ? "データベース名" : "サービス名",
  );
  if (target === undefined) return undefined;
  const user = await input("ユーザー名");
  if (user === undefined) return undefined;
  const password = await vscode.window.showInputBox({
    title: "接続を追加：パスワード",
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) return undefined;
  const name = await input("接続名", `${user}@${host}`);
  if (name === undefined) return undefined;

  const common = { id, name, host, port: Number(port), user };
  const profile: ConnectionProfile =
    driver.driver === "mssql"
      ? { ...common, driver: "mssql", database: target }
      : { ...common, driver: "oracle", serviceName: target };
  return { profile, password };
}

function input(
  label: string,
  value?: string,
  validate?: (text: string) => string | undefined,
): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: `接続を追加：${label}`,
    ...(value === undefined ? {} : { value }),
    ignoreFocusOut: true,
    validateInput: (text) =>
      text.trim() === "" ? `${label}を入力してください` : validate?.(text),
  });
}

function validatePort(text: string): string | undefined {
  const port = Number(text);
  return Number.isInteger(port) && port > 0 && port < 65536
    ? undefined
    : "1〜65535 の整数を入力してください";
}
