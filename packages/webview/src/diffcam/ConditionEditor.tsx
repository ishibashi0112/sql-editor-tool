// 差分カメラの、表の条件の入力欄（D-48）。サイドバーの表の下に開く。
// 「列を選んで入れる」でその表の列の一覧（物理名・論理名・主キー・型）を開き、選んだ列をカーソルの位置に入れる。
// 列名か論理名を打っても候補を出す（↑↓ で選んで Enter か Tab。Ctrl+Space で全部）

import {
  checkCondition,
  type DialectName,
  getDialect,
} from "@sql-editor-tool/core";
import type { ConditionColumn } from "@sql-editor-tool/host";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  insertAtCursor,
  insertColumn,
  suggestColumns,
  wordBefore,
} from "./conditionSuggest";

export function ConditionEditor({
  table,
  initial,
  dialect,
  columns,
  columnsError,
  onSave,
  onCancel,
}: {
  /** 表の名前（見出し） */
  table: string;
  initial: string;
  dialect: DialectName;
  /** 列の候補（取っているところは null） */
  columns: readonly ConditionColumn[] | null;
  columnsError?: string | undefined;
  /** 空なら条件を外す */
  onSave(where: string): void;
  onCancel(): void;
}) {
  const [text, setText] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  /** 候補を Esc で閉じた（次に打つまで出さない） */
  const [dismissed, setDismissed] = useState(false);
  /** Ctrl+Space で全部の列を出している */
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState(0);
  /** 列の一覧を開いている */
  const [picking, setPicking] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(initial.length, initial.length);
    // サイドバーが狭くても、入力欄が見えるように
    box.current?.scrollIntoView({ block: "nearest" });
  }, [initial]);

  // 候補を入れた後、カーソルを語の後ろに置く
  useEffect(() => {
    const el = area.current;
    if (!el || pendingCaret.current === null) return;
    el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  const word = wordBefore(dialect, text, caret);
  const suggestions =
    columns && word && !dismissed && !picking
      ? suggestColumns(columns, word.word, { all })
      : [];
  const open = suggestions.length > 0;
  const active = Math.min(selected, suggestions.length - 1);

  let error: string | undefined;
  if (text.trim() !== "") {
    try {
      checkCondition(getDialect(dialect), text);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const update = (value: string, position: number) => {
    setText(value);
    setCaret(position);
    setDismissed(false);
    setAll(false);
    setSelected(0);
  };
  const accept = (column: ConditionColumn) => {
    if (!word) return;
    const next = insertColumn(dialect, text, word.start, caret, column.name);
    pendingCaret.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setDismissed(true);
    setAll(false);
    area.current?.focus();
  };
  /** 一覧から選んだ列を、カーソルの位置に入れる */
  const pick = (column: ConditionColumn) => {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const next = insertAtCursor(dialect, text, start, end, column.name);
    pendingCaret.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setDismissed(true);
    setPicking(false);
    el?.focus();
  };
  const closePicker = () => {
    setPicking(false);
    area.current?.focus();
  };
  const save = () => {
    if (error) return;
    onSave(text.trim());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 日本語の変換中は、Enter などを候補や保存に使わない
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === " " && event.ctrlKey) {
      event.preventDefault();
      setDismissed(false);
      setAll(true);
      setSelected(0);
      return;
    }
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSelected((active + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const column = suggestions[active];
        if (column) accept(column);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="condition-editor" ref={box}>
      <div className="condition-title">「{table}」の条件（撮る行を絞る）</div>
      <textarea
        ref={area}
        className="condition-input"
        rows={3}
        value={text}
        spellCheck={false}
        placeholder="例：ORDER_YMD >= '20260901'"
        aria-label="条件（WHERE の後に書く条件式）"
        onChange={(event) =>
          update(event.target.value, event.target.selectionStart)
        }
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div
          className="condition-suggest"
          role="listbox"
          // 候補が隠れていれば見えるところまで動かす
          ref={(el) => el?.scrollIntoView({ block: "nearest" })}
        >
          {suggestions.map((column, i) => (
            <div
              key={column.name}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className={i === active ? "active" : undefined}
              // クリックで入力欄からフォーカスを外さない
              onMouseDown={(event) => {
                event.preventDefault();
                accept(column);
              }}
              onMouseEnter={() => setSelected(i)}
            >
              <ColumnLabel column={column} />
            </div>
          ))}
        </div>
      )}
      <div className="condition-tools">
        <button
          type="button"
          className="secondary"
          disabled={!columns || columns.length === 0}
          aria-expanded={picking}
          onClick={() => (picking ? closePicker() : setPicking(true))}
          title="この表の列の一覧から選んで、カーソルの位置に入れます"
        >
          列を選んで入れる {picking ? "▴" : "▾"}
        </button>
        {columns && columns.length > 0 && (
          <span className="condition-count">{columns.length} 列</span>
        )}
      </div>
      {picking && columns && (
        <ColumnPicker columns={columns} onPick={pick} onClose={closePicker} />
      )}
      <p className={error ? "condition-error" : "condition-hint"}>
        {error ??
          (columnsError
            ? columnsError
            : columns === null
              ? "列の候補を読み込んでいます…"
              : "列名・論理名を打っても候補が出ます（Ctrl+Space で全部）。Enter で決める、Shift+Enter で改行")}
      </p>
      <div className="condition-buttons">
        <button type="button" disabled={error !== undefined} onClick={save}>
          {text.trim() === "" && initial !== "" ? "条件を外す" : "決める"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          やめる
        </button>
      </div>
    </div>
  );
}

/** 列の一覧（絞り込み付き）。↑↓ と Enter、クリックで選ぶ。Esc で閉じる */
function ColumnPicker({
  columns,
  onPick,
  onClose,
}: {
  columns: readonly ConditionColumn[];
  onPick(column: ConditionColumn): void;
  onClose(): void;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
    box.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const word = filter.trim();
  const shown =
    word === ""
      ? columns
      : suggestColumns(columns, word, { all: true, max: columns.length });
  const active = Math.min(selected, shown.length - 1);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelected((active + step + shown.length) % shown.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const column = shown[active];
      if (column) onPick(column);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="column-picker" ref={box}>
      <input
        ref={input}
        className="column-filter"
        value={filter}
        placeholder="列名・論理名で絞る"
        aria-label="列を絞る"
        onChange={(event) => {
          setFilter(event.target.value);
          setSelected(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="column-list" role="listbox" aria-label="列">
        {shown.map((column, i) => (
          <div
            key={column.name}
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            className={i === active ? "active" : undefined}
            ref={
              i === active
                ? (el) => el?.scrollIntoView({ block: "nearest" })
                : undefined
            }
            // クリックで絞り込みの欄からフォーカスを外さない
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(column);
            }}
            onMouseEnter={() => setSelected(i)}
          >
            <ColumnLabel column={column} />
          </div>
        ))}
        {shown.length === 0 && (
          <div className="column-empty">合う列がありません</div>
        )}
      </div>
    </div>
  );
}

/** 列の見出し：主キーの印・物理名・型、その下に論理名 */
function ColumnLabel({ column }: { column: ConditionColumn }) {
  return (
    <>
      <span className="col-line">
        {column.key && (
          <span
            className={`col-key${column.key === "settings" ? " settings" : ""}`}
            title={
              column.key === "primary"
                ? "主キーの列"
                : "主キーのない表で、列の設定でキーにした列"
            }
          >
            {column.key === "primary" ? "主キー" : "キー"}
          </span>
        )}
        <span className="col-name">{column.name}</span>
        <span className="col-type">{column.typeLabel}</span>
      </span>
      {column.logicalName && (
        <span className="col-logical">{column.logicalName}</span>
      )}
    </>
  );
}
