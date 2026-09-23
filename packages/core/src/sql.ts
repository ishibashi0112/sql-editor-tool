// SQL 断片の組み立て。値は必ず Param として埋め込み、SQL 文字列に連結しない（CLAUDE.md）。
// sql`...` に埋め込めるのは Sql と Param だけにして、利用者の入力が生の SQL になる経路を型で塞ぐ。

import type { Dialect } from "./dialect";
import { QueryBuildError } from "./errors";

/** バインド変数の型。ドライバのアダプタがこれを見て DB 側の型を決める */
export type ParamType =
  | { kind: "string"; unicode: boolean }
  | { kind: "number" }
  | { kind: "integer" };

/** SQL に埋め込むバインド値。number 型の値は精度を保つため文字列のこともある */
export class Param {
  constructor(
    readonly value: string | number,
    readonly type: ParamType,
  ) {}
}

type Part = string | Param;

export class Sql {
  constructor(readonly parts: readonly Part[]) {}
}

export function sql(
  strings: TemplateStringsArray,
  ...values: readonly (Sql | Param)[]
): Sql {
  const parts: Part[] = [];
  for (const [i, text] of strings.entries()) {
    if (text) parts.push(text);
    const value = values[i];
    if (value instanceof Sql) parts.push(...value.parts);
    else if (value instanceof Param) parts.push(value);
  }
  return new Sql(parts);
}

/** 識別子（引用済み）や固定のキーワードだけに使う。利用者の入力を渡さないこと */
export function raw(text: string): Sql {
  return new Sql([text]);
}

export function join(items: readonly Sql[], separator: string): Sql {
  const parts: Part[] = [];
  for (const [i, item] of items.entries()) {
    if (i > 0) parts.push(separator);
    parts.push(...item.parts);
  }
  return new Sql(parts);
}

/** 条件を AND で結ぶ。null は無視し、2 つ以上なら括弧で囲む */
export function and(items: readonly [Sql, ...(Sql | null)[]]): Sql;
export function and(items: readonly (Sql | null)[]): Sql | null;
export function and(items: readonly (Sql | null)[]): Sql | null {
  return combine(items, " AND ");
}

/** 条件を OR で結ぶ。null は無視し、2 つ以上なら括弧で囲む */
export function or(items: readonly [Sql, ...(Sql | null)[]]): Sql;
export function or(items: readonly (Sql | null)[]): Sql | null;
export function or(items: readonly (Sql | null)[]): Sql | null {
  return combine(items, " OR ");
}

function combine(
  items: readonly (Sql | null)[],
  separator: string,
): Sql | null {
  const present = items.filter((item): item is Sql => item !== null);
  const [first] = present;
  if (first === undefined) return null;
  if (present.length === 1) return first;
  return sql`(${join(present, separator)})`;
}

export type BoundParam = {
  name: string;
  value: string | number;
  type: ParamType;
};

/** ドライバに渡す形。バインド変数の名前は出現順に p1, p2, … */
export function renderBind(
  fragment: Sql,
  dialect: Dialect,
): { sql: string; params: BoundParam[] } {
  const params: BoundParam[] = [];
  let text = "";
  for (const part of fragment.parts) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    const name = `p${params.length + 1}`;
    params.push({ name, value: part.value, type: part.type });
    text += dialect.placeholder(name);
  }
  if (params.length > dialect.maxParams) {
    throw new QueryBuildError(
      `条件の値が多すぎます（${params.length} 個、上限 ${dialect.maxParams} 個）。選択する値を減らすか、「これ以外」で指定してください`,
    );
  }
  return { sql: text, params };
}

/** A5:SQL Mk-2 などに貼るための、値をリテラルに展開した SQL。表示とコピー専用で、実行には使わない */
export function renderLiteral(fragment: Sql, dialect: Dialect): string {
  let text = "";
  for (const part of fragment.parts) {
    text += typeof part === "string" ? part : dialect.literal(part);
  }
  return text;
}
