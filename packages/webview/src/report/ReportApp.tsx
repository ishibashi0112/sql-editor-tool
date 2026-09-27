// 「SQL の結果」のパネルのタブの中身（D-41・D-43）：.sql を実行した結果と、:名前・@名前 の入力欄。
// 0.8 までの「レポート」の画面を元にしている（名前はそのまま）。上に入力欄（横に並べる）、その下に結果。
// 高さが限られるので、ボタンは 1 行にまとめ、入力欄がなければフォームの行を出さない。
// 入力欄の設定は「⚙ 入力欄」で一覧の表にして直す（VS Code の中にファイルごとに覚える。D-44）

import {
  isRelativeDate,
  type ReportParam,
  type ReportParamConfig,
  type ReportParamType,
  resolveDateValue,
  type SortEntry,
} from "@sql-editor-tool/core";
import type {
  FromReport,
  ReportFormValues,
  ReportInit,
  ReportOptionsState,
  SqlPreview,
  ToReport,
  ViewColumn,
} from "@sql-editor-tool/host";
import {
  type FormEvent,
  Fragment,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { CopyButtons } from "../App";
import { hasLogicalNames } from "../gridColumns";
import type { HostApi } from "../hostApi";
import { HeaderModeToggle, useHeaderMode } from "../prefs";
import {
  isQueryMessage,
  QueryStatus,
  ResultPane,
  useQueryResult,
} from "../result";
import type { Filters } from "../widened";
import { OptionsField } from "./OptionsField";

export type ReportApi = HostApi<FromReport, ToReport>;

const TYPE_LABELS: Record<ReportParamType, string> = {
  text: "文字列",
  number: "数値",
  date: "日付（日付型の列と比べる）",
  ymd: "日付（yyyymmdd の文字列の列と比べる）",
  select: "選択肢（候補を SQL で取る）",
};

const isDateType = (type: ReportParamType) => type === "date" || type === "ymd";

export function ReportApp({ api }: { api: ReportApi }) {
  const [view, setView] = useState<ReportInit | null>(null);
  /** init のたびに増やし、フォームを作り直す（入力欄は非制御なので、既定値を入れ直すため） */
  const [version, setVersion] = useState(0);
  const [preview, setPreview] = useState<SqlPreview | null>(null);
  const [columns, setColumns] = useState<ViewColumn[]>([]);
  const [editing, setEditing] = useState(false);
  /** 選択肢の入力欄の候補（入力欄の名前 → 取得の状況） */
  const [options, setOptions] = useState<Record<string, ReportOptionsState>>(
    {},
  );
  const result = useQueryResult();
  const handleQuery = result.handle;
  const { notice } = result;
  const { queryIdRef } = result;
  const [headerMode, setHeaderMode] = useHeaderMode(api);
  const valuesRef = useRef<ReportFormValues>({});
  const rootRef = useRef<HTMLDivElement>(null);

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
          setOptions(message.view.options);
          setVersion((v) => v + 1);
          return;
        case "options":
          setOptions((current) => ({
            ...current,
            [message.name]: message.state,
          }));
          return;
        case "preview":
          setPreview(message.preview);
          return;
        case "columns":
          if (message.queryId === queryIdRef.current)
            setColumns(message.columns);
          return;
        case "focusParam":
          focusParam(rootRef, message.name);
          return;
        case "queryNotice":
          notice(message.notice);
          return;
      }
    });
    api.post({ type: "ready" });
    return unsubscribe;
  }, [api, handleQuery, notice, queryIdRef]);

  // 接続している間も、中止はできる（接続が済んでも実行しない）
  const running =
    result.query.status === "running" || result.query.status === "connecting";
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
  const connectionButton = (
    <button
      type="button"
      className="secondary connection"
      title="実行する接続を選ぶ"
      onClick={() => api.post({ type: "chooseConnection" })}
    >
      {connection ? `接続：${connection.name} ▾` : "接続を選ぶ ▾"}
    </button>
  );
  const settingsButton = (
    <button
      type="button"
      className={editing ? "" : "secondary"}
      disabled={params.length === 0}
      title="入力欄の表示名・種類・必須・既定値を直す"
      onClick={() => setEditing((e) => !e)}
    >
      ⚙ 入力欄
    </button>
  );
  const runButtons = (
    <span className="buttons">
      <button
        type="button"
        onClick={execute}
        disabled={running}
        title="実行したときの SQL をもう一度実行します（書き換えた SQL は、エディタで Ctrl+Enter）"
      >
        ▶ 再実行
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
  );
  const headerToggle = hasLogicalNames(columns) && (
    <HeaderModeToggle mode={headerMode} onChange={setHeaderMode} />
  );
  const copyButtons = (
    <CopyButtons
      enabled={preview?.ok === true}
      onCopy={(variant) => api.post({ type: "copySql", variant })}
    />
  );
  return (
    <div className="app compact" ref={rootRef}>
      <header className="toolbar">
        {runButtons}
        <QueryStatus query={result.query} maxRows={view.maxRows} />
        <span className="spacer" />
        {headerToggle}
        {copyButtons}
        {connectionButton}
        <button
          type="button"
          className="secondary"
          title={`エディタで ${view.title} の文を選ぶ`}
          onClick={() => api.post({ type: "editSql" })}
        >
          SQL へ移動
        </button>
        {params.length > 0 && settingsButton}
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
        params.length > 0 && (
          <div className="form" key={version}>
            {params.map((param) => (
              <ParamField
                key={param.name}
                param={param}
                defaultValue={view.values[param.name] ?? ""}
                options={options[param.name]}
                onChange={onValue}
                onEnter={execute}
              />
            ))}
            <span className="status">Enter で実行</span>
          </div>
        )
      )}
      <ResultPane
        columns={columns}
        rows={result.rows}
        query={result.query}
        fetchedFilters={result.fetchedFilters}
        maxRows={view.maxRows}
        preview={preview}
        previewLabel="SQL（実行した SQL。入力欄の値を入れたもの。画面で絞り込んでいれば WHERE・ORDER BY も付く）"
        onConditions={onConditions}
        onRefetch={() => api.post({ type: "execute", mode: "filtered" })}
        idleText={
          params.length > 0
            ? "入力欄に値を入れて Enter で実行すると、ここに結果が出ます"
            : "実行すると、ここに結果が出ます"
        }
        headerMode={headerMode}
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

