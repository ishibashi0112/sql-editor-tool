// レポート（SQL＋フォーム。docs/handover.md §16、D-26〜D-29）。
// .sql ファイルの先頭のコメントに設定（接続名と入力欄）を JSON で持ち、SQL の中の :名前 をフォームの入力欄にする

import { type NamedParamResolver, namedParams } from "./baseSql";
import { normalizeDateKey, toYmd, ymdToDateKey } from "./dateKey";
import { type Dialect, type DialectName, getDialect } from "./dialect";
import { QueryBuildError } from "./errors";
import { Param, type ParamType, sql } from "./sql";

/**
 * 入力欄の種類。
 * - text：文字列（既定）
 * - number：数値
 * - date：日付。DATE 型などの列と比べる（SQL では日付型にして渡す）
 * - ymd：yyyymmdd の文字列の日付。文字列の列と比べる（入力は日付、SQL には 'yyyymmdd' で渡す）
 */
export type ReportParamType = "text" | "number" | "date" | "ymd";

const PARAM_TYPES: readonly ReportParamType[] = [
  "text",
  "number",
  "date",
  "ymd",
];

export type ReportParamConfig = {
  label?: string;
  type?: ReportParamType;
  /** 空欄では実行できない。省略時は true */
  required?: boolean;
  /** 入力欄に最初に入れておく値 */
  default?: string;
};

export type ReportConfig = {
  /** 実行する接続の名前（接続の ID は PC ごとに違うので、名前で結び付ける） */
  connection?: string;
  params?: Record<string, ReportParamConfig>;
};

/** フォームの入力欄 1 つ分。設定がなければ既定値で埋める */
export type ReportParam = {
  name: string;
  label: string;
  type: ReportParamType;
  required: boolean;
  default: string;
};

/** フォームに入れた値（入力欄の名前 → 値）。空欄は "" か null */
export type ReportValues = Record<string, string | null | undefined>;

const HEADER = /^\s*\/\*\s*@report\b([\s\S]*?)\*\//;

/**
 * 先頭のコメントの設定を読む。コメントがなければ空の設定。
 * 読めないときは error に理由を入れ、空の設定を返す（SQL だけでも開けるように）
 */
export function parseReportConfig(text: string): {
  config: ReportConfig;
  error: string | null;
} {
  const match = HEADER.exec(text);
  if (!match) return { config: {}, error: null };
  try {
    const json = (match[1] ?? "").trim();
    return { config: sanitize(json ? JSON.parse(json) : {}), error: null };
  } catch (error) {
    return {
      config: {},
      error: `先頭の設定のコメントを読めません（${error instanceof Error ? error.message : String(error)}）`,
    };
  }
}

/** 先頭のコメントの設定を書き換えた全文を返す。コメントがなければ先頭に足す */
export function writeReportConfig(text: string, config: ReportConfig): string {
  // JSON の文字列に */ があるとコメントが途中で閉じるので、\/ と書く（JSON として同じ意味）
  const json = JSON.stringify(sanitize(config), null, 2).replaceAll(
    "*/",
    "*\\/",
  );
  const header = `/* @report\n${json}\n*/`;
  const match = HEADER.exec(text);
  if (!match) return `${header}\n${text}`;
  return header + text.slice(match.index + match[0].length);
}

/** SQL の :名前 ごとの入力欄。並びは SQL に初めて出てくる順 */
export function reportParams(
  dialect: DialectName,
  text: string,
  config: ReportConfig,
): ReportParam[] {
  return namedParams(getDialect(dialect), text).map((name) =>
    paramOf(config, name),
  );
}

function paramOf(config: ReportConfig, name: string): ReportParam {
  // 名前が constructor などでも Object.prototype を拾わないようにする
  const own = config.params && Object.hasOwn(config.params, name);
  const c = own ? (config.params?.[name] ?? {}) : {};
  return {
    name,
    label: c.label || name,
    type: c.type ?? "text",
    required: c.required ?? true,
    default: c.default ?? "",
  };
}

/**
 * :名前 を、フォームの値のバインド変数に置き換える。
 * 空欄は、必須ならエラー、必須でなければ NULL（SQL 側で「(:名前 IS NULL OR 列 = :名前)」と書く）
 */
export function reportResolver(
  dialect: Dialect,
  config: ReportConfig,
  values: ReportValues,
): NamedParamResolver {
  return (name) => {
    const param = paramOf(config, name);
    const input = (Object.hasOwn(values, name) ? (values[name] ?? "") : "")
      .toString()
      .trim();
    const fail = (reason: string) =>
      new QueryBuildError(`「${param.label}」${reason}`, name);
    if (input === "") {
      if (param.required) throw fail("を入力してください");
      return sql`${new Param(null, nullType(param.type))}`;
    }
    switch (param.type) {
      case "text":
        return sql`${new Param(input, { kind: "string", unicode: true })}`;
      case "number": {
        const value = input.replaceAll(",", "");
        if (!NUMERIC.test(value))
          throw fail(`の値「${input}」は数値ではありません`);
        return sql`${new Param(value, { kind: "number" })}`;
      }
      case "date":
      case "ymd": {
        const ymd = inputToYmd(input);
        if (!ymd) throw fail(`の値「${input}」は日付ではありません`);
        const value = sql`${new Param(ymd, { kind: "string", unicode: false })}`;
        // 日付型の列には、言語や日付の書式の設定に左右されない形で日付型にして渡す
        return param.type === "date" ? dialect.dateFromYmd(value) : value;
      }
    }
  };
}

const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** 'YYYY-MM-DD'・'YYYY/M/D'・'YYYYMMDD' を、実在する日付なら 'YYYYMMDD' にする */
function inputToYmd(input: string): string | null {
  if (/^\d{8}$/.test(input)) return ymdToDateKey(input) ? input : null;
  const key = normalizeDateKey(input);
  return key ? toYmd(key) : null;
}

function nullType(type: ReportParamType): ParamType {
  return type === "number"
    ? { kind: "number" }
    : { kind: "string", unicode: type === "text" };
}

/** 読んだ JSON を設定の形にそろえる。知らない項目と、型の違う値は捨てる */
function sanitize(value: unknown): ReportConfig {
  const config: ReportConfig = {};
  if (!isObject(value)) return config;
  if (typeof value.connection === "string" && value.connection) {
    config.connection = value.connection;
  }
  if (isObject(value.params)) {
    const params: Record<string, ReportParamConfig> = {};
    for (const [name, raw] of Object.entries(value.params)) {
      if (!isObject(raw)) continue;
      const param: ReportParamConfig = {};
      if (typeof raw.label === "string" && raw.label) param.label = raw.label;
      if (PARAM_TYPES.includes(raw.type as ReportParamType)) {
        param.type = raw.type as ReportParamType;
      }
      if (typeof raw.required === "boolean") param.required = raw.required;
      if (typeof raw.default === "string" && raw.default) {
        param.default = raw.default;
      }
      params[name] = param;
    }
    if (Object.keys(params).length > 0) config.params = params;
  }
  return config;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
