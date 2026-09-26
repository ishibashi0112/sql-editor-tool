// データビューの画面（1 テーブル分）。取得した行の絞り込みと並べ替えは、グリッドがすぐに行う（D-25）。
// 上限で打ち切ったときなどは、画面の絞り込みを WHERE にして DB から取り直せる

import type { SortEntry } from "@sql-editor-tool/core";
import type { SqlPreview, ToWebview, ViewInit } from "@sql-editor-tool/host";
import { useCallback, useEffect, useState } from "react";
import { ColumnSettings } from "./ColumnSettings";
import type { HostApi } from "./hostApi";
import {
  isQueryMessage,
  QueryStatus,
  ResultPane,
  useQueryResult,
} from "./result";
import type { Filters } from "./widened";

export function App({ api }: { api: HostApi }) {
  const [view, setView] = useState<ViewInit | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SqlPreview | null>(null);
  /** init のたびに増やし、結果のグリッドを作り直す（列の設定で列の種類が変わると、絞り込みと形が合わなくなるため） */
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  /** 日付らしい列の案内を閉じた */
  const [suggestionClosed, setSuggestionClosed] = useState(false);
  const result = useQueryResult();
  const handleQuery = result.handle;

  useEffect(() => {
    const unsubscribe = api.subscribe((message: ToWebview) => {
      if (isQueryMessage(message)) {
        handleQuery(message);
        return;
      }
      switch (message.type) {
        case "init":
          setView(message.view);
          setVersion((v) => v + 1);
          setEditing(false);
          return;
        case "initFailed":
          setInitError(message.message);
          return;
        case "preview":
          setPreview(message.preview);
          return;
      }
    });
    api.post({ type: "ready" });
    return unsubscribe;
  }, [api, handleQuery]);

  // DB に投げるのはボタンを押したときだけ（D-18）
  const executeAll = useCallback(
    () => api.post({ type: "execute", mode: "all" }),
    [api],
  );
  const executeFiltered = useCallback(
    () => api.post({ type: "execute", mode: "filtered" }),
    [api],
  );
  const onConditions = useCallback(
    (filters: Filters, sort: SortEntry[]) =>
      api.post({ type: "conditionsChanged", filters, sort }),
    [api],
  );

  if (initError) {
    return (
      <div className="message error">
        テーブルの情報を取得できませんでした：{initError}
      </div>
    );
  }
  if (!view) return <div className="message">読み込み中…</div>;

  const running = result.query.status === "running";
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
          onClick={() => api.post({ type: "cancel" })}
          disabled={!running}
        >
          ■ 中止
        </button>
        <QueryStatus query={result.query} maxRows={view.maxRows} />
        <span className="spacer" />
        <CopyButtons
          enabled={preview?.ok === true}
          onCopy={(variant) => api.post({ type: "copySql", variant })}
        />
        <button
          type="button"
          className={editing ? "" : "secondary"}
          title="列の意味（yyyymmdd の文字列を日付として扱う）とキーを設定する"
          onClick={() => setEditing((e) => !e)}
        >
          ⚙ 列
        </button>
      </header>
      {editing && (
        <ColumnSettings
          view={view}
          onSave={(semantic, keyColumns) =>
            api.post({ type: "saveColumnSettings", semantic, keyColumns })
          }
          onCancel={() => setEditing(false)}
        />
      )}
      <ResultPane
        key={version}
        columns={view.columns}
        rows={result.rows}
        query={result.query}
        fetchedFilters={result.fetchedFilters}
        maxRows={view.maxRows}
        preview={preview}
        previewLabel="SQL（画面の絞り込みと並べ替えを WHERE・ORDER BY にしたもの）"
        onConditions={onConditions}
        onRefetch={executeFiltered}
        idleText="実行すると、ここに結果が出ます"
        notice={
          <>
            {view.demo && (
              <div className="notice">
                デモ接続です。画面の絞り込みは効きますが、「DB
                から取り直す」ときは条件で絞り込みません（並べ替えと件数の上限だけ効きます）。
              </div>
            )}
            {view.suggestion.length > 0 && !suggestionClosed && !editing && (
              <div className="notice suggestion-notice">
                <span>
                  yyyymmdd の日付らしい列があります：
                  {view.suggestion.join("、")}
                  。日付として扱うと、列見出しで期間などの日付の絞り込みが使えます。
                </span>
                <button
                  type="button"
                  onClick={() => api.post({ type: "acceptSuggestion" })}
                >
                  日付として扱う
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setEditing(true)}
                >
                  ⚙ 列で選ぶ
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setSuggestionClosed(true);
                    api.post({ type: "dismissSuggestion" });
                  }}
                >
                  使わない
                </button>
              </div>
            )}
          </>
        }
      />
    </div>
  );
}

export function CopyButtons({
  enabled,
  onCopy,
}: {
  enabled: boolean;
  onCopy(variant: "bind" | "literal"): void;
}) {
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={!enabled}
        onClick={() => onCopy("bind")}
      >
        SQL をコピー
      </button>
      <button
        type="button"
        className="secondary"
        disabled={!enabled}
        title="値をリテラルに展開した SQL（A5:SQL Mk-2 などに貼る用）"
        onClick={() => onCopy("literal")}
      >
        値を展開してコピー
      </button>
    </>
  );
}
