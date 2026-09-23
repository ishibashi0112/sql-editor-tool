// SQL Server と Oracle の方言の差。WHERE 生成の仕様は docs/handover.md §6

import { type Param, raw, type Sql, sql } from "./sql";

export type DialectName = "mssql" | "oracle";

export type Dialect = {
  readonly name: DialectName;
  quoteIdent(name: string): string;
  placeholder(paramName: string): string;
  /** リテラル展開版の SQL に使う値の表記 */
  literal(param: Param): string;
  /** 空文字を NULL として扱うか（Oracle） */
  readonly emptyStringIsNull: boolean;
  /** LIKE のパターンで ESCAPE '\' が必要な文字 */
  readonly likeSpecialChars: RegExp;
  /** 'yyyymmdd' 文字列の値を日付型にする式 */
  dateFromYmd(value: Sql): Sql;
  /** 固定長文字列（CHAR）の列と比べる値の式 */
  padFixedChar(value: Sql, length: number): Sql;
  /** IN の要素数の上限。超えたら分割して OR で繋ぐ */
  readonly maxInListSize: number;
  /** 1 文あたりのバインド変数の上限 */
  readonly maxParams: number;
};

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export const mssql: Dialect = {
  name: "mssql",
  quoteIdent: (name) => `[${name.replaceAll("]", "]]")}]`,
  placeholder: (paramName) => `@${paramName}`,
  literal: (param) => {
    if (param.type.kind !== "string") return String(param.value);
    const quoted = quoteString(String(param.value));
    return param.type.unicode ? `N${quoted}` : quoted;
  },
  emptyStringIsNull: false,
  // SQL Server の LIKE では [ も文字クラスの開始になる
  likeSpecialChars: /[\\%_[]/g,
  // スタイル 112 = yyyymmdd。言語や DATEFORMAT の設定に左右されない
  dateFromYmd: (value) => sql`CONVERT(date, ${value}, 112)`,
  // SQL Server の = は末尾の空白を無視するので、埋める必要はない
  padFixedChar: (value) => value,
  maxInListSize: Number.POSITIVE_INFINITY,
  // 上限は 2100。件数の制限などの分を残しておく
  maxParams: 2000,
};

export const oracle: Dialect = {
  name: "oracle",
  quoteIdent: (name) => `"${name.replaceAll('"', '""')}"`,
  placeholder: (paramName) => `:${paramName}`,
  literal: (param) =>
    param.type.kind === "string"
      ? quoteString(String(param.value))
      : String(param.value),
  emptyStringIsNull: true,
  likeSpecialChars: /[\\%_]/g,
  dateFromYmd: (value) => sql`TO_DATE(${value}, 'YYYYMMDD')`,
  // CHAR 列とバインド値の比較は空白埋めをしない比較になるため、値の側を列長まで埋める。
  // 列側を RTRIM するとインデックスが効かなくなる
  padFixedChar: (value, length) =>
    sql`RPAD(${value}, ${raw(String(Math.trunc(length)))})`,
  maxInListSize: 1000,
  maxParams: 65535,
};

export function getDialect(name: DialectName): Dialect {
  return name === "mssql" ? mssql : oracle;
}
