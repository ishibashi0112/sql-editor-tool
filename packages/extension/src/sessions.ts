// 接続ごとの DB セッション。最初に使うときに開き、切断・削除・終了で閉じる

import { type DbSession, DemoSession } from "@sql-editor-tool/host";
import * as vscode from "vscode";
import type { ConnectionProfile, ConnectionStore } from "./connections";

export class SessionManager {
  private readonly sessions = new Map<string, Promise<DbSession>>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** 接続を開いた・閉じた（ツリーのアイコンの色を変える） */
  readonly onDidChange = this.changed.event;

  constructor(private readonly store: ConnectionStore) {}

  get(profile: ConnectionProfile): Promise<DbSession> {
    let session = this.sessions.get(profile.id);
    if (!session) {
      session = this.open(profile);
      this.sessions.set(profile.id, session);
      session.then(
        () => this.changed.fire(),
        // 開けなかったときは、次に使うときに開き直す
        () => this.sessions.delete(profile.id),
      );
    }
    return session;
  }

  isOpen(id: string): boolean {
    return this.sessions.has(id);
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.changed.fire();
    await (await session.catch(() => undefined))?.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  dispose(): void {
    this.changed.dispose();
  }

  private async open(profile: ConnectionProfile): Promise<DbSession> {
    switch (profile.driver) {
      case "demo":
        return new DemoSession({ dialect: profile.dialect });
      case "mssql":
      case "oracle": {
        const password = await this.store.password(profile.id);
        if (password === undefined) {
          throw new Error(
            "パスワードが保存されていません。接続を追加し直してください",
          );
        }
        // ドライバ（D-07）は、会社 PC での接続の確認（O-02 / O-03）が済んでから実装する
        throw new Error(
          `${profile.driver === "mssql" ? "SQL Server" : "Oracle"} のドライバはまだ実装していません。今はデモ接続だけ使えます`,
        );
      }
    }
  }
}
