// 差分カメラの「Excel で保存」（D-48）。host の diffSheet の行を、色と罫線の付いた .xlsx にする。
// exceljs は大きいので、保存するときに初めて読み込む

import { isGridRow, SHEET_COLORS, type SheetRow } from "@sql-editor-tool/host";
import type { Cell } from "exceljs";

const FONT = "游ゴシック";

export async function sheetXlsx(
  rows: readonly SheetRow[],
  sheetName = "差分",
): Promise<Uint8Array> {
  const { default: Excel } = await import("exceljs");
  const workbook = new Excel.Workbook();
  workbook.creator = "SQL Editor Tool";
  const sheet = workbook.addWorksheet(sheetName);
  const widths: number[] = [];
  rows.forEach((row, r) => {
    const excelRow = sheet.getRow(r + 1);
    const grid = isGridRow(row.kind);
    row.cells.forEach((value, c) => {
      const cell = excelRow.getCell(c + 1);
      cell.value = value === null ? (grid ? "NULL" : null) : value;
      styleCell(cell, row, c, value === null);
      if (grid) {
        const text = value === null ? "NULL" : String(value);
        widths[c] = Math.max(widths[c] ?? 0, displayWidth(text));
      }
    });
  });
  widths.forEach((width, c) => {
    sheet.getColumn(c + 1).width = Math.min(Math.max(width + 2, 8), 60);
  });
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function styleCell(
  cell: Cell,
  row: SheetRow,
  index: number,
  isNull: boolean,
): void {
  const c = SHEET_COLORS;
  const argb = (rgb: string) => `FF${rgb}`;
  const fill = (rgb: string) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: argb(rgb) },
    };
  };
  let bold = false;
  let size = 11;
  let color: string | undefined;
  const grid = isGridRow(row.kind);
  switch (row.kind) {
    case "title":
      bold = true;
      size = 12;
      break;
    case "table":
      bold = true;
      break;
    case "meta":
    case "note":
      color = c.muted;
      break;
    case "error":
      color = c.error;
      break;
    case "header":
    case "headerLogical":
      fill(row.keys?.includes(index) ? c.keyHeader : c.header);
      bold = row.kind === "header";
      break;
    case "before":
      color = c.muted;
      if (row.changed?.includes(index)) fill(c.changedBefore);
      break;
    case "after":
      if (row.changed?.includes(index)) {
        fill(c.changedAfter);
        bold = true;
      }
      break;
    case "added":
      fill(c.added);
      if (index === 0) color = c.addedText;
      break;
    case "deleted":
      fill(c.deleted);
      if (index === 0) color = c.deletedText;
      break;
    case "blank":
      break;
  }
  if (grid && index === 0 && row.kind !== "headerLogical") bold = true;
  if (grid && isNull) color = c.nullText;
  cell.font = {
    name: FONT,
    size,
    bold,
    ...(color ? { color: { argb: argb(color) } } : {}),
  };
  if (grid) {
    const side = { style: "thin" as const, color: { argb: argb(c.border) } };
    cell.border = { top: side, left: side, bottom: side, right: side };
    cell.alignment = { vertical: "top", wrapText: false };
  }
}

/** 列の幅の目安（全角は 2） */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text.split("\n")[0] ?? "") {
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  }
  return width;
}
