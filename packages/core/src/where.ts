// フィルタ記述子 → WHERE 句の条件。対応表と注意点は docs/handover.md §6、グリッド側の意味は §11.1

import {
  nextDateKey,
  normalizeDateKey,
  resolveBuiltinDatePreset,
  toYmd,
} from "./dateKey";
import type { Dialect } from "./dialect";
import { QueryBuildError } from "./errors";
import type {
  ColumnFilterValue,
  ParsedDateFilter,
  ParsedNumberFilter,
  ParsedTextFilter,
  SetSelection,
} from "./filter";
import type { ColumnInfo, ColumnType } from "./schema";
import { and, join, or, Param, raw, type Sql, sql } from "./sql";

/**
 * グリッドの列定義にあるカスタムの日付プリセットを解決する。
 * その ID のカスタムプリセットがなければ undefined（組み込みを探す）
 */
export type ResolveDatePreset = (
  columnKey: string,
  presetId: string,
  now: Date,
) => { from?: string | undefined; to?: string | undefined } | undefined;

export type ConditionOptions = {
  /** 相対日付プリセットの基準時刻。既定は現在時刻 */
  now?: Date;
  resolveDatePreset?: ResolveDatePreset;
};

type Ctx = {
  dialect: Dialect;
  now: Date;
  resolveDatePreset: ResolveDatePreset | undefined;
};

/** 条件の対象の列。ref は引用済みの列名 */
type Col = { info: ColumnInfo; ref: Sql };

type StringType = Extract<ColumnType, { kind: "string" }>;

/** 列ごとの条件（AND で結ぶ前）を、columns の並び順で返す */
export function buildConditions(
  dialect: Dialect,
  columns: readonly ColumnInfo[],
  filters: Readonly<Record<string, ColumnFilterValue>>,
  options: ConditionOptions = {},
): Sql[] {
  const known = new Set(columns.map((column) => column.name));
  for (const key of Object.keys(filters)) {
    if (!known.has(key)) {
      throw new QueryBuildError(`列「${key}」が見つかりません`, key);
    }
  }
  const ctx: Ctx = {
    dialect,
    now: options.now ?? new Date(),
    resolveDatePreset: options.resolveDatePreset,
  };
  const conditions: Sql[] = [];
  for (const info of columns) {
    // 列名が constructor などでも Object.prototype を拾わないようにする
    if (!Object.hasOwn(filters, info.name)) continue;
    const filter = filters[info.name];
    if (filter === undefined) continue;
    const col = { info, ref: raw(dialect.quoteIdent(info.name)) };
    const condition = columnCondition(ctx, col, filter);
    if (condition) conditions.push(condition);
  }
  return conditions;
}

function columnCondition(
  ctx: Ctx,
  col: Col,
  filter: ColumnFilterValue,
): Sql | null {
  switch (filter.kind) {
    case "set":
      return setCondition(ctx, col, filter);
    case "text":
    case "date": {
      // グリッドではどちらも、前後の空白を除いた部分一致
      const value = filter.value.trim();
      return value === ""
        ? null
        : textCondition(ctx, col, { mode: "contains", value });
    }
    case "select":
      return filter.value === ""
        ? null
        : textCondition(ctx, col, { mode: "equals", value: filter.value });
    case "number":
      if (filter.parsed === null) {
        throw new QueryBuildError(
          `「${col.info.name}」の数値の条件「${filter.raw}」を解釈できません`,
          col.info.name,
        );
      }
      return numberCondition(ctx, col, filter.parsed);
    case "numberSet":
      return and([
        filter.condition && numberCondition(ctx, col, filter.condition),
        filter.set && setCondition(ctx, col, filter.set),
      ]);
    case "textSet":
      return and([
        filter.condition && textCondition(ctx, col, filter.condition),
        filter.set && setCondition(ctx, col, filter.set),
      ]);
    case "dateSet":
      return and([
        filter.condition && dateCondition(ctx, col, filter.condition),
        filter.set && setCondition(ctx, col, filter.set),
      ]);
    case "custom":
      throw new QueryBuildError(
        `「${col.info.name}」のカスタムフィルタは SQL に変換できません`,
        col.info.name,
      );
  }
}

// ── 空欄 ──────────────────────────────────────────
// 空欄は NULL と空文字。Oracle は空文字を NULL として扱うので IS NULL だけでよい

