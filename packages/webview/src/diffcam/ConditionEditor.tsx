// 差分カメラの、表の条件の入力欄（D-48）。サイドバーの表の下に開く。
// 列名か論理名を打つと、その表の列の候補を出す（↑↓ で選んで Enter か Tab。Ctrl+Space で全部）

import {
  checkCondition,
  type DialectName,
  getDialect,
} from "@sql-editor-tool/core";
import type { ConditionColumn } from "@sql-editor-tool/host";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { insertColumn, suggestColumns, wordBefore } from "./conditionSuggest";

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
    columns && word && !dismissed
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
              <span className="col-name">{column.name}</span>
              {column.logicalName && (
                <span className="col-logical">{column.logicalName}</span>
              )}
              <span className="col-type">{column.typeLabel}</span>
            </div>
          ))}
        </div>
      )}
      <p className={error ? "condition-error" : "condition-hint"}>
        {error ??
          (columnsError
            ? columnsError
            : columns === null
              ? "列の候補を読み込んでいます…"
              : "列名か論理名を打つと候補が出ます（↑↓ で選んで Enter。Ctrl+Space で全部）。Enter で決める、Shift+Enter で改行")}
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
