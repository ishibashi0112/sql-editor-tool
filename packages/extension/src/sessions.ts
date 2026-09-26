// 接続ごとの DB セッション。最初に使うときに開き、切断・削除・終了で閉じる

import { type MssqlConfig, MssqlSession } from "@sql-editor-tool/driver-mssql";
import {
  type OracleClientMode,
  OracleSession,
} from "@sql-editor-tool/driver-oracle";
import { type DbSession, DemoSession } from "@sql-editor-tool/host";
import * as vscode from "vscode";
import type { ConnectionProfile, ConnectionStore } from "./connections";

export class SessionManager {
  private readonly sessions = new Map<string, Promise<DbSession>>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** 接続を開いた・閉じた（ツリーのアイコンの色を変える） */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly store: ConnectionStore,
    /** Thick モードのバイナリ（dist/oracledb）の場所を求めるため */
    private readonly extensionUri: vscode.Uri,
  ) {}

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
    const settings = vscode.workspace.getConfiguration("sqlEditorTool");
    switch (profile.driver) {
      case "demo":
        return new DemoSession({ dialect: profile.dialect });
      case "mssql": {
        const tls = settings.get<string>("mssql.tlsMinVersion", "");
        return MssqlSession.open({
          host: profile.host,
          port: profile.port,
          database: profile.database,
          user: profile.user,
          password: await this.password(profile.id),
          tlsMinVersion: isTlsVersion(tls) ? tls : undefined,
        });
      }
      case "oracle": {
        const mode: OracleClientMode =
          settings.get<string>("oracle.clientMode", "thin") === "thick"
            ? {
                mode: "thick",
                libDir:
                  settings.get<string>("oracle.clientLibDir", "") || undefined,
                binaryDir: vscode.Uri.joinPath(
                  this.extensionUri,
                  "dist",
                  "oracledb",
                ).fsPath,
              }
            : { mode: "thin" };
        return OracleSession.open(
          {
            host: profile.host,
            port: profile.port,
            serviceName: profile.serviceName,
            user: profile.user,
            password: await this.password(profile.id),
          },
          mode,
        );
      }
    }
  }

  /** ドライバに渡すときだけ読む */
  private async password(id: string): Promise<string> {
    const password = await this.store.password(id);
    if (password === undefined) {
      throw new Error(
        "パスワードが保存されていません。接続を追加し直してください",
      );
    }
    return password;
  }
}

function isTlsVersion(
  text: string,
): text is NonNullable<MssqlConfig["tlsMinVersion"]> {
  return text === "TLSv1" || text === "TLSv1.1" || text === "TLSv1.2";
}
