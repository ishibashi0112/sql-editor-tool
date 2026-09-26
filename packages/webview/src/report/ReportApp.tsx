// レポート（SQL＋フォーム）の画面（docs/handover.md §16、D-31）。
// 上にフォーム（入力欄を横に並べる）、その下に結果。入力欄の設定は「⚙ 入力欄」で一覧の表にして直す

import type {
  ReportParam,
  ReportParamConfig,
  ReportParamType,
  SortEntry,
} from "@sql-editor-tool/core";
import type {
  FromReport,
  ReportFormValues,
  ReportInit,
  SqlPreview,
  ToReport,
  ViewColumn,
} from "@sql-editor-tool/host";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CopyButtons } from "../App";
import type { HostApi } from "../hostApi";
import {
  isQueryMessage,
  QueryStatus,
  ResultPane,
  useQueryResult,
} from "../result";
import type { Filters } from "../widened";

export type ReportApi = HostApi<FromReport, ToReport>;

const TYPE_LABELS: Record<ReportParamType, string> = {
  text: "文字列",
  number: "数値",
  date: "日付（日付型の列と比べる）",
  ymd: "日付（yyyymmdd の文字列の列と比べる）",
};

export function ReportApp({ api }: { api: ReportApi }) {
  const [view, setView] = useState<ReportInit | null>(null);
  /** init のたびに増やし、フォームを作り直す（入力欄は非制御なので、既定値を入れ直すため） */
  const [version, setVersion] = useState(0);
  const [preview, setPreview] = useState<SqlPreview | null>(null);
  const [columns, setColumns] = useState<ViewColumn[]>([]);
  const [editing, setEditing] = useState(false);
  const result = useQueryResult();
  const handleQuery = result.handle;
  const { queryIdRef } = result;
  const valuesRef = useRef<ReportFormValues>({});

  useEffect(() => {
    const unsubscribe = api.subscribe((message) => {
      if (isQueryMessage(message)) {
        handleQuery(message);
        return;
      }
      switch (message.type) {
        case "init":
          valuesRef.current = { ...message.view.values };
          setView(message.view);
          setVersion((v) => v + 1);
          return;
        case "preview":
          setPreview(message.preview);
          return;
        case "columns":
          if (message.queryId === queryIdRef.current)
            setColumns(message.columns);
          return;
      }
    });
    api.post({ type: "ready" });
    return unsubscribe;
  }, [api, handleQuery, queryIdRef]);

  const running = result.query.status === "running";
  const execute = useCallback(() => {
    if (!running) api.post({ type: "execute", mode: "all" });
  }, [api, running]);
  const onValue = useCallback(
    (name: string, value: string) => {
      valuesRef.current = { ...valuesRef.current, [name]: value };
      api.post({ type: "valuesChanged", values: valuesRef.current });
    },
    [api],
  );
  const onConditions = useCallback(
    (filters: Filters, sort: SortEntry[]) =>
      api.post({ type: "conditionsChanged", filters, sort }),
    [api],
  );

  if (!view) return <div className="message">読み込み中…</div>;

  const { connection, params } = view;
  return (
    <div className="app">
      <header className="toolbar">
        <strong className="title">{view.title}</strong>
        <button
          type="button"
          className="secondary connection"
          title="実行する接続を選ぶ"
          onClick={() => api.post({ type: "chooseConnection" })}
        >
          {connection ? `接続：${connection.name} ▾` : "接続を選ぶ ▾"}
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="secondary"
          onClick={() => api.post({ type: "editSql" })}
        >
          SQL を編集
        </button>
        <button
          type="button"
          className={editing ? "" : "secondary"}
          disabled={params.length === 0}
          title={
            params.length === 0
              ? "SQL に :名前 を書くと入力欄になります"
              : "入力欄の表示名・種類・必須・既定値を直す"
          }
          onClick={() => setEditing((e) => !e)}
        >
          ⚙ 入力欄
        </button>
      </header>
      {view.configError && (
        <div className="notice error-notice">{view.configError}</div>
      )}
      {editing ? (
        <ParamSettings
          key={version}
          params={params}
          onSave={(config) => {
            api.post({ type: "saveParams", params: config });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="form" key={version}>
          {params.length === 0 && (
            <span className="status">
              入力欄はありません（SQL に :名前 を書くと入力欄になります）
            </span>
          )}
          {params.map((param) => (
            <ParamField
              key={param.name}
              param={param}
              defaultValue={view.values[param.name] ?? ""}
              onChange={onValue}
              onEnter={execute}
            />
          ))}
          <span className="buttons">
            <button type="button" onClick={execute} disabled={running}>
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
          </span>
        </div>
      )}
      <div className="toolbar statusbar">
        <QueryStatus query={result.query} maxRows={view.maxRows} />
        <span className="spacer" />
        <CopyButtons
          enabled={preview?.ok === true}
          onCopy={(variant) => api.post({ type: "copySql", variant })}
        />
      </div>
      <ResultPane
        columns={columns}
        rows={result.rows}
        query={result.query}
        fetchedFilters={result.fetchedFilters}
        maxRows={view.maxRows}
        preview={preview}
        previewLabel="SQL（フォームの値を入れたもの。画面で絞り込んでいれば WHERE・ORDER BY も付く）"
        onConditions={onConditions}
        onRefetch={() => api.post({ type: "execute", mode: "filtered" })}
        idleText="値を入れて実行すると、ここに結果が出ます"
        notice={
          connection?.demo && (
            <div className="notice">
              デモ接続です。SQL
              に出てくるデモのテーブルの行をそのまま返します（WHERE
              やフォームの値では絞り込みません）。
            </div>
          )
        }
      />
    </div>
  );
}

/** 入力欄 1 つ。日本語入力を邪魔しないよう非制御にする（Hayami の ImeSafeText と同じ考え方） */
function ParamField({
  param,
  defaultValue,
  onChange,
  onEnter,
}: {
  param: ReportParam;
  defaultValue: string;
  onChange(name: string, value: string): void;
  onEnter(): void;
}) {
  const isDate = param.type === "date" || param.type === "ymd";
  return (
    <label className="field">
      <span className="label">
        {param.label}
        {param.required && <span className="required">*</span>}
      </span>
      <input
        type={isDate ? "date" : "text"}
        inputMode={param.type === "number" ? "decimal" : undefined}
        // 日付の入力欄は 'YYYY-MM-DD' しか受け付けないので、'YYYYMMDD' の既定値はそろえる
        defaultValue={isDate ? toDateInput(defaultValue) : defaultValue}
        onInput={(event) => onChange(param.name, event.currentTarget.value)}
        onKeyDown={(event) => {
          // フォームの中の Enter で実行する。変換を確定する Enter は除く
          if (
            event.key === "Enter" &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            onEnter();
          }
        }}
      />
    </label>
  );
}

function toDateInput(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : value.trim().replaceAll("/", "-");
}

/** 入力欄の設定を一覧の表で直す（D-31）。入力欄は非制御にして、保存するときに読む */
function ParamSettings({
  params,
  onSave,
  onCancel,
}: {
  params: ReportParam[];
  onSave(config: Record<string, ReportParamConfig>): void;
  onCancel(): void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const config: Record<string, ReportParamConfig> = {};
    params.forEach((param, i) => {
      const label = String(data.get(`label-${i}`) ?? "").trim();
      const type = String(data.get(`type-${i}`) ?? "text") as ReportParamType;
      const value = String(data.get(`default-${i}`) ?? "").trim();
      const c: ReportParamConfig = {
        type,
        required: data.get(`required-${i}`) === "on",
      };
      if (label && label !== param.name) c.label = label;
      if (value) c.default = value;
      config[param.name] = c;
    });
    onSave(config);
  };
  return (
    <form className="settings" onSubmit={submit}>
      <table>
        <thead>
          <tr>
            <th>SQL の名前</th>
            <th>表示名</th>
            <th>種類</th>
            <th>必須</th>
            <th>既定値</th>
          </tr>
        </thead>
        <tbody>
          {params.map((param, i) => (
            <tr key={param.name}>
              <td className="name">:{param.name}</td>
              <td>
                <input
                  name={`label-${i}`}
                  type="text"
                  placeholder={param.name}
                  defaultValue={param.label === param.name ? "" : param.label}
                />
              </td>
              <td>
                <select name={`type-${i}`} defaultValue={param.type}>
                  {Object.entries(TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="check">
                <input
                  name={`required-${i}`}
                  type="checkbox"
                  defaultChecked={param.required}
                  aria-label={`${param.name} を必須にする`}
                />
              </td>
              <td>
                <input
                  name={`default-${i}`}
                  type="text"
                  placeholder="なし（日付は 2026-09-01 の形）"
                  defaultValue={param.default}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="buttons">
        <button type="submit">保存</button>
        <button type="button" className="secondary" onClick={onCancel}>
          取り消し
        </button>
        <span className="status">
          保存すると .sql の先頭のコメントに書き込みます
        </span>
      </div>
    </form>
  );
}
