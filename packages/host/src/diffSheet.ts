// 差分カメラ（D-47）の差分を、Excel に貼る・保存する形（行と列の表）にする。VS Code に依存しない。
// 変わった行は「変更前」「変更後」の 2 行にして、値を 1 セルに 1 つ入れる（Excel で数値のまま扱える）

import type { DiffTableView, DiffView } from "./diffCameraProtocol";
import type { CellValue } from "./session";

export type SheetRowKind =
  /** 見出し（カメラの名前と接続） */
  | "title"
  /** 撮った時刻 */
  | "meta"
  | "blank"
  /** 表の見出し（表の名前と、変更・追加・削除の数） */
  | "table"
  /** 条件や、キーがないときの断り */
  | "note"
  /** 撮れなかった理由 */
  | "error"
  /** 列の見出し（物理名）と、その下の論理名 */
  | "header"
  | "headerLogical"
  | "before"
  | "after"
  | "added"
  | "deleted";

export type SheetRow = {
  kind: SheetRowKind;
  cells: CellValue[];
  /** 変わったセルの添字（cells の。before と after の行） */
  changed?: number[];
  /** キーの列の添字（cells の。header と headerLogical の行） */
  keys?: number[];
};

/** 表の行の最初の列（区分） */
export const SHEET_KIND_LABELS = {
  before: "変更前",
  after: "変更後",
  added: "追加",
  deleted: "削除",
} as const;

/**
 * 表に出す列の添字。「変わった列だけ」なら、キーの列と、どれかの行で変わった列。
 * 変わった行がなければ（追加・削除だけ）、全部の列
 */
export function shownColumns(
  table: DiffTableView,
  changedOnly: boolean,
): number[] {
  const changed = new Set(table.changedColumns);
  return table.columns.flatMap((column, index) =>
    !changedOnly || changed.size === 0 || column.key || changed.has(index)
      ? [index]
      : [],
  );
}

/** 「変更 1 行・追加 2 行」。変化がなければ「変化なし（N 行）」 */
export function tableSummary(table: DiffTableView): string {
  const { added, deleted, changed, unchanged } = table.counts;
  if (added + deleted + changed === 0) {
    return `変化なし（${unchanged.toLocaleString("ja-JP")} 行）`;
  }
  return [
    changed > 0 ? `変更 ${changed.toLocaleString("ja-JP")} 行` : "",
    added > 0 ? `追加 ${added.toLocaleString("ja-JP")} 行` : "",
    deleted > 0 ? `削除 ${deleted.toLocaleString("ja-JP")} 行` : "",
  ]
    .filter((s) => s !== "")
    .join("・");
}

/** 「（キー：品目コード・倉庫）」。キーがなければ空 */
export function keySummary(table: DiffTableView): string {
  const names = table.columns
    .filter((c) => c.key)
    .map((c) => c.logicalName ?? c.name);
  if (table.keySource === "none" || names.length === 0) return "";
  return `（キー：${names.join("・")}${table.keySource === "settings" ? "。列の設定で指定" : ""}）`;
}

