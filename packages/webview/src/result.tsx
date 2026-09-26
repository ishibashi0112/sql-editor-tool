// 結果の表示（データビューとレポートで共通）：取得の状況、打ち切り・取り直しの案内、SQL プレビュー、グリッド。
// 取得した行の絞り込みと並べ替えは、グリッドがすぐに行う（D-25）

import {
  type GridFilterState,
  type GridSortState,
  SpreadsheetGrid,
} from "@ishibashi0112/spreadsheet-grid";
import type { SortEntry } from "@sql-editor-tool/core";
import type { SqlPreview, ToWebview, ViewColumn } from "@sql-editor-tool/host";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { type Row, toGridColumns } from "./gridColumns";
import { useVsCodeTheme } from "./theme";
import { type Filters, widenedColumns } from "./widened";

export type QueryState =
  | { status: "idle" }
  | { status: "running"; rowCount: number }
  | { status: "done"; rowCount: number; truncated: boolean; elapsedMs: number }
  | { status: "failed"; rowCount: number; message: string; cancelled: boolean };

type QueryMessage = Extract<
  ToWebview,
  { type: "queryStarted" | "rows" | "queryDone" | "queryFailed" }
>;

/** 行の追加を画面に反映する間隔。チャンクごとに反映すると、グリッドの再計算が重なる（§11.3 の 6） */
const ROWS_FLUSH_MS = 200;

/** 取得の状況と行。handle に実行のメッセージを渡す */
export function useQueryResult() {
  const [query, setQuery] = useState<QueryState>({ status: "idle" });
  const [rows, setRows] = useState<Row[]>([]);
  /** 表示中の行を DB で絞り込んだ条件。条件なしで取ったときは空 */
  const [fetchedFilters, setFetchedFilters] = useState<Filters>({});
  const queryIdRef = useRef(0);
  const rowsRef = useRef<Row[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushRows = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    setRows(rowsRef.current.slice());
  }, []);

  const handle = useCallback(
    (message: QueryMessage) => {
      switch (message.type) {
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
          setQuery({ status: "running", rowCount: rowsRef.current.length });
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
          // 接続できなかったときなど、実行を始める前の失敗は queryId が 0
          if (message.queryId !== queryIdRef.current && message.queryId !== 0)
            return;
          flushRows();
          setQuery({
            status: "failed",
            rowCount: rowsRef.current.length,
            message: message.message,
            cancelled: message.cancelled,
          });
          return;
      }
    },
    [flushRows],
  );

  return { query, rows, fetchedFilters, handle, queryIdRef };
}

export function isQueryMessage(message: {
  type: string;
}): message is QueryMessage {
  return (
    message.type === "queryStarted" ||
    message.type === "rows" ||
    message.type === "queryDone" ||
    message.type === "queryFailed"
  );
}

export function QueryStatus({
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

export type ResultPaneProps = {
  columns: readonly ViewColumn[];
  rows: Row[];
  query: QueryState;
  fetchedFilters: Filters;
  maxRows: number;
  preview: SqlPreview | null;
  /** SQL プレビューの見出し */
  previewLabel: string;
  /** 画面の絞り込み・並べ替えが変わったとき（SQL プレビューと取り直しのため、ホストに伝える） */
  onConditions(filters: Filters, sort: SortEntry[]): void;
  /** 今の絞り込みで DB から取り直す */
  onRefetch(): void;
  /** まだ実行していないときに、グリッドに出す文 */
  idleText: string;
  /** 案内の上に出すもの（デモ接続の説明など） */
  notice?: ReactNode;
};

export function ResultPane(props: ResultPaneProps) {
  const { query, preview, maxRows, onConditions } = props;
  const theme = useVsCodeTheme();
  /** 画面の絞り込み（グリッドの列フィルタ） */
  const [filters, setFilters] = useState<Filters>({});
  const sortRef = useRef<SortEntry[]>([]);
  const running = query.status === "running";

  const onFiltersChange = useCallback(
    (state: GridFilterState) => {
      // グリッドの記述子は core と同じ形（core/src/filter.ts）
      const next = state.columnFilters as Filters;
      setFilters(next);
      onConditions(next, sortRef.current);
    },
    [onConditions],
  );

  const onSortChange = useCallback(
    (sort: GridSortState) => {
      sortRef.current = sort.map(({ columnKey, direction }) => ({
        columnKey,
        direction,
      }));
      onConditions(filters, sortRef.current);
    },
    [onConditions, filters],
  );

  const columns = useMemo(() => toGridColumns(props.columns), [props.columns]);
  const truncated = query.status === "done" && query.truncated;
  const widened = widenedColumns(props.fetchedFilters, filters);

  return (
    <>
      {props.notice}
      {!running && (truncated || widened.length > 0) && (
        <div className="notice warning-notice">
          <span>
            {truncated
              ? `上限（${maxRows.toLocaleString("ja-JP")} 行）で打ち切りました。画面の絞り込みと並べ替えは、取得した行だけが対象です。`
              : `表示中の行は「${widened.join("、")}」の条件で DB から絞り込んで取得したものです。その条件を外した・変えた分の行は、取り直すまで表示されません。`}
          </span>
          <button
            type="button"
            onClick={props.onRefetch}
            disabled={!preview?.ok}
            title={preview?.ok === false ? preview.message : undefined}
          >
            今の絞り込みで DB から取り直す
          </button>
        </div>
      )}
      <details className="preview">
        <summary>{props.previewLabel}</summary>
        {preview?.ok === false ? (
          <pre className="error">{preview.message}</pre>
        ) : (
          <pre>{preview?.literalSql ?? ""}</pre>
        )}
      </details>
      <div className="grid">
        <SpreadsheetGrid<Row>
          columns={columns}
          rows={props.rows}
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
          noRowsText={query.status === "idle" ? props.idleText : "0 件"}
          noMatchingRowsText="条件に一致する行はありません"
        />
      </div>
    </>
  );
}
