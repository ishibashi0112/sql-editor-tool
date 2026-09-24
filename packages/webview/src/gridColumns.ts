// 画面の列（ViewColumn）→ グリッドの列定義

import type {
  ColumnFilterTypeOption,
  GridColumn,
} from "@ishibashi0112/spreadsheet-grid";
import { ymdToDateKey } from "@sql-editor-tool/core";
import type { CellValue, ViewColumn } from "@sql-editor-tool/host";

export type Row = CellValue[];

export function toGridColumns(
  columns: readonly ViewColumn[],
): GridColumn<Row>[] {
  return columns.map((column, index) => {
    const { type, semantic } = column;
    const isYmd = type.kind === "string" && semantic?.kind === "date";
    return {
      key: column.name,
      title: column.isKey ? `🔑 ${column.name}` : column.name,
      width: columnWidth(column),
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
    };
  });
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

function columnWidth(column: ViewColumn): number {
  const { type } = column;
  const byName = column.name.length * 9 + 48;
  switch (type.kind) {
    case "string":
      return clamp(Math.max(byName, (type.length ?? 20) * 8 + 24), 80, 320);
    case "number":
      return clamp(byName, 80, 160);
    case "datetime":
      return clamp(byName, 160, 200);
    case "other":
      return clamp(byName, 80, 240);
  }
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));