function hasEmptyString(ctx: Ctx, col: Col): boolean {
  return col.info.type.kind === "string" && !ctx.dialect.emptyStringIsNull;
}

function blankAtoms(ctx: Ctx, col: Col): [Sql, ...Sql[]] {
  return hasEmptyString(ctx, col)
    ? [sql`${col.ref} IS NULL`, sql`${col.ref} = ''`]
    : [sql`${col.ref} IS NULL`];
}

function notBlankAtoms(ctx: Ctx, col: Col): [Sql, ...Sql[]] {
  return hasEmptyString(ctx, col)
    ? [sql`${col.ref} IS NOT NULL`, sql`${col.ref} <> ''`]
    : [sql`${col.ref} IS NOT NULL`];
}

const blank = (ctx: Ctx, col: Col) => or(blankAtoms(ctx, col));
const notBlank = (ctx: Ctx, col: Col) => and(notBlankAtoms(ctx, col));

// ── 文字列 ────────────────────────────────────────

function requireString(col: Col, what: string): StringType {
  const { type } = col.info;
  if (type.kind !== "string") {
    throw new QueryBuildError(
      `「${col.info.name}」は文字列の列ではないため、${what}は使えません`,
      col.info.name,
    );
  }
  return type;
}

function stringParam(type: StringType, value: string): Param {
  return new Param(value, { kind: "string", unicode: type.unicode });
}

/** 列と = や IN で比べる値の式 */
function stringValue(ctx: Ctx, type: StringType, value: string): Sql {
  const param = sql`${stringParam(type, value)}`;
  // 列長に満たない値だけ埋める（yyyymmdd の CHAR(8) などに RPAD を並べないため）
  if (type.fixedLength && type.length !== null && value.length < type.length) {
    return ctx.dialect.padFixedChar(param, type.length);
  }
  return param;
}

function textCondition(
  ctx: Ctx,
  col: Col,
  parsed: ParsedTextFilter,
): Sql | null {
  switch (parsed.mode) {
    case "blank":
      return blank(ctx, col);
    case "notBlank":
      return notBlank(ctx, col);
    case "equals": {
      const type = requireString(col, "文字列の条件");
      return parsed.value === ""
        ? blank(ctx, col)
        : sql`${col.ref} = ${stringValue(ctx, type, parsed.value)}`;
    }
    case "contains":
    case "startsWith":
    case "endsWith": {
      const type = requireString(col, "文字列の条件");
      if (parsed.value === "") return null;
      const escaped = parsed.value.replace(
        ctx.dialect.likeSpecialChars,
        "\\$&",
      );
      const pattern =
        parsed.mode === "contains"
          ? `%${escaped}%`
          : parsed.mode === "startsWith"
            ? `${escaped}%`
            : `%${escaped}`;
      // CHAR 列は末尾が空白で埋まっているので、後方一致は右の空白を除いて比べる。
      // 後方一致はもともとインデックスが効かないので、RTRIM で失うものはない
      const target =
        parsed.mode === "endsWith" && type.fixedLength
          ? sql`RTRIM(${col.ref})`
          : col.ref;
      return sql`${target} LIKE ${stringParam(type, pattern)} ESCAPE '\\'`;
    }
  }
}

// ── 数値 ──────────────────────────────────────────

const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const SQL_OPERATORS = {
  ">": ">",
  ">=": ">=",
  "<": "<",
  "<=": "<=",
  "=": "=",
  "!=": "<>",
} as const;

function requireNumber(col: Col, what: string): void {
  if (col.info.type.kind !== "number") {
    throw new QueryBuildError(
      `「${col.info.name}」は数値の列ではないため、${what}は使えません`,
      col.info.name,
    );
  }
}

/** 値の選択で届く文字列の数値は、精度を保つため文字列のまま渡す */
function numberParam(col: Col, value: number | string): Param {
  const valid =
    typeof value === "number" ? Number.isFinite(value) : NUMERIC.test(value);
  if (!valid) {
    throw new QueryBuildError(
      `「${col.info.name}」の値「${value}」は数値ではありません`,
      col.info.name,
    );
  }
  return new Param(value, { kind: "number" });
}

