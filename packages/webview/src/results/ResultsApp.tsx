// 「SQL の結果」のパネル（下のパネル、D-41）。.sql を実行した結果を、ファイルごとのタブに出す。
// タブの中身はレポートの画面（ReportApp の results の形）。前に出していないタブも消さずに持つ（行と絞り込みを保つ）

import type {
  FromReport,
  FromResults,
  PrefsMessage,
  ResultTab,
  ToReport,
  ToResults,
} from "@sql-editor-tool/host";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HostApi } from "../hostApi";
import { type ReportApi, ReportApp } from "../report/ReportApp";

export type ResultsApi = HostApi<FromResults, ToResults>;

export function ResultsApp({ api }: { api: ResultsApi }) {
  const [tabs, setTabs] = useState<ResultTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  /** 取得中のタブ（タブに印を付ける） */
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const prefs = useRef<PrefsMessage | null>(null);
  const apis = useRef(new Map<string, ReportApi>());

  useEffect(() => {
    const unsubscribe = api.subscribe((message) => {
      if (message.type === "prefs") {
        prefs.current = message;
      } else if (message.type === "tabs") {
        setTabs(message.tabs);
        setActive(message.active);
        const ids = new Set(message.tabs.map((t) => t.id));
        for (const id of apis.current.keys()) {
          if (!ids.has(id)) apis.current.delete(id);
        }
      } else if (message.type === "tab") {
        const inner = message.message;
        const { type } = inner;
        if (
          type === "queryStarted" ||
          type === "queryDone" ||
          type === "queryFailed" ||
          type === "queryNotice"
        ) {
          const on =
            type === "queryStarted" ||
            (type === "queryNotice" && inner.notice === "connecting");
          setRunning((current) => {
            if (current.has(message.tabId) === on) return current;
            const next = new Set(current);
            if (on) next.add(message.tabId);
            else next.delete(message.tabId);
            return next;
          });
        }
      }
    });
    api.post({ type: "ready" });
    return unsubscribe;
  }, [api]);

  const apiFor = useCallback(
    (tabId: string): ReportApi => {
      let tabApi = apis.current.get(tabId);
      if (!tabApi) {
        tabApi = {
          post: (message: FromReport) => {
            // 列見出しの表示は、タブではなくパネルの設定
            if (message.type === "setHeaderMode") api.post(message);
            else api.post({ type: "tab", tabId, message });
          },
          subscribe(handler) {
            // 開いたときの設定は、後から作ったタブにも渡す
            const last = prefs.current;
            if (last) queueMicrotask(() => handler(last));
            return api.subscribe((message) => {
              if (message.type === "prefs") handler(message);
              else if (message.type === "tab" && message.tabId === tabId) {
                handler(message.message as ToReport);
              }
            });
          },
        };
        apis.current.set(tabId, tabApi);
      }
      return tabApi;
    },
    [api],
  );

  const select = (tabId: string) => {
    setActive(tabId);
    api.post({ type: "selectTab", tabId });
  };

  if (tabs.length === 0) {
    return (
      <div className="results-empty">
        <p>
          .sql を書いて <kbd>Ctrl</kbd>+<kbd>Enter</kbd>（Mac は <kbd>⌘</kbd>+
          <kbd>Enter</kbd>）か、エディタの右上の ▶
          で実行すると、ここに結果が出ます。
        </p>
        <p className="status">
          カーソルのある文（; か、; なしで続けて書いた次の SELECT までを 1
          つの文とします）を実行します。範囲を選んでいれば、その部分を実行します。
          :名前 や @名前（SQL Server）を書くと入力欄になり、値を入れて Enter
          で実行します（値は覚えるので、次からはすぐ実行します）。実行できるのは
          SELECT / WITH だけです（読み取り専用）。
        </p>
      </div>
    );
  }
  return (
    <div className="results">
      <div className="tabbar" role="tablist" aria-label="結果">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={tab.id === active}
            className={`tab${tab.id === active ? " active" : ""}`}
            title={tab.detail}
            onClick={() => select(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") select(tab.id);
            }}
            onAuxClick={(event) => {
              // 中クリックで閉じる（エディタのタブと同じ）
              if (event.button === 1)
                api.post({ type: "closeTab", tabId: tab.id });
            }}
          >
            {running.has(tab.id) && (
              <span
                className="tab-running"
                title="取得中"
                role="img"
                aria-label="取得中"
              />
            )}
            <span className="tab-label">{tab.label}</span>
            <button
              type="button"
              className="tab-close"
              aria-label={`${tab.label} を閉じる`}
              title="閉じる"
              onClick={(event) => {
                event.stopPropagation();
                api.post({ type: "closeTab", tabId: tab.id });
              }}
            >
              ×
            </button>
          </div>
        ))}
        <span className="tabbar-spacer" />
        <button
          type="button"
          className="tabbar-button"
          title="結果を大きく表示する（もう一度押すと戻す）"
          onClick={() => api.post({ type: "toggleMaximize" })}
        >
          ⤢ 大きく
        </button>
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          className="tabpanel"
          hidden={tab.id !== active}
        >
          <ReportApp api={apiFor(tab.id)} />
        </div>
      ))}
    </div>
  );
}
