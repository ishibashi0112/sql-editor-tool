// サイドバーのテーブル検索（D-30）。接続中の DB のテーブル・ビューを名前で探し、選ぶと開く。
// 一覧は拡張が接続を開いたときに 1 回取っておき、入力のたびにここで絞り込む（DB には問い合わせない）。
// React を使わず DOM を直接組む。入力欄は非制御にして、日本語入力（変換中の Enter など）を邪魔しない

import type {
  FromSearchView,
  SchemaObject,
  SearchConnection,
  ToSearchView,
} from "@sql-editor-tool/host";
import { searchObjects } from "./match";

export type SearchApi = {
  post(message: FromSearchView): void;
  /** 戻り値を呼ぶと購読をやめる */
  subscribe(handler: (message: ToSearchView) => void): () => void;
};

/** 接続ごとに表示する件数の上限。多すぎるときは絞り込みを促す */
const LIMIT = 100;

type Item = { connectionId: string; object: SchemaObject; row: HTMLElement };

const ICONS = {
  // 表（格子）とビュー（目）
  table:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12v10H2z M2 6.5h12 M2 9.8h12 M6.5 3v10" fill="none" stroke="currentColor"/></svg>',
  view: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
};

export function mountSearchView(root: HTMLElement, api: SearchApi): void {
  root.innerHTML = `
    <div class="box">
      <input type="text" placeholder="テーブル・ビューを検索" spellcheck="false" autocomplete="off" aria-label="テーブル・ビューを検索" />
      <button type="button" class="clear" title="消す" aria-label="消す" hidden>×</button>
    </div>
    <div class="results" role="listbox" aria-label="検索結果"></div>`;
  const input = root.querySelector("input") as HTMLInputElement;
  const clear = root.querySelector(".clear") as HTMLButtonElement;
  const results = root.querySelector(".results") as HTMLElement;

  let connections: SearchConnection[] = [];
  let items: Item[] = [];
  let active = 0;

  const open = (item: Item | undefined) => {
    if (item) {
      api.post({
        type: "open",
        connectionId: item.connectionId,
        object: item.object,
      });
    }
  };

  const setActive = (index: number) => {
    items[active]?.row.classList.remove("active");
    active = Math.max(0, Math.min(index, items.length - 1));
    const item = items[active];
    if (!item) return;
    item.row.classList.add("active");
    item.row.scrollIntoView({ block: "nearest" });
  };

  const render = () => {
    const query = input.value;
    clear.hidden = query === "";
    items = [];
    active = 0;
    results.replaceChildren();

    if (connections.length === 0) {
      results.append(note("接続を追加すると、ここでテーブルを検索できます"));
      return;
    }
    if (query.trim() === "") {
      results.append(note("接続中の DB のテーブル名・ビュー名で検索します"));
      for (const connection of connections) {
        results.append(statusLine(connection, api));
      }
      return;
    }

    let found = 0;
    for (const connection of connections) {
      if (connection.status !== "ready") continue;
      const { hits, total } = searchObjects(connection.objects, query, LIMIT);
      if (total === 0) continue;
      found += total;
      results.append(groupHeader(connection, total));
      for (const hit of hits) {
        const row = resultRow(hit.object, hit.highlight);
        const item: Item = {
          connectionId: connection.id,
          object: hit.object,
          row,
        };
        const index = items.length;
        items.push(item);
        row.addEventListener("click", () => open(item));
        row.addEventListener("mousemove", () => {
          if (active !== index) setActive(index);
        });
        results.append(row);
      }
      if (total > hits.length) {
        results.append(
          note(
            `ほか ${(total - hits.length).toLocaleString("ja-JP")} 件。語を足して絞り込んでください`,
          ),
        );
      }
    }
    if (found === 0) results.append(note("見つかりません"));
    // 検索できない接続（未接続・読み込み中・エラー）も、検索の対象外であることが分かるように出す
    const others = connections.filter((c) => c.status !== "ready");
    if (others.length > 0) {
      results.append(note("検索の対象外", "section"));
      for (const connection of others) {
        results.append(statusLine(connection, api));
      }
    }
    setActive(0);
  };

  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    // 変換を確定する Enter などは、検索の操作にしない
    if (event.isComposing || event.keyCode === 229) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive(active + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive(active - 1);
        return;
      case "Enter":
        event.preventDefault();
        open(items[active]);
        return;
      case "Escape":
        if (input.value !== "") {
          input.value = "";
          render();
        }
        return;
    }
  });
  clear.addEventListener("click", () => {
    input.value = "";
    render();
    input.focus();
  });

  api.subscribe((message) => {
    connections = message.connections;
    render();
  });
  render();
  api.post({ type: "ready" });
}

function note(text: string, className = "note"): HTMLElement {
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text;
  return div;
}

function groupHeader(connection: SearchConnection, total: number): HTMLElement {
  const div = document.createElement("div");
  div.className = "section";
  // 接続名に DB の種類が入っていれば、重ねて書かない
  div.textContent = connection.name.includes(connection.description)
    ? connection.name
    : `${connection.name}（${connection.description}）`;
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = `${total.toLocaleString("ja-JP")} 件`;
  div.append(count);
  return div;
}

function resultRow(
  object: SchemaObject,
  highlight: readonly [number, number] | null,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "item";
  row.setAttribute("role", "option");
  row.title = `${object.schema}.${object.name}`;

  const icon = document.createElement("span");
  icon.className = `icon ${object.kind}`;
  icon.innerHTML = ICONS[object.kind];

  const name = document.createElement("span");
  name.className = "name";
  if (highlight) {
    const [start, end] = highlight;
    const mark = document.createElement("mark");
    mark.textContent = object.name.slice(start, end);
    name.append(object.name.slice(0, start), mark, object.name.slice(end));
  } else {
    name.textContent = object.name;
  }

  const detail = document.createElement("span");
  detail.className = "detail";
  detail.textContent =
    object.kind === "view" ? `${object.schema} · ビュー` : object.schema;

  row.append(icon, name, detail);
  return row;
}

function statusLine(connection: SearchConnection, api: SearchApi): HTMLElement {
  const div = document.createElement("div");
  div.className = `status ${connection.status}`;
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = connection.name;
  const state = document.createElement("span");
  state.className = "detail";
  div.append(name, state);
  switch (connection.status) {
    case "ready":
      state.textContent = `テーブル・ビュー ${connection.objects.length.toLocaleString("ja-JP")} 件`;
      break;
    case "loading":
      state.textContent = "読み込み中…";
      break;
    case "error":
      state.textContent = "一覧を取得できませんでした";
      div.title = connection.message ?? "";
      div.append(connectButton(connection, api, "再試行"));
      break;
    case "closed":
      state.textContent = "未接続";
      div.append(connectButton(connection, api, "接続"));
      break;
  }
  return div;
}

/** 接続して一覧を取る（取り直す）ボタン */
function connectButton(
  connection: SearchConnection,
  api: SearchApi,
  label: string,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () =>
    api.post({ type: "connect", connectionId: connection.id }),
  );
  return button;
}