/**
 * 入力欄にカーソルを置く。フォームを描くのと、パネルにフォーカスが移るのを待って、もう一度置く
 * （init と同時に届くので、最初はまだ入力欄がない）
 */
function focusParam(root: RefObject<HTMLElement | null>, name: string): void {
  const focus = () => {
    const field = [
      ...(root.current?.querySelectorAll<HTMLElement>("[data-param]") ?? []),
    ].find((el) => el.dataset.param === name);
    field?.querySelector<HTMLInputElement>("input")?.focus();
  };
  setTimeout(focus);
  setTimeout(focus, 150);
}

/** 入力欄 1 つ。日本語入力を邪魔しないよう非制御にする（Hayami の ImeSafeText と同じ考え方） */
function ParamField({
  param,
  defaultValue,
  options,
  onChange,
  onEnter,
}: {
  param: ReportParam;
  defaultValue: string;
  options: ReportOptionsState | undefined;
  onChange(name: string, value: string): void;
  onEnter(): void;
}) {
  const labelId = useId();
  if (param.type === "select") {
    return (
      <div className="field" data-param={param.name}>
        <span className="label" id={labelId}>
          {param.label}
          {param.required && <span className="required">*</span>}
        </span>
        <OptionsField
          labelId={labelId}
          defaultValue={defaultValue}
          state={options}
          required={param.required}
          onChange={(value) => onChange(param.name, value)}
          onEnter={onEnter}
        />
      </div>
    );
  }
  const isDate = isDateType(param.type);
  return (
    <label className="field" data-param={param.name}>
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

/**
 * 入力欄の設定を一覧の表で直す（D-31）。入力欄は非制御にして、保存するときに読む。
 * 種類だけは、選択肢の候補の SQL の欄と既定値の書き方の案内を切り替えるので、状態で持つ
 */
function ParamSettings({
  params,
  onSave,
  onCancel,
}: {
  params: ReportParam[];
  onSave(config: Record<string, ReportParamConfig>): void;
  onCancel(): void;
}) {
  const [types, setTypes] = useState(() => params.map((p) => p.type));
  const [defaults, setDefaults] = useState(() => params.map((p) => p.default));
  const [error, setError] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const config: Record<string, ReportParamConfig> = {};
    for (const [i, param] of params.entries()) {
      const label = String(data.get(`label-${i}`) ?? "").trim();
      const type = types[i] ?? "text";
      const value = String(data.get(`default-${i}`) ?? "").trim();
      const options = String(data.get(`options-${i}`) ?? "").trim();
      if (value && isDateType(type) && !resolveDateValue(value, now)) {
        setError(
          `「${param.name}」の既定値「${value}」は日付ではありません（2026-09-01、今日、月初-1か月 などの形で書いてください）`,
        );
        return;
      }
      if (type === "select" && !options) {
        setError(`「${param.name}」の候補の SQL を書いてください`);
        return;
      }
      const c: ReportParamConfig = {
        type,
        required: data.get(`required-${i}`) === "on",
      };
      if (label && label !== param.name) c.label = label;
      if (value) c.default = value;
      if (type === "select") c.options = options;
      config[param.name] = c;
    }
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
          {params.map((param, i) => {
            const type = types[i] ?? param.type;
            const value = defaults[i] ?? "";
            const resolved =
              isDateType(type) && isRelativeDate(value)
                ? resolveDateValue(value, now)
                : null;
            return (
              <Fragment key={param.name}>
                <tr>
                  <td className="name">:{param.name}</td>
                  <td>
                    <input
                      name={`label-${i}`}
                      type="text"
                      placeholder={param.name}
                      defaultValue={
                        param.label === param.name ? "" : param.label
                      }
                    />
                  </td>
                  <td>
                    <select
                      name={`type-${i}`}
                      value={type}
                      onChange={(event) => {
                        const next = event.currentTarget
                          .value as ReportParamType;
                        setTypes((current) =>
                          current.map((t, j) => (j === i ? next : t)),
                        );
                      }}
                    >
                      {Object.entries(TYPE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {param.guessed && type === param.type && (
                      <span
                        className="guessed"
                        title="SQL Server が SQL から推定した種類です。保存すると、この種類を書き込みます"
                      >
                        （推定）
                      </span>
                    )}
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
                      placeholder={
                        isDateType(type)
                          ? "なし（例：2026-09-01、今日、月初-1か月）"
                          : "なし"
                      }
                      defaultValue={param.default}
                      onInput={(event) => {
                        const next = event.currentTarget.value;
                        setDefaults((current) =>
                          current.map((d, j) => (j === i ? next : d)),
                        );
                      }}
                    />
                    {resolved && (
                      <span className="resolved">→ {resolved}（今日なら）</span>
                    )}
                  </td>
                </tr>
                {type === "select" && (
                  <tr className="options-row">
                    <td />
                    <td colSpan={4}>
                      <label>
                        <span className="status">
                          候補の SQL（1 列目＝値、2
                          列目＝表示名。開いたときに実行します）
                        </span>
                        <textarea
                          name={`options-${i}`}
                          rows={3}
                          spellCheck={false}
                          placeholder="SELECT コード, 名前 FROM 得意先 ORDER BY コード"
                          defaultValue={param.options}
                        />
                      </label>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {error && <div className="notice error-notice">{error}</div>}
      <p className="status help">
        日付の既定値には、今日・月初・月末・年初・年末・年度初（4 月 1
        日）・年度末と、±N日・±Nか月・±N年を書けます（例：月初-1か月、今日-7日。昨日・前月初・前月末・翌月初
        なども可）。実行するたびに計算します
      </p>
      <div className="buttons">
        <button type="submit">保存</button>
        <button type="button" className="secondary" onClick={onCancel}>
          取り消し
        </button>
        <span className="status">
          この PC の VS Code に、ファイルごとに保存します（.sql
          は書き換えません）
        </span>
      </div>
    </form>
  );
}
