// データビューの画面。取得した行の絞り込みと並べ替えは、グリッドがすぐに行う（D-25）。
// 上限で打ち切ったときなどは、画面の絞り込みを WHERE にして DB から取り直せる

import {
  type GridFilterState,
  type GridSortState,
  SpreadsheetGrid,
} from "@ishibashi0112/spreadsheet-grid";
import type { SortEntry } from "@sql-editor-tool/core";
import type { SqlPreview, ToWebview, ViewInit } from "@sql-editor-tool/host";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Row, toGridColumns } from "./gridColumns";
import type { HostApi } from "./hostApi";
import { useVsCodeTheme } from "./theme";
import { type Filters, widenedColumns } from "./widened";

type QueryState =
  | { status: "idle" }
  | { status: "running"; rowCount: number }
  | { status: "done"; rowCount: number; truncated: boolean; elapsedMs: number }
  | { status: "failed"; rowCount: number; message: string; cancelled: boolean };

/** 行の追加を画面に反映する間隔。チャンクごとに反映すると、グリッドの再計算が重なる（§11.3 の 6） */
const ROWS_FLUSH_MS = 200;

export function App({ api }: { api: HostApi }) {
  const [view, setView] = useState<ViewInit | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SqlPreview | null>(null);
  const [query, setQuery] = useState<QueryState>({ status: "idle" });
  const [rows, setRows] = useState<Row[]>([]);
  /** 画面の絞り込み（グリッドの列フィルタ） */
  const [filters, setFilters] = useState<Filters>({});
  /** 表示中の行を DB で絞り込んだ条件。条件なしで取ったときは空 */
  const [fetchedFilters, setFetchedFilters] = useState<Filters>({});
  const theme = useVsCodeTheme();

  const sortRef = useRef<SortEntry[]>([]);
  const queryIdRef = useRef(0);
  const rowsRef = useRef<Row[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushRows = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    setRows(rowsRef.current.slice());
  }, []);

  useEffect(() => {
    const unsubscribe = api.subscribe((message: ToWebview) => {
      switch (message.type) {
        case "init":
          setView(message.view);
          return;
        case "initFailed":
          setInitError(message.message);
          return;
        case "preview":
          setPreview(message.preview);
          return;
        case "queryStarted":
          queryIdRef.current = message.queryId;
          rowsRef.current = [];
          flushRows();
          setFetchedFilters(message.filters);
          setQuery({ status: "running", rowCount: 0 });
          return;
        case "rows": {
          if (message.queryId !== queryIdRef.current) return;
          for (const row of message.rows) rowsRef.current.push(row);
          const rowCount = rowsRef.current.length;
          setQuery({ status: "running", rowCount });
          flushTimer.current ??= setTimeout(flushRows, ROWS_FLUSH_MS);
          return;
        }
        case "queryDone":
          if (message.queryId !== queryIdRef.current) return;
          flushRows();
          setQuery({
            status: "done",
            rowCount: message.rowCount,
            truncated: message.truncated,
            elapsedMs: message.elapsedMs,
          });
          return;
        case "queryFailed":
          if (message.queryId !== queryIdRef.current) return;
          flushRows();
          setQuery({
            status: "failed",
            rowCount: rowsRef.current.length,
            message: message.message,
            cancelled: message.cancelled,
          });
          return;
      }
    });
    api.post({ type: "ready" });
    return unsubscribe;
  }, [api, flushRows]);

  const running = query.status === "running";
  // DB に投げるのはボタンを押したときだけ（D-18）
  const executeAll = useCallback(
    () => api.post({ type: "execute", mode: "all" }),
    [api],
  );
  const executeFiltered = useCallback(
    () => api.post({ type: "execute", mode: "filtered" }),
    [api],
  );
  const cancel = useCallback(() => api.post({ type: "cancel" }), [api]);

  // SQL プレビュー（画面の絞り込みを WHERE にしたもの）と「取り直す」のため、ホストにも伝える
  const postConditions = useCallback(
    (next: Filters) => {
      api.post({
        type: "conditionsChanged",
        filters: next,
        sort: sortRef.current,
      });
    },
    [api],
  );

  const onFiltersChange = useCallback(
    (state: GridFilterState) => {
      // グリッドの記述子は core と同じ形（core/src/filter.ts）
      const next = state.columnFilters as Filters;
      setFilters(next);
      postConditions(next);
    },
    [postConditions],
  );

  const onSortChange = useCallback(
    (sort: GridSortState) => {
      sortRef.current = sort.map(({ columnKey, direction }) => ({
        columnKey,
        direction,
      }));
      postConditions(filters);
    },
    [postConditions, filters],
  );

  const columns = useMemo(
    () => (view ? toGridColumns(view.columns) : []),
    [view],
  );

  if (initError) {
    return (
      <div className="message error">
        テーブルの情報を取得できませんでした：{initError}
      </div>
    );
  }
  if (!view) return <div className="message">読み込み中…</div>;

  const truncated = query.status === "done" && query.truncated;
  const widened = widenedColumns(fetchedFilters, filters);
  return (
    <div className="app">
      <header className="toolbar">
        <strong className="title">{view.title}</strong>
        <button
          type="button"
          onClick={executeAll}
          disabled={running}
          title="条件を付けずに、上限の行数まで DB から取得します。絞り込みは取得した行に対して画面ですぐに効きます"
        >
          ▶ 実行
        </button>
        <button
          type="button"
          className="secondary"
          onClick={cancel}
          disabled={!running}
        >
          ■ 中止
        </button>
        <QueryStatus query={query} maxRows={view.maxRows} />
        <span className="spacer" />
        <button
          type="button"
          className="secondary"
          disabled={!preview?.ok}
          onClick={() => api.post({ type: "copySql", variant: "bind" })}
        >
          SQL をコピー
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!preview?.ok}
          title="値をリテラルに展開した SQL（A5:SQL Mk-2 などに貼る用）"
          onClick={() => api.post({ type: "copySql", variant: "literal" })}
        >
          値を展開してコピー
        </button>
      </header>
      {view.demo && (
        <div className="notice">
          デモ接続です。画面の絞り込みは効きますが、「DB
          から取り直す」ときは条件で絞り込みません（並べ替えと件数の上限だけ効きます）。
        </div>
      )}
      {!running && (truncated || widened.length > 0) && (
        <div className="notice warning-notice">
          <span>
            {truncated
              ? `上限（${view.maxRows.toLocaleString("ja-JP")} 行）で打ち切りました。画面の絞り込みと並べ替えは、取得した行だけが対象です。`
              : `表示中の行は「${widened.join("、")}」の条件で DB から絞り込んで取得したものです。その条件を外した・変えた分の行は、取り直すまで表示されません。`}
          </span>
          <button
            type="button"
            onClick={executeFiltered}
            disabled={!preview?.ok}
            title={preview?.ok === false ? preview.message : undefined}
          >
            今の絞り込みで DB から取り直す
          </button>
        </div>
      )}
      <details className="preview">
        <summary>
          SQL（画面の絞り込みと並べ替えを WHERE・ORDER BY にしたもの）
        </summary>
        {preview?.ok === false ? (
          <pre className="error">{preview.message}</pre>
        ) : (
          <pre>{preview?.literalSql ?? ""}</pre>
        )}
      </details>
      <div className="grid">
        <SpreadsheetGrid<Row>
          columns={columns}
          rows={rows}
          height="100%"
          theme={theme}
          density="compact"
          readOnly
          // 取得中は並べ替えない（行が届くたびに並びが変わるため）
          enableSorting={!running}
          // 検索欄の文字列は WHERE にできないので、画面の絞り込み＝SQL を保つために使わない（D-15）
          enableGlobalFilter={false}
          onFiltersChange={onFiltersChange}
          onSortChange={onSortChange}
          noRowsText={
            query.status === "idle" ? "実行すると、ここに結果が出ます" : "0 件"
          }
          noMatchingRowsText="条件に一致する行はありません"
        />
      </div>
    </div>
  );
}

function QueryStatus({
  query,
  maxRows,
}: {
  query: QueryState;
  maxRows: number;
}) {
  const n = (count: number) => count.toLocaleString("ja-JP");
  switch (query.status) {
    case "idle":
      return null;
    case "running":
      return <span className="status">取得中… {n(query.rowCount)} 行</span>;
    case "done":
      return query.truncated ? (
        <span className="status warning">
          {n(maxRows)} 行（上限で打ち切り）
        </span>
      ) : (
        <span className="status">
          {n(query.rowCount)} 行（{(query.elapsedMs / 1000).toFixed(1)} 秒）
        </span>
      );
    case "failed":
      return query.cancelled ? (
        <span className="status warning">
          中止しました（{n(query.rowCount)} 行まで表示）
        </span>
      ) : (
        <span className="status error">{query.message}</span>
      );
  }
}
