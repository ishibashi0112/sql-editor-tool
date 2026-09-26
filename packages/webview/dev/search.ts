// 開発用ページ：テーブル検索（サイドバー）を VS Code の外で確かめる。拡張の代わりに、偽の接続の状態を送る

import "../src/search/search.css";
import type {
  FromSearchView,
  SchemaObject,
  SearchConnection,
  ToSearchView,
} from "@sql-editor-tool/host";
import { mountSearchView } from "../src/search/view";

// 架空のテーブル名
const words = [
  "受注",
  "出荷",
  "得意先",
  "品目",
  "在庫",
  "請求",
  "入金",
  "仕入",
];
const suffixes = ["", "明細", "履歴", "_BK", "_WK", "一覧"];
const objects: SchemaObject[] = [];
for (const schema of ["dbo", "sales", "work"]) {
  for (const word of words) {
    for (const suffix of suffixes) {
      objects.push({ schema, name: `${word}${suffix}`, kind: "table" });
    }
    objects.push({ schema, name: `V_${word}一覧`, kind: "view" });
  }
}
for (let i = 1; i <= 300; i += 1) {
  objects.push({
    schema: "dbo",
    name: `T_TEMP_${String(i).padStart(3, "0")}`,
    kind: "table",
  });
}

const connections: SearchConnection[] = [
  {
    id: "a",
    name: "基幹",
    description: "SQL Server",
    status: "ready",
    objects,
  },
  {
    id: "b",
    name: "基幹（Oracle）",
    description: "Oracle",
    status: "closed",
    objects: [],
  },
  {
    id: "c",
    name: "検証",
    description: "SQL Server",
    status: "error",
    message: "Login failed for user 'x'.",
    objects: [],
  },
];

const handlers = new Set<(message: ToSearchView) => void>();
const send = () => {
  for (const handler of handlers)
    handler({ type: "state", connections: [...connections] });
};
const log = document.getElementById("log");

const root = document.getElementById("root");
if (root) {
  mountSearchView(root, {
    post(message: FromSearchView) {
      if (log) log.textContent = JSON.stringify(message);
      if (message.type === "ready") setTimeout(send);
      if (message.type === "connect") {
        const target = connections.find((c) => c.id === message.connectionId);
        if (!target) return;
        target.status = "loading";
        send();
        setTimeout(() => {
          target.status = "ready";
          target.objects = objects
            .slice(0, 40)
            .map((o) => ({ ...o, schema: "APP" }));
          send();
        }, 500);
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  });
}
