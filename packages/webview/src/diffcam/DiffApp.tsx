// 差分カメラ（D-47）の差分のタブ。表ごとに追加・削除・変更の行を並べ、変わったセルに「前 → 後」を出す。
// 比べた記録のほかの回に切り替えられる。Excel に貼る・保存する（D-48）

import {
  type DiffRow,
  type DiffTableView,
  type DiffView,
  diffSheet,
  type FromDiffView,
  keySummary,
  sheetHtml,
  sheetTsv,
  shownColumns,
  type ToDiffView,
  tableSummary,
} from "@sql-editor-tool/host";
import { useEffect, useState } from "react";
import type { HostApi } from "../hostApi";

export type DiffApi = HostApi<FromDiffView, ToDiffView>;

type CellValue = DiffRow["values"][number];

export function DiffApp({ api }: { api: DiffApi }) {
  const [view, setView] = useState<DiffView | null>(null);
  const [busy, setBusy] = useState(false);
  /** 変わった列だけを出す（既定。キーの列はいつも出す） */
  const [changedOnly, setChangedOnly] = useState(true);

  useEffect(() => {
    const unsubscribe = api.subscribe((message) => {
      if (message.type === "view") setView(message.view);
      else if (message.type === "busy") setBusy(message.busy);
    });
    api.post({ type: "ready" });
    return unsubscribe;
  }, [api]);

  if (!view) return null;
  const copyTable = async () => {
    const rows = diffSheet(view, { changedOnly });
    const text = sheetTsv(rows);
    const truncated = view.tables.some((t) => t.more > 0);
    if (await copyHtml(sheetHtml(rows), text)) {
      api.post({ type: "copiedTable", truncated });
    } else {
      // HTML を入れられなければ、タブ区切りの文字だけ（Excel に貼るとセルに分かれる）
      api.post({ type: "copyPlain", text });
    }
  };
  const current = view.history.find((h) => h.id === view.entry);
  return (
    <div className="diff">
      <header className="diff-bar">
        <span className="diff-title">{view.camera}</span>
        {view.history.length > 1 ? (
          <select
            className="diff-history"
            value={view.entry}
            title="比べた記録（VS Code を閉じるまで覚えています）"
            onChange={(event) =>
              api.post({ type: "show", entry: event.target.value })
            }
          >
            {view.history.map((h) => (
              <option key={h.id} value={h.id}>
                {`${h.seq} 回目　前 ${clock(h.beforeAt)} → 後 ${clock(h.afterAt)}　${h.summary}`}
              </option>
            ))}
          </select>
        ) : (
          <span className="diff-meta">
            {current ? `${current.seq} 回目　` : ""}前 {clock(view.beforeAt)} →
            後 {clock(view.afterAt)}
          </span>
        )}
        <span className="diff-meta">{view.connection}</span>
        <span className="spacer" />
        <label className="diff-toggle">
          <input
            type="checkbox"
            checked={changedOnly}
            onChange={(event) => setChangedOnly(event.target.checked)}
          />
          変わった列だけ
        </label>
        <button
          type="button"
          className="secondary"
          onClick={() => void copyTable()}
          title="Excel に貼ると、色と罫線の付いた表になります（変わった行は変更前・変更後の 2 行。「変わった列だけ」に従います）"
        >
          表でコピー
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => api.post({ type: "copyText", entry: view.entry })}
          title="表ごとに 1 行 1 文の形でコピーします（検証の記録に貼れます）"
        >
          テキストでコピー
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            api.post({ type: "saveExcel", entry: view.entry, changedOnly })
          }
          title="「表でコピー」と同じ形の Excel ファイル（.xlsx）に保存します。行が多くて画面に出していない行も入ります"
        >
          Excel で保存
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => api.post({ type: "retakeAfter" })}
          title="もう一度「後」を撮って、同じ「前」と比べます"
        >
          {busy ? "撮っています…" : "もう一度「後」を撮る"}
        </button>
      </header>
      <nav className="diff-chips">
        {view.tables.map((table) => (
          <a
            key={anchor(table)}
            className="diff-chip"
            href={`#${anchor(table)}`}
          >
            {table.logicalName ?? table.name} <Counts table={table} />
          </a>
        ))}
      </nav>
      <div className="diff-body">
        {view.tables.map((table) => (
          <TableSection
            key={anchor(table)}
            table={table}
            changedOnly={changedOnly}
          />
        ))}
      </div>
    </div>
  );
}

