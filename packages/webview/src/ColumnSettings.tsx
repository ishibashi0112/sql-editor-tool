// データビューの列の設定（D-36）。「⚙ 列」で一覧の表を開き、列ごとの意味（yyyymmdd の文字列を日付として扱う）と、
// 主キーのないテーブル・ビューでのキーをまとめて直す（レポートの「⚙ 入力欄」と同じ形。D-31）

import {
  canBeYmd,
  columnTypeLabel,
  type SemanticType,
} from "@sql-editor-tool/core";
import type { ViewInit } from "@sql-editor-tool/host";
import { useState } from "react";

const YMD: SemanticType = { kind: "date", format: "yyyymmdd" };

export function ColumnSettings({
  view,
  onSave,
  onCancel,
}: {
  view: ViewInit;
  onSave(semantic: Record<string, SemanticType>, keyColumns: string[]): void;
  onCancel(): void;
}) {
  const { columns, primaryKey, candidates, settingsSaved } = view;
  const hasPrimaryKey = primaryKey.length > 0;
  // 設定を保存したことがなければ、候補を日付にした状態から始める
  const [ymd, setYmd] = useState(
    () =>
      new Set(
        columns
          .filter(
            (c) =>
              c.semantic?.kind === "date" ||
              (!settingsSaved && candidates.includes(c.name)),
          )
          .map((c) => c.name),
      ),
  );
  const [keys, setKeys] = useState(
    () => new Set(columns.filter((c) => c.isKey).map((c) => c.name)),
  );
  const toggle = (set: Set<string>, name: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(name);
    else next.delete(name);
    return next;
  };

  const save = () => {
    const semantic: Record<string, SemanticType> = {};
    for (const c of columns) if (ymd.has(c.name)) semantic[c.name] = YMD;
    onSave(
      semantic,
      hasPrimaryKey
        ? []
        : columns.filter((c) => keys.has(c.name)).map((c) => c.name),
    );
  };

  return (
    <div className="settings column-settings">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>列名</th>
              <th>DB の型</th>
              <th>意味</th>
              <th>キー</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column.name}>
                <td className="name">{column.name}</td>
                <td className="status">{columnTypeLabel(column.type)}</td>
                <td>
                  {canBeYmd(column) ? (
                    <>
                      <select
                        aria-label={`${column.name} の意味`}
                        value={ymd.has(column.name) ? "ymd" : "none"}
                        onChange={(event) => {
                          const on = event.currentTarget.value === "ymd";
                          setYmd((current) => toggle(current, column.name, on));
                        }}
                      >
                        <option value="none">そのまま（文字列）</option>
                        <option value="ymd">日付（yyyymmdd）</option>
                      </select>
                      {candidates.includes(column.name) && (
                        <span
                          className="guessed"
                          title="長さ 8 の文字列で、名前が日付らしい列です"
                        >
                          （候補）
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="status">
                      {column.type.kind === "datetime" ? "（日付型）" : "—"}
                    </span>
                  )}
                </td>
                <td className="check">
                  <input
                    type="checkbox"
                    aria-label={`${column.name} をキーにする`}
                    checked={keys.has(column.name)}
                    disabled={hasPrimaryKey}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setKeys((current) => toggle(current, column.name, on));
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="status help">
        日付（yyyymmdd）にすると、列見出しで期間などの日付の絞り込みが使えます（DB
        には yyyymmdd の文字列で問い合わせます）。
        {hasPrimaryKey
          ? "キーは主キーを使います（主キーのあるテーブルでは変えられません）。"
          : "キーは、取得の順（ORDER BY）をそろえるのに使います。主キーのないテーブル・ビューで、行を見分けられる列を選んでください。"}
      </p>
      <div className="buttons">
        <button type="button" onClick={save}>
          保存
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          取り消し
        </button>
        <span className="status">
          この PC の VS Code
          に、接続名とテーブルごとに保存します。保存すると画面の絞り込みは外れます
        </span>
      </div>
    </div>
  );
}
