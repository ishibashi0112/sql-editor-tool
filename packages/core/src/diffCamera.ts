// 差分カメラ（D-47）の、前後の行の比べ方と、差分の文（「テキストでコピー」）。DB に依存しない

export type DiffValue = string | number | boolean | null;

/** 1 つの表を撮ったもの */
export type TableSnapshot = {
  /** 列名（結果の並び） */
  columns: readonly string[];
  /** 行の同一性を決める列（主キーか、列の設定のキー）。空なら行の中身全体で比べる */
  key: readonly string[];
  rows: readonly (readonly DiffValue[])[];
};

export type RowChange =
  | { kind: "added"; row: readonly DiffValue[] }
  | { kind: "deleted"; row: readonly DiffValue[] }
  | {
      kind: "changed";
      before: readonly DiffValue[];
      after: readonly DiffValue[];
      /** 変わった列の添字（columns の） */
      changed: readonly number[];
    };

export type TableDiff = {
  /** 後の列（前にしかない列は捨てる。表の定義が変わったときは columnsChanged） */
  columns: readonly string[];
  key: readonly string[];
  /** 変更・追加・削除の順（それぞれ撮った順＝キーの順） */
  changes: readonly RowChange[];
  added: number;
  deleted: number;
  changedRows: number;
  unchanged: number;
  /** 前と後で列が違う（表の定義が変わった） */
  columnsChanged: boolean;
};

/**
 * 前と後を比べる。キーがあれば、同じキーの行を比べて変わった列を出す（キーが重複していれば、撮った順に組にする）。
 * キーがなければ、中身がまったく同じ行を組にし、残りを追加と削除にする（変更は出せない）
 */
export function diffTable(
  before: TableSnapshot,
  after: TableSnapshot,
): TableDiff {
  const columns = after.columns;
  const columnsChanged =
    before.columns.length !== columns.length ||
    before.columns.some((name, i) => name !== columns[i]);
  // 前の行を、後の列の並びにそろえる（前にない列は null）
  const index = columns.map((name) => before.columns.indexOf(name));
  const beforeRows = columnsChanged
    ? before.rows.map((row) =>
        index.map((i) => (i < 0 ? null : (row[i] ?? null))),
      )
    : before.rows;
  const key = after.key.filter((name) => columns.includes(name));
  const keyIndex = key.map((name) => columns.indexOf(name));
  const identity =
    keyIndex.length > 0
      ? (row: readonly DiffValue[]) =>
          JSON.stringify(keyIndex.map((i) => row[i]))
      : (row: readonly DiffValue[]) => JSON.stringify(row);

  const waiting = new Map<string, (readonly DiffValue[])[]>();
  for (const row of beforeRows) {
    const id = identity(row);
    const list = waiting.get(id);
    if (list) list.push(row);
    else waiting.set(id, [row]);
  }
  const changed: RowChange[] = [];
  const added: RowChange[] = [];
  let unchanged = 0;
  for (const row of after.rows) {
    const id = identity(row);
    const match = waiting.get(id)?.shift();
    if (match === undefined) {
      added.push({ kind: "added", row });
      continue;
    }
    const diff = columns.flatMap((_, i) =>
      same(match[i] ?? null, row[i] ?? null) ? [] : [i],
    );
    if (diff.length === 0) unchanged += 1;
    else
      changed.push({
        kind: "changed",
        before: match,
        after: row,
        changed: diff,
      });
  }
  // 残った前の行が削除（撮った順のまま）
  const left = new Set<readonly DiffValue[]>();
  for (const list of waiting.values()) for (const row of list) left.add(row);
  const deleted: RowChange[] = beforeRows
    .filter((row) => left.has(row))
    .map((row) => ({ kind: "deleted", row }));

  return {
    columns,
    key,
    changes: [...changed, ...added, ...deleted],
    added: added.length,
    deleted: deleted.length,
    changedRows: changed.length,
    unchanged,
    columnsChanged,
  };
}

function same(a: DiffValue, b: DiffValue): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/** 差分の文に出す表 */
export type DiffTextTable = {
  /** 表の名前（論理名があれば「論理名 物理名」） */
  title: string;
  diff: TableDiff;
  /** 列の呼び名（論理名、なければ物理名）。columns と同じ並び */
  labels: readonly string[];
  /** 撮れなかった理由（行が多すぎたなど）。あれば差分の代わりに出す */
  error?: string;
};

/**
 * 差分を、検証の記録に貼れる文にする（D-47、プレビューの 3 枚目の形）。
 * 表ごとに見出しの行と、1 行 1 文（✎ 変更・＋ 追加・− 削除）
 */
export function diffText(
  heading: string,
  tables: readonly DiffTextTable[],
): string {
  const lines = [heading];
  for (const table of tables) {
    lines.push("");
    if (table.error) {
      lines.push(`${table.title}　撮れませんでした：${table.error}`);
      continue;
    }
    const { diff, labels } = table;
    lines.push(`${table.title}　${summary(diff)}`);
    const keyIndex = diff.key.map((name) => diff.columns.indexOf(name));
    const pairs = (row: readonly DiffValue[], indexes: readonly number[]) =>
      indexes.map((i) => `${labels[i]}=${show(row[i] ?? null)}`).join("・");
    const all = diff.columns.map((_, i) => i);
    const others = all.filter((i) => !keyIndex.includes(i));
    for (const change of diff.changes) {
      if (change.kind === "changed") {
        const detail = change.changed
          .map(
            (i) =>
              `${labels[i]} ${show(change.before[i] ?? null)} → ${show(change.after[i] ?? null)}`,
          )
          .join("　／　");
        lines.push(`✎ ${pairs(change.after, keyIndex)}　${detail}`);
      } else {
        const mark = change.kind === "added" ? "＋" : "−";
        lines.push(
          keyIndex.length > 0
            ? `${mark} ${pairs(change.row, keyIndex)}　${pairs(change.row, others).replaceAll("・", "　")}`
            : `${mark} ${pairs(change.row, all).replaceAll("・", "　")}`,
        );
      }
    }
  }
  return lines.join("\n");
}

/** 「変更 3 行・追加 1 行」など。変化がなければ「変化なし」 */
export function summary(diff: TableDiff): string {
  const parts = [
    diff.changedRows > 0 ? `変更 ${diff.changedRows} 行` : "",
    diff.added > 0 ? `追加 ${diff.added} 行` : "",
    diff.deleted > 0 ? `削除 ${diff.deleted} 行` : "",
  ].filter((p) => p !== "");
  return parts.length > 0 ? parts.join("・") : "変化なし";
}

function show(value: DiffValue): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return value === "" ? "（空）" : value;
  return String(value);
}