/** 差分を、Excel に貼る・保存する行の並びにする（表を縦に並べる） */
export function diffSheet(
  view: DiffView,
  options: { changedOnly: boolean },
): SheetRow[] {
  const rows: SheetRow[] = [
    {
      kind: "title",
      cells: [`差分カメラ「${view.camera}」（${view.connection}）`],
    },
    {
      kind: "meta",
      cells: [`前 ${dateTime(view.beforeAt)} → 後 ${dateTime(view.afterAt)}`],
    },
  ];
  for (const table of view.tables) {
    rows.push({ kind: "blank", cells: [] });
    const name = table.logicalName
      ? `${table.logicalName} ${table.name}`
      : table.name;
    if (table.error) {
      rows.push({ kind: "table", cells: [name] });
      if (table.where)
        rows.push({ kind: "note", cells: [`条件：${table.where}`] });
      rows.push({ kind: "error", cells: [`撮れませんでした：${table.error}`] });
      continue;
    }
    const { added, deleted, changed } = table.counts;
    const same = added + deleted + changed === 0;
    rows.push({
      kind: "table",
      cells: [
        `${name}　${tableSummary(table)}${same ? "" : keySummary(table)}`,
      ],
    });
    if (table.where)
      rows.push({ kind: "note", cells: [`条件：${table.where}`] });
    if (same) continue;
    if (table.keySource === "none") {
      rows.push({
        kind: "note",
        cells: [
          "主キーもキーの設定もないので、中身が変わった行は削除と追加で出しています",
        ],
      });
    }
    if (table.columnsChanged) {
      rows.push({
        kind: "note",
        cells: ["前と後で表の列が変わっています（後の列で比べています）"],
      });
    }
    const shown = shownColumns(table, options.changedOnly);
    // 区分の列の分、1 つずらす
    const keys = shown.flatMap((index, i) =>
      table.columns[index]?.key ? [i + 1] : [],
    );
    rows.push({
      kind: "header",
      cells: ["区分", ...shown.map((i) => table.columns[i]?.name ?? "")],
      keys,
    });
    if (shown.some((i) => table.columns[i]?.logicalName)) {
      rows.push({
        kind: "headerLogical",
        cells: ["", ...shown.map((i) => table.columns[i]?.logicalName ?? "")],
        keys,
      });
    }
    const pick = (values: readonly CellValue[]) =>
      shown.map((i) => values[i] ?? null);
    for (const row of table.rows) {
      if (row.kind === "changed") {
        const changedCells = shown.flatMap((index, i) =>
          row.changed.includes(index) ? [i + 1] : [],
        );
        rows.push({
          kind: "before",
          cells: [SHEET_KIND_LABELS.before, ...pick(row.before)],
          changed: changedCells,
        });
        rows.push({
          kind: "after",
          cells: [SHEET_KIND_LABELS.after, ...pick(row.values)],
          changed: changedCells,
        });
      } else {
        rows.push({
          kind: row.kind,
          cells: [SHEET_KIND_LABELS[row.kind], ...pick(row.values)],
        });
      }
    }
    if (table.more > 0) {
      rows.push({
        kind: "note",
        cells: [
          `ほかに ${table.more.toLocaleString("ja-JP")} 行あります（「Excel で保存」で全部出せます）`,
        ],
      });
    }
  }
  return rows;
}

/** タブ区切りの文字（Excel に貼ると、セルに分かれる）。NULL は「NULL」 */
export function sheetTsv(rows: readonly SheetRow[]): string {
  return rows
    .map((row) => row.cells.map((value) => tsvCell(value)).join("\t"))
    .join("\r\n");
}

