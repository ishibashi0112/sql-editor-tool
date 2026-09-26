// 選択肢の入力欄（D-34）。打つと、値か表示名にその文字を含む候補に絞られ、↑↓ と Enter（またはクリック）で選ぶ。
// 一覧は、打ったとき・クリックしたとき・↓↑ で開く（フォーカスしただけでは開かない。Tab で移って Enter で実行できるように）。
// 日本語入力を邪魔しないよう入力欄は非制御にし、値を書き換えるのは候補を選んだときと候補が届いたときだけにする

import type { ReportOption, ReportOptionsState } from "@sql-editor-tool/host";
import { useEffect, useId, useMemo, useRef, useState } from "react";

/** 一覧に出す候補の数。これより多ければ、打って絞ってもらう */
const SHOWN = 100;

export function optionText(option: ReportOption): string {
  return option.label ? `${option.value} ${option.label}` : option.value;
}

/** 全角半角・大文字小文字を区別せずに比べる（テーブル検索と同じ。D-30） */
const fold = (text: string) => text.normalize("NFKC").toLowerCase();

export function OptionsField({
  labelId,
  defaultValue,
  state,
  required,
  onChange,
  onEnter,
}: {
  /** 入力欄の表示名の要素の id */
  labelId: string;
  /** 最初に入れる値（候補の 1 列目の値） */
  defaultValue: string;
  state: ReportOptionsState | undefined;
  required: boolean;
  onChange(value: string): void;
  onEnter(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** SQL に渡す値（候補を選べばその値、選ばずに打った文字ならその文字） */
  const valueRef = useRef(defaultValue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const options = useMemo(
    () => (state?.status === "ok" ? state.options : []),
    [state],
  );

  // 候補が届いたら、値の代わりに「値 表示名」を出す（入力中は触らない）
  useEffect(() => {
    const input = inputRef.current;
    if (!input || document.activeElement === input) return;
    const selected = options.find((o) => o.value === valueRef.current);
    input.value = selected ? optionText(selected) : valueRef.current;
  }, [options]);

  const matches = useMemo(() => {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return options;
    return options.filter((option) => {
      const text = fold(`${option.value} ${option.label}`);
      return terms.every((term) => text.includes(term));
    });
  }, [options, query]);

  // 選んでいる候補が見えるようにスクロールする
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const setValue = (value: string) => {
    valueRef.current = value;
    onChange(value);
  };

  /**
   * 一覧を開く。選んだ候補がそのまま出ていれば（または空なら）すべての候補を出して、その候補を選んでおく。
   * 打ちかけの文字があれば、その文字で絞る
   */
  const openAll = () => {
    const text = inputRef.current?.value ?? "";
    const index = options.findIndex((o) => o.value === valueRef.current);
    const selected = options[index];
    if (text === "" || (selected && optionText(selected) === text)) {
      setQuery("");
      setActive(index >= 0 && index < SHOWN ? index : 0);
    } else {
      setQuery(text);
      setActive(0);
    }
    setOpen(true);
  };

  const pick = (option: ReportOption) => {
    const input = inputRef.current;
    if (input) input.value = optionText(option);
    setValue(option.value);
    setOpen(false);
    setQuery("");
  };

  const placeholder =
    state?.status === "loading"
      ? "候補を読み込み中…"
      : required
        ? "打って絞り込む"
        : "指定なし（打って絞り込む）";
  const shown = matches.slice(0, SHOWN);

  return (
    <span className="combo">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-labelledby={labelId}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && shown[active] ? `${listId}-${active}` : undefined
        }
        placeholder={placeholder}
        defaultValue={defaultValue}
        onFocus={(event) => {
          // 打てば選んでいた文字を置き換えるようにする
          event.currentTarget.select();
        }}
        onClick={() => {
          if (!open) openAll();
        }}
        onBlur={() => setOpen(false)}
        onInput={(event) => {
          const text = event.currentTarget.value;
          setQuery(text);
          setActive(0);
          setOpen(true);
          // 値そのもの・表示名そのもの・「値 表示名」を打ったなら、その候補の値にする
          const trimmed = text.trim();
          const exact = options.find(
            (o) =>
              o.value === trimmed ||
              (o.label !== "" && o.label === trimmed) ||
              optionText(o) === trimmed,
          );
          setValue(exact ? exact.value : trimmed);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              openAll();
              return;
            }
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((i) =>
              Math.min(Math.max(i + step, 0), Math.max(shown.length - 1, 0)),
            );
          } else if (event.key === "Enter") {
            // 一覧を開いていれば候補を選ぶ。閉じていれば実行する（フォームの Enter、D-31）
            const option = open ? shown[active] : undefined;
            if (option) pick(option);
            else onEnter();
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
      />
      {open && state?.status === "ok" && (
        <div className="combo-list" id={listId} role="listbox" ref={listRef}>
          {shown.map((option, i) => (
            <div
              key={option.value}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              data-index={i}
              aria-selected={i === active}
              className={i === active ? "item active" : "item"}
              // クリックで入力欄のフォーカスが外れる前に選ぶ
              onMouseDown={(event) => {
                event.preventDefault();
                pick(option);
              }}
              onMouseMove={() => setActive(i)}
            >
              <span className="value">{option.value}</span>
              {option.label && (
                <span className="option-label">{option.label}</span>
              )}
            </div>
          ))}
          {matches.length === 0 && (
            <div className="note">当てはまる候補がありません</div>
          )}
          {matches.length > SHOWN && (
            <div className="note">
              ほかに {(matches.length - SHOWN).toLocaleString()}{" "}
              件。打って絞り込んでください
            </div>
          )}
          {state.truncated && (
            <div className="note">
              候補が多いので、先頭の {options.length.toLocaleString()}{" "}
              件だけです
            </div>
          )}
        </div>
      )}
      {state?.status === "error" && (
        <span className="combo-error" title={state.message}>
          {state.message}
        </span>
      )}
    </span>
  );
}
