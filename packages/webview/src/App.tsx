// データビューの画面。条件はホストが WHERE にして DB で絞り、行はここで表示する（D-03）

import {
  type GetFilterOptionsParams,
  type GetFilterOptionsResult,
  type GridFilterState,
  type GridSortState,
  SpreadsheetGrid,
} from "@ishibashi0112/spreadsheet-grid";
import type { ColumnFilterValue, SortEntry } from "@sql-editor-tool/core";
import type { SqlPreview, ToWebview, ViewInit } from "@sql-editor-tool/host";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Row, toGridColumns } from "./gridColumns";
import type { HostApi } from "./hostApi";
import { useVsCodeTheme } from "./theme";

type QueryState =
  | { status: "idle" }
  | { status: "running"; rowCount: number }
  | { status: "done"; rowCount: number; truncated: boolean; elapsedMs: number }
  | { status: "failed"; rowCount: number; message: string; cancelled: boolean };

type PendingOptions = {
  resolve(result: GetFilterOptionsResult): void;
  reject(error: Error): void;
};

/** 行の追加を画面に反映する間隔。チャンクごとに反映すると、グリッドの再計算が重なる（§11.3 の 6） */
const ROWS_FLUSH_MS = 200;

export function App({ api }: { api: HostApi }) {
  const [view, setView] = useState<ViewInit | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SqlPreview | null>(null);
  const [query, setQuery] = useState<QueryState>({ status: "idle" });
  const [rows, setRows] = useState<Row[]>([]);
  const theme = useVsCodeTheme();

  const filtersRef = useRef<Record<string, ColumnFilterValue>>({});
  const sortRef = useRef<SortEntry[]>([]);
  const queryIdRef = useRef(0);
  const rowsRef = useRef<Row[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOptions = useRef(new Map<number, PendingOptions>());
  const nextRequestId = useRef(0);

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
        case "filterOptions":
          pendingOptions.current
            .get(message.requestId)
            ?.resolve(message.result);
          pendingOptions.current.delete(message.requestId);
          return;
        case "filterOptionsFailed":
          pendingOptions.current
            .get(message.requestId)
            ?.reject(new Error(message.message));
          pendingOptions.current.delete(message.requestId);
          return;
      }
    });
    api.post({ type: "ready" });
    return unsubscribe;
  }, [api, flushRows]);

  const running = query.status === "running";
  const execute = useCallback(() => api.post({ type: "execute" }), [api]);
  const cancel = useCallback(() => api.post({ type: "cancel" }), [api]);

  // Ctrl+Enter（Mac は Cmd+Enter）で実行する。Enter だけだとセルの移動やフィルタの確定と重なる
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Enter" &&
        (event.ctrlKey || event.metaKey) &&
        !event.isComposing
      ) {
        event.preventDefault();
        execute();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [execute]);

  const postConditions = useCallback(() => {
    api.post({
      type: "conditionsChanged",
      filters: filtersRef.current,
      sort: sortRef.current,
    });
  }, [api]);

  const onFiltersChange = useCallback(
    (filters: GridFilterState) => {
      // グリッドの記述子は core と同じ形（core/src/filter.ts）
      filtersRef.current = filters.columnFilters as Record<
        string,
        ColumnFilterValue
      >;
      postConditions();
    },
    [postConditions],
  );

  const onSortChange = useCallback(
    (sort: GridSortState) => {
      sortRef.current = sort.map(({ columnKey, direction }) => ({
        columnKey,
        direction,
      }));
      postConditions();
    },
    [postConditions],
  );

  const getFilterOptions = useCallback(
    (params: GetFilterOptionsParams<Row>) =>
      new Promise<GetFilterOptionsResult>((resolve, reject) => {
        const requestId = ++nextRequestId.current;
        pendingOptions.current.set(requestId, { resolve, reject });
        api.post({
          type: "getFilterOptions",
          requestId,
          columnKey: params.columnKey,
          columnFilters: params.columnFilters as Record<
            string,
            ColumnFilterValue
          >,
        });
        params.signal.addEventListener(
          "abort",
          () => {
            if (!pendingOptions.current.delete(requestId)) return;
            api.post({ type: "abortFilterOptions", requestId });
            reject(new DOMException("中断しました", "AbortError"));
          },
          { once: true },
        );
      }),
    [api],
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
  return (
    <div className="app">
      <header className="toolbar">
        <strong className="title">{view.title}</strong>
        <button
          type="button"
          onClick={execute}
          disabled={!preview?.ok}
          title="Ctrl+Enter"
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
          デモ接続です。SQL
          は作りますが、条件による絞り込みはしません（並べ替えと件数の上限だけ効きます）。
        </div>
      )}
      <details className="preview" open>
        <summary>SQL</summary>
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
          manualFiltering
          // 上限で打ち切ったときは、画面の行だけ並べ替えても意味がないので、ORDER BY を付けて取り直す
          manualSorting={truncated}
          // 取得が終わるまでは並べ替えない（§5 段階1）
          enableSorting={query.status === "done"}
          // manualFiltering ではグローバルフィルタは何もしない（D-15）
          enableGlobalFilter={false}
          getFilterOptions={getFilterOptions}
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
          上限（{n(maxRows)} 行）に達しました。条件を追加してください
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