function numberCondition(ctx: Ctx, col: Col, parsed: ParsedNumberFilter): Sql {
  switch (parsed.mode) {
    case "blank":
      return blank(ctx, col);
    case "notBlank":
      return notBlank(ctx, col);
    case "comparison":
      requireNumber(col, "数値の条件");
      return sql`${col.ref} ${raw(SQL_OPERATORS[parsed.operator])} ${numberParam(col, parsed.value)}`;
    case "range":
      requireNumber(col, "数値の条件");
      return sql`(${col.ref} >= ${numberParam(col, parsed.min)} AND ${col.ref} <= ${numberParam(col, parsed.max)})`;
  }
}

// ── 日付 ──────────────────────────────────────────

type DateTarget = {
  /** 日付キー（'YYYY-MM-DD'）の値の式 */
  value(key: string): Sql;
  /** 時刻を持ちうるなら、1 日を [当日, 翌日) の範囲で比べる */
  hasTime: boolean;
  /** 空文字を除く条件。SQL Server の文字列の列で、<= や <> に空文字が引っかかるのを防ぐ */
  nonEmpty: Sql | null;
};

function dateTarget(ctx: Ctx, col: Col, what: string): DateTarget {
  const { type, semantic } = col.info;
  if (type.kind === "string" && semantic?.kind === "date") {
    // yyyymmdd の文字列は、文字列の大小と日付の前後が一致するので、そのまま比べる
    return {
      value: (key) => stringValue(ctx, type, toYmd(key)),
      hasTime: false,
      nonEmpty: ctx.dialect.emptyStringIsNull ? null : sql`${col.ref} <> ''`,
    };
  }
  if (type.kind === "datetime") {
    // 日付は 'yyyymmdd' の文字列で渡して SQL 側で変換する。
    // JavaScript の Date で渡すと、ドライバのタイムゾーン変換で日がずれることがある
    return {
      value: (key) =>
        ctx.dialect.dateFromYmd(
          sql`${new Param(toYmd(key), { kind: "string", unicode: false })}`,
        ),
      hasTime: type.hasTime,
      nonEmpty: null,
    };
  }
  throw new QueryBuildError(
    `「${col.info.name}」は日付の列ではないため、${what}は使えません。yyyymmdd の文字列なら、列の意味型を日付にしてください`,
    col.info.name,
  );
}

function dateKey(col: Col, text: string): string {
  const key = normalizeDateKey(text);
  if (key === null) {
    throw new QueryBuildError(
      `「${col.info.name}」の日付「${text}」が正しくありません`,
      col.info.name,
    );
  }
  return key;
}

/** プリセットを絶対の条件にする。解決できなければ null（グリッドと同じく条件なし） */
function resolvePreset(
  ctx: Ctx,
  col: Col,
  parsed: ParsedDateFilter,
): Exclude<ParsedDateFilter, { mode: "preset" }> | null {
  if (parsed.mode !== "preset") return parsed;
  // グリッドと同じく、列定義のカスタムプリセットを組み込みより優先する
  const range =
    ctx.resolveDatePreset?.(col.info.name, parsed.preset, ctx.now) ??
    resolveBuiltinDatePreset(parsed.preset, ctx.now);
  if (!range) return null;
  const from = range.from === undefined ? null : normalizeDateKey(range.from);
  const to = range.to === undefined ? null : normalizeDateKey(range.to);
  if (from !== null && to !== null) {
    return from <= to
      ? { mode: "range", from, to }
      : { mode: "range", from: to, to: from };
  }
  if (from !== null) return { mode: "onOrAfter", value: from };
  if (to !== null) return { mode: "onOrBefore", value: to };
  return null;
}

