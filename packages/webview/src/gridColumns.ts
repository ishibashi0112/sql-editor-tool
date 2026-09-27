// 画面の列（ViewColumn）→ グリッドの列定義

import type {
  ColumnFilterTypeOption,
  GridColumn,
} from "@ishibashi0112/spreadsheet-grid";
import {
  columnTypeLabel,
  shortLogicalName,
  ymdToDateKey,
} from "@sql-editor-tool/core";
import type { CellValue, HeaderMode, ViewColumn } from "@sql-editor-tool/host";
import { createElement } from "react";

export type Row = CellValue[];

/** 2 行の列見出し（物理名と論理名）の高さ。compact の既定は 32 */
export const TWO_LINE_HEADER_HEIGHT = 44;

/** 列見出しを 2 行にするか（両方を出す設定で、論理名のある列があるとき） */
export function twoLineHeader(
  columns: readonly ViewColumn[],
  mode: HeaderMode,
): boolean {
  return mode === "both" && hasLogicalNames(columns);
}

export function hasLogicalNames(columns: readonly ViewColumn[]): boolean {
  return columns.some((c) => c.logicalName);
}

export function toGridColumns(
  columns: readonly ViewColumn[],
  mode: HeaderMode = "both",
): GridColumn<Row>[] {
  return columns.map((column, index) => {
    const { type, semantic } = column;
    const isYmd = type.kind === "string" && semantic?.kind === "date";
    const name = column.isKey ? `🔑 ${column.name}` : column.name;
    return {
      key: column.name,
      // 絞り込みの画面などに出る名前。論理名があれば添える
      title: column.logicalName ? `${name}（${column.logicalName}）` : name,
      width: columnWidth(column, mode),
      // yyyymmdd の文字列は、グリッドの日付フィルタが扱える 'YYYY-MM-DD' にして渡す（§11.3 の 5）
      getValue: isYmd
        ? (row) => {
            const value = row[index];
            return typeof value === "string"
              ? (ymdToDateKey(value) ?? value)
              : value;
          }
        : (row) => row[index],
      filterType: filterType(column),
      align: type.kind === "number" ? "right" : "left",
      renderHeader: () => header(column, name, mode),
    };
  });
}

/**
 * 列見出し（D-40）。both は物理名の下に論理名、logical は論理名（なければ物理名）。
 * ツールチップに、物理名・論理名・型・コメントを出す
 */
function header(column: ViewColumn, name: string, mode: HeaderMode) {
  const { logicalName } = column;
  const tooltip = [
    column.name,
    logicalName,
    columnTypeLabel(column.type),
    column.comment,
  ]
    .filter(Boolean)
    .join(" · ");
  const span = (className: string, text: string) =>
    createElement("span", { className }, text);
  const children =
    mode === "physical" || !logicalName
      ? [span("col-name", name)]
      : mode === "logical"
        ? [
            span(
              "col-name",
              `${column.isKey ? "🔑 " : ""}${shortLogicalName(logicalName)}`,
            ),
          ]
        : [span("col-name", name), span("col-logical", logicalName)];
  return createElement(
    "span",
    { className: "col-head", "data-ssg-tooltip": tooltip },
    ...children,
  );
}

function filterType(column: ViewColumn): ColumnFilterTypeOption {
  if (column.semantic?.kind === "date") return "dateSet";
  switch (column.type.kind) {
    // 文字列は候補が多いので、条件（含む・前方一致など）でも絞れる textSet にする（§11.5）
    case "string":
      return "textSet";
    case "number":
      return "numberSet";
    case "datetime":
      return "dateSet";
    case "other":
      return "text";
  }
}

/** 見出しの文字の幅のおおよそ（全角は半角の倍に近い） */
function textWidth(text: string): number {
  let width = 0;
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    // 半角（ASCII・ラテン文字と半角カナ）
    const narrow = code <= 0xff || (code >= 0xff61 && code <= 0xff9f);
    width += narrow ? 8 : 13;
  }
  return width;
}

function columnWidth(column: ViewColumn, mode: HeaderMode): number {
  const { type, logicalName } = column;
  const logical = logicalName ? shortLogicalName(logicalName) : "";
  const label =
    mode === "physical" || !logical
      ? textWidth(column.name)
      : mode === "logical"
        ? textWidth(logical)
        : Math.max(textWidth(column.name), textWidth(logical));
  const byName = label + (column.isKey ? 20 : 0) + 48;
  switch (type.kind) {
    case "string":
      return clamp(Math.max(byName, (type.length ?? 20) * 8 + 24), 80, 320);
    case "number":
      return clamp(byName, 80, 200);
    case "datetime":
      return clamp(byName, 160, 220);
    case "other":
      return clamp(byName, 80, 240);
  }
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));
