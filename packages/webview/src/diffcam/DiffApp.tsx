// 差分カメラ（D-47）の差分のタブ。表ごとに追加・削除・変更の行を並べ、変わったセルに「前 → 後」を出す

import type {
  DiffRow,
  DiffTableView,
  DiffView,
  FromDiffView,
  ToDiffView,
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
  return (
    <div className="diff">
      <header className="diff-bar">
        <span className="diff-title">{view.camera}</span>
        <span className="diff-meta">
          前 {clock(view.beforeAt)} → 後 {clock(view.afterAt)}（
          {view.connection}）
        </span>
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
          onClick={() => api.post({ type: "copyText" })}
          title="表ごとに 1 行 1 文の形でコピーします（検証の記録に貼れます）"
        >
          テキストでコピー
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
  const { added, deleted, changed, unchanged } = table.counts;
  const total = added + deleted + changed;
  const keyNames = table.columns
    .filter((c) => c.key)
    .map((c) => c.logicalName ?? c.name);
  // 変わった列（どれかの行で変わった列）とキーの列だけ。変更の行がなければ（追加・削除だけ）全部の列
  const changedSet = new Set(
    table.rows.flatMap((row) => (row.kind === "changed" ? row.changed : [])),
  );
  const shown = table.columns
    .map((column, index) => ({ column, index }))
    .filter(
      ({ column, index }) =>
        !changedOnly ||
        changedSet.size === 0 ||
        column.key ||
        changedSet.has(index),
    );
  return (
    <section className="diff-table" id={anchor(table)}>
      <h2>
        {table.logicalName ?? table.name}
        {table.logicalName && <span className="phys">{table.name}</span>}
        <span className="meta">
          {table.error
            ? ""
            : total === 0
              ? `変化なし（${unchanged.toLocaleString("ja-JP")} 行）`
              : [
                  changed > 0 ? `変更 ${changed} 行` : "",
                  added > 0 ? `追加 ${added} 行` : "",
                  deleted > 0 ? `削除 ${deleted} 行` : "",
                ]
                  .filter((s) => s !== "")
                  .join("・")}
          {table.keySource !== "none" && keyNames.length > 0
            ? `（キー：${keyNames.join("・")}${table.keySource === "settings" ? "。列の設定で指定" : ""}）`
            : ""}
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
          ほかに {table.more.toLocaleString("ja-JP")}{" "}
          行あります（「テキストでコピー」で全部見られます）
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

function anchor(table: DiffTableView): string {
  return `t-${table.schema}-${table.name}`;
}

function clock(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