function Counts({ table }: { table: DiffTableView }) {
  if (table.error) return <span className="d">撮れませんでした</span>;
  const { added, deleted, changed } = table.counts;
  if (added + deleted + changed === 0)
    return <span className="none">変化なし</span>;
  return (
    <>
      {changed > 0 && <span className="c">✎{changed}</span>}
      {added > 0 && <span className="a">＋{added}</span>}
      {deleted > 0 && <span className="d">−{deleted}</span>}
    </>
  );
}

function TableSection({
  table,
  changedOnly,
}: {
  table: DiffTableView;
  changedOnly: boolean;
}) {
  const { added, deleted, changed } = table.counts;
  const total = added + deleted + changed;
  const shown = shownColumns(table, changedOnly).map((index) => ({
    column: table.columns[index] ?? { name: "", key: false },
    index,
  }));
  return (
    <section className="diff-table" id={anchor(table)}>
      <h2>
        {table.logicalName ?? table.name}
        {table.logicalName && <span className="phys">{table.name}</span>}
        <span className="meta">
          {table.error ? "" : `${tableSummary(table)}${keySummary(table)}`}
        </span>
      </h2>
      {table.where && <p className="diff-note">条件：{table.where}</p>}
      {table.error && <p className="notice error-notice">{table.error}</p>}
      {!table.error && table.keySource === "none" && total > 0 && (
        <p className="diff-note">
          主キーもキーの設定もないので、行ごとの変更は分かりません。中身が変わった行は、削除と追加で出します（データビューの「⚙
          列」でキーを指定できます）
        </p>
      )}
      {table.columnsChanged && (
        <p className="diff-note">
          前と後で表の列が変わっています（後の列で比べています）
        </p>
      )}
      {total > 0 && (
        <table className="diff-grid">
          <thead>
            <tr>
              <th className="diff-kind" />
              {shown.map(({ column }) => (
                <th key={column.name}>
                  {column.name}
                  {column.key && <span className="key"> 🔑</span>}
                  {column.logicalName && (
                    <span className="logical">{column.logicalName}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr
                // 行の並びは変わらないので、添字で足りる
                // biome-ignore lint/suspicious/noArrayIndexKey: 差分の行は並びが変わらない
                key={i}
                className={`row-${row.kind}`}
              >
                <td className="diff-kind">
                  {row.kind === "changed"
                    ? "✎"
                    : row.kind === "added"
                      ? "＋"
                      : "−"}
                </td>
                {shown.map(({ column, index }) => (
                  <Cell key={column.name} row={row} index={index} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {table.more > 0 && (
        <p className="diff-note">
          ほかに {table.more.toLocaleString("ja-JP")} 行あります（「Excel
          で保存」「テキストでコピー」には全部入ります）
        </p>
      )}
    </section>
  );
}

function Cell({ row, index }: { row: DiffRow; index: number }) {
  const value = row.values[index] ?? null;
  if (row.kind === "changed" && row.changed.includes(index)) {
    return (
      <td className="changed">
        <span className="old">
          <Value value={row.before[index] ?? null} />
        </span>
        <span className="arrow">→</span>
        <span className="new">
          <Value value={value} />
        </span>
      </td>
    );
  }
  return (
    <td className={row.kind === "changed" ? "same" : undefined}>
      <Value value={value} />
    </td>
  );
}

function Value({ value }: { value: CellValue }) {
  if (value === null) return <span className="null">NULL</span>;
  if (value === "") return <span className="null">（空）</span>;
  return <>{String(value)}</>;
}

/** HTML（Excel に貼ると表になる）とタブ区切りの文字を、クリップボードに入れる。入れられなければ false */
async function copyHtml(html: string, text: string): Promise<boolean> {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
    return true;
  } catch {
    // 使えなければ、copy のイベントで入れる
  }
  let done = false;
  const listener = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/html", html);
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    done = true;
  };
  document.addEventListener("copy", listener);
  try {
    document.execCommand("copy");
  } catch {
    // 下で false を返す
  } finally {
    document.removeEventListener("copy", listener);
  }
  return done;
}

function anchor(table: DiffTableView): string {
  return `t-${table.schema}-${table.name}`;
}

function clock(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