function dateCondition(
  ctx: Ctx,
  col: Col,
  parsed: ParsedDateFilter,
): Sql | null {
  const resolved = resolvePreset(ctx, col, parsed);
  if (resolved === null) return null;
  if (resolved.mode === "blank") return blank(ctx, col);
  if (resolved.mode === "notBlank") return notBlank(ctx, col);

  const target = dateTarget(ctx, col, "日付の条件");
  const c = col.ref;
  const day = (text: string) => target.value(dateKey(col, text));
  const nextDay = (text: string) =>
    target.value(nextDateKey(dateKey(col, text)));

  switch (resolved.mode) {
    case "equals":
      return target.hasTime
        ? sql`(${c} >= ${day(resolved.value)} AND ${c} < ${nextDay(resolved.value)})`
        : sql`${c} = ${day(resolved.value)}`;
    case "notEquals":
      return target.hasTime
        ? sql`(${c} < ${day(resolved.value)} OR ${c} >= ${nextDay(resolved.value)})`
        : and([sql`${c} <> ${day(resolved.value)}`, target.nonEmpty]);
    case "onOrAfter":
      return sql`${c} >= ${day(resolved.value)}`;
    case "onOrBefore":
      return target.hasTime
        ? sql`${c} < ${nextDay(resolved.value)}`
        : and([sql`${c} <= ${day(resolved.value)}`, target.nonEmpty]);
    case "range":
      return target.hasTime
        ? sql`(${c} >= ${day(resolved.from)} AND ${c} < ${nextDay(resolved.to)})`
        : sql`(${c} >= ${day(resolved.from)} AND ${c} <= ${day(resolved.to)})`;
  }
}

// ── 値の選択（集合フィルタ） ──────────────────────

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** 選択肢の値 1 つを、列と = や IN で比べる値の式にする */
function setValue(ctx: Ctx, col: Col, value: string): Sql {
  const { type, semantic } = col.info;
  switch (type.kind) {
    case "string":
      // yyyymmdd の列は、グリッドに 'YYYY-MM-DD' で渡している。日付でない値（'00000000' など）はそのまま届く
      if (semantic?.kind === "date" && DATE_KEY.test(value)) {
        return stringValue(ctx, type, toYmd(dateKey(col, value)));
      }
      return stringValue(ctx, type, value);
    case "number":
      return sql`${numberParam(col, value)}`;
    case "datetime":
      return dateTarget(ctx, col, "値の選択").value(dateKey(col, value));
    case "other":
      throw new QueryBuildError(
        `「${col.info.name}」（${type.dbTypeName}）は値の選択で絞り込めません`,
        col.info.name,
      );
  }
}

/** 値のどれかに一致する条件（positive は OR で、negative は AND で結ぶ） */
function matchValues(
  ctx: Ctx,
  col: Col,
  values: readonly string[],
): { positive: Sql[]; negative: Sql[] } | null {
  const c = col.ref;
  const { type } = col.info;
  if (type.kind === "datetime" && type.hasTime) {
    // 時刻を持ちうる列は IN で比べられないので、日ごとの範囲にする
    const target = dateTarget(ctx, col, "値の選択");
    const ranges = values.map((value) => {
      const key = dateKey(col, value);
      return sql`(${c} >= ${target.value(key)} AND ${c} < ${target.value(nextDateKey(key))})`;
    });
    const anyRange = or(ranges);
    return anyRange && { positive: ranges, negative: [sql`NOT ${anyRange}`] };
  }

  const items = values.map((value) => setValue(ctx, col, value));
  const [only] = items;
  if (only === undefined) return null;
  if (items.length === 1) {
    return {
      positive: [sql`${c} = ${only}`],
      negative: [sql`${c} <> ${only}`],
    };
  }
  // Oracle は IN の要素が 1000 個までなので、分けて繋ぐ
  const chunks: Sql[] = [];
  for (let i = 0; i < items.length; i += ctx.dialect.maxInListSize) {
    chunks.push(join(items.slice(i, i + ctx.dialect.maxInListSize), ", "));
  }
  return {
    positive: chunks.map((list) => sql`${c} IN (${list})`),
    negative: chunks.map((list) => sql`${c} NOT IN (${list})`),
  };
}

function setCondition(ctx: Ctx, col: Col, selection: SetSelection): Sql | null {
  const values = [...new Set(selection.values)];
  const hasBlank = values.includes("");
  const match = matchValues(
    ctx,
    col,
    values.filter((value) => value !== ""),
  );

  if (selection.mode === "exclude") {
    // values は「選ばなかった値」。NOT IN だけだと NULL の行まで消えるので、空欄の扱いを明示する
    if (hasBlank) {
      return and([...notBlankAtoms(ctx, col), ...(match?.negative ?? [])]);
    }
    return match ? or([and(match.negative), ...blankAtoms(ctx, col)]) : null;
  }

  // 何も選ばなければ 1 行も出さない（グリッドと同じ）
  return (
    or([
      ...(match?.positive ?? []),
      ...(hasBlank ? blankAtoms(ctx, col) : []),
    ]) ?? sql`1 = 0`
  );
}
