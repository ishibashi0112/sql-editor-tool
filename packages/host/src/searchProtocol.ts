// 拡張とテーブル検索のビュー（サイドバーの Webview）の間のメッセージ

import type { SchemaObject } from "./session";

export type SearchConnection = {
  id: string;
  name: string;
  /** 「SQL Server」「Oracle」「デモ」など */
  description: string;
  /** closed：未接続、loading：接続中か一覧の取得中、ready：検索できる、error：一覧を取れなかった */
  status: "closed" | "loading" | "ready" | "error";
  /** error のときの理由 */
  message?: string | undefined;
  /** ready のときのテーブルとビュー */
  objects: SchemaObject[];
};

export type ToSearchView = {
  type: "state";
  connections: SearchConnection[];
};

export type FromSearchView =
  | { type: "ready" }
  | { type: "open"; connectionId: string; object: SchemaObject }
  | { type: "connect"; connectionId: string };