function tsvCell(value: CellValue): string {
  const text = value === null ? "NULL" : String(value);
  return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * 色の付いた HTML の表（Excel に貼ると、色と罫線も付く）。文字の値は文字のまま貼られるようにする。
 * Excel は HTML のセルを「折り返して全体を表示」で貼るので、折り返さない指定と列の幅を付ける
 * （付けないと、見出しの長い文が狭い A 列で何行にも折り返される）
 */
export function sheetHtml(rows: readonly SheetRow[]): string {
  const cols = sheetColumnWidths(rows)
    .map((chars) => {
      const px = Math.round(chars * 7.5 + 10);
      return `<col width="${px}" style="width:${Math.round(px * 0.75)}pt">`;
    })
    .join("");
  const body = rows
    .map((row) => {
      const cells = row.cells.map((value, i) => {
        const style = cellStyle(row, i, value);
        const text = value === null ? "NULL" : String(value);
        return `<td style="${style}">${escapeHtml(text)}</td>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("\n");
  return `<meta charset="utf-8"><table style="border-collapse:collapse;font-family:'游ゴシック','Yu Gothic',sans-serif;font-size:11pt">\n<colgroup>${cols}</colgroup>\n${body}\n</table>`;
}

/**
 * 列の幅（文字数。全角は 2）。表の中の行（列見出しと値）だけで測り、8〜60 に収める。
 * 見出しや断りの長い文は、隣の空いたセルにはみ出して見える
 */
export function sheetColumnWidths(rows: readonly SheetRow[]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    if (!isGridRow(row.kind)) continue;
    row.cells.forEach((value, i) => {
      const text = value === null ? "NULL" : String(value);
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(text));
    });
  }
  return Array.from(widths, (w) => Math.min(Math.max((w ?? 0) + 2, 8), 60));
}

/** 表示の幅（全角は 2。改行があれば 1 行目） */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text.split("\n")[0] ?? "") {
    width +=
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(
        ch,
      )
        ? 2
        : 1;
  }
  return width;
}

/** 色（Excel の保存にも使う。先頭の # なしの RGB） */
export const SHEET_COLORS = {
  border: "D9D9D9",
  header: "F2F2F2",
  keyHeader: "DDEBF7",
  changedBefore: "FCE4E4",
  changedAfter: "FFF2CC",
  added: "E2EFDA",
  deleted: "FCE4E4",
  muted: "7F7F7F",
  nullText: "A6A6A6",
  addedText: "375623",
  deletedText: "C00000",
  error: "C00000",
} as const;

/** 表の中（罫線を引く）の行か */
export function isGridRow(kind: SheetRowKind): boolean {
  return (
    kind === "header" ||
    kind === "headerLogical" ||
    kind === "before" ||
    kind === "after" ||
    kind === "added" ||
    kind === "deleted"
  );
}

function cellStyle(row: SheetRow, index: number, value: CellValue): string {
  const c = SHEET_COLORS;
  const grid = isGridRow(row.kind);
  // 貼ったときに折り返さない
  const styles: string[] = ["white-space:nowrap"];
  if (grid) styles.push(`border:.5pt solid #${c.border}`);
  switch (row.kind) {
    case "title":
      styles.push("font-weight:bold", "font-size:12pt");
      break;
    case "table":
      styles.push("font-weight:bold");
      break;
    case "meta":
    case "note":
      styles.push(`color:#${c.muted}`);
      break;
    case "error":
      styles.push(`color:#${c.error}`);
      break;
    case "header":
    case "headerLogical":
      styles.push(
        `background:#${row.keys?.includes(index) ? c.keyHeader : c.header}`,
      );
      if (row.kind === "header") styles.push("font-weight:bold");
      break;
    case "before":
      styles.push(`color:#${c.muted}`);
      if (row.changed?.includes(index))
        styles.push(`background:#${c.changedBefore}`);
      break;
    case "after":
      if (row.changed?.includes(index))
        styles.push(`background:#${c.changedAfter}`, "font-weight:bold");
      break;
    case "added":
      styles.push(`background:#${c.added}`);
      if (index === 0) styles.push(`color:#${c.addedText}`);
      break;
    case "deleted":
      styles.push(`background:#${c.deleted}`);
      if (index === 0) styles.push(`color:#${c.deletedText}`);
      break;
    case "blank":
      break;
  }
  if (
    grid &&
    index === 0 &&
    row.kind !== "header" &&
    row.kind !== "headerLogical"
  )
    styles.push("font-weight:bold");
  if (value === null && grid) styles.push(`color:#${c.nullText}`);
  // 「00123」や「2026-09-27」を、Excel が数値や日付に変えないように
  if (typeof value === "string") styles.push("mso-number-format:'\\@'");
  return styles.join(";");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\r\n", "\n")
    .replaceAll("\n", '<br style="mso-data-placement:same-cell">');
}

/** 年/月/日 時:分:秒（その PC の時刻） */
export function dateTime(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
