// レポート（SQL＋フォーム。docs/handover.md §16、D-26〜D-29）。
// .sql ファイルの先頭のコメントに設定（接続名と入力欄）を JSON で持ち、SQL の中の :名前 をフォームの入力欄にする

import {
  type NamedParamResolver,
  namedParams,
  reportStatement,
  tokenize,
} from "./baseSql";
import { normalizeDateKey, toYmd, ymdToDateKey } from "./dateKey";
import { type Dialect, type DialectName, getDialect } from "./dialect";
import { QueryBuildError } from "./errors";
import { isRelativeDate, resolveRelativeDate } from "./relativeDate";
import { Param, type ParamType, renderBind, sql } from "./sql";

/**
 * 入力欄の種類。
 * - text：文字列（既定）
 * - number：数値
 * - date：日付。DATE 型などの列と比べる（SQL では日付型にして渡す）
 * - ymd：yyyymmdd の文字列の日付。文字列の列と比べる（入力は日付、SQL には 'yyyymmdd' で渡す）
 * - select：選択肢。候補を SQL（options）で取り、打って絞れるリストから選ぶ。SQL には文字列で渡す（D-34）
 */
export type ReportParamType = "text" | "number" | "date" | "ymd" | "select";

const PARAM_TYPES: readonly ReportParamType[] = [
  "text",
  "number",
  "date",
  "ymd",
  "select",
];

export type ReportParamConfig = {
  label?: string;
  type?: ReportParamType;
  /** 空欄では実行できない。省略時は true */
  required?: boolean;
  /** 入力欄に最初に入れておく値。日付の種類では「今日」「月初-1か月」などの相対の日付も書ける（D-32） */
  default?: string;
  /** 選択肢の候補を取る SQL（1 列目＝値、2 列目＝表示名。D-34） */
  options?: string;
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
  /** 選択肢の候補を取る SQL。なければ空文字 */
  options: string;
  /** 種類を設定に書いておらず、DB が推定した種類を使っている（D-35） */
  guessed: boolean;
};

/** DB が推定した入力欄の種類（入力欄の名前 → 種類）。設定に種類がない入力欄に使う（D-35） */
export type GuessedParamTypes = Record<string, ReportParamType>;

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

/** 先頭にレポートの設定のコメント（@report で始まるブロックコメント）があるか */
export function hasReportHeader(text: string): boolean {
  return HEADER.test(text);
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
  guessed: GuessedParamTypes = {},
): ReportParam[] {
  return namedParams(getDialect(dialect), text).map((name) =>
    paramOf(withGuessedTypes(config, guessed), name, config),
  );
}

/**
 * 設定に種類がない入力欄に、DB が推定した種類を入れた設定（実行にも、この種類を使う）
 */
export function withGuessedTypes(
  config: ReportConfig,
  guessed: GuessedParamTypes,
): ReportConfig {
  const params: Record<string, ReportParamConfig> = { ...config.params };
  let changed = false;
  for (const [name, type] of Object.entries(guessed)) {
    const own = Object.hasOwn(params, name) ? params[name] : undefined;
    if (own?.type) continue;
    params[name] = { ...own, type };
    changed = true;
  }
  return changed ? { ...config, params } : config;
}

/** original は利用者の設定（推定した種類を入れる前）。種類を推定したかどうかを決めるのに使う */
function paramOf(
  config: ReportConfig,
  name: string,
  original = config,
): ReportParam {
  const c = ownParam(config, name) ?? {};
  return {
    name,
    label: c.label || name,
    type: c.type ?? "text",
    required: c.required ?? true,
    default: c.default ?? "",
    options: c.options ?? "",
    guessed: c.type !== undefined && !ownParam(original, name)?.type,
  };
}

function ownParam(
  config: ReportConfig,
  name: string,
): ReportParamConfig | undefined {
  // 名前が constructor などでも Object.prototype を拾わないようにする
  return config.params && Object.hasOwn(config.params, name)
    ? config.params[name]
    : undefined;
}

const isDateType = (type: ReportParamType) => type === "date" || type === "ymd";

/** 既定値が相対の日付（今日・月初など）か。そのような入力欄は、開くたびに既定値から計算する（D-33） */
export function hasRelativeDefault(param: ReportParam): boolean {
  return isDateType(param.type) && isRelativeDate(param.default);
}

/** 入力欄に入れる既定値。日付の種類で相対の日付なら、now を基準に 'YYYY-MM-DD' にする */
export function reportDefaultValue(param: ReportParam, now: Date): string {
  return (
    (isDateType(param.type) && resolveRelativeDate(param.default, now)) ||
    param.default
  );
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
      return sql`${new Param(null, nullType(dialect, param.type))}`;
    }
    switch (param.type) {
      case "text":
      case "select":
        return sql`${new Param(input, dialect.reportText)}`;
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

function nullType(dialect: Dialect, type: ReportParamType): ParamType {
  if (type === "number") return { kind: "number" };
  return type === "text" || type === "select"
    ? dialect.reportText
    : { kind: "string", unicode: false };
}

/**
 * 入力欄の種類の推定（SQL Server の sp_describe_undeclared_parameters。D-35）に渡す形。
 * 同じ名前を 2 回使うと推定できない（エラー 11508）ので、:名前 を出現ごとに別のバインド変数にする
 */
export type ReportParamProbe = {
  /** :名前 を出現ごとにバインド変数（SQL Server は @p1, @p2, …）にした SQL */
  sql: string;
  occurrences: {
    /** バインド変数の名前（p1 など。@ は付けない） */
    placeholder: string;
    /** :名前 の名前 */
    name: string;
    /**
     * 「:名前 IS [NOT] NULL」の出現。SQL Server はこの形を int と推定するので、推定に使わない
     * （推定しない変数として宣言して渡す）
     */
    nullCheck: boolean;
  }[];
};

export function reportParamProbe(
  dialectName: DialectName,
  text: string,
): ReportParamProbe {
  const dialect = getDialect(dialectName);
  const tokens = tokenize(dialect, text);
  const named = tokens.flatMap((token, i) => {
    if (token.kind !== "named") return [];
    const next = tokens[i + 1];
    const nullCheck = next?.kind === "word" && next.text.toUpperCase() === "IS";
    return [{ name: token.text.slice(1), nullCheck }];
  });
  const bound = renderBind(
    reportStatement(
      dialect,
      text,
      () => sql`${new Param(null, { kind: "string", unicode: true })}`,
    ),
    dialect,
  );
  // :名前 は SQL の中に出てくる順に置き換わり、バインド変数もその順に番号が付く
  return {
    sql: bound.sql,
    occurrences: bound.params.map((param, i) => ({
      placeholder: param.name,
      name: named[i]?.name ?? "",
      nullCheck: named[i]?.nullCheck ?? false,
    })),
  };
}

/** DB が推定したバインド変数の型（DB に依存しない形）。推定できなかった変数は含めない */
export type DbParamGuess =
  | {
      kind: "string" /** 文字数。上限がない・分からないときは null */;
      length: number | null;
    }
  | { kind: "number" }
  | { kind: "date" }
  | { kind: "other" };

/**
 * 出現ごとの推定（バインド変数の名前 → 型）を、入力欄の種類にまとめる。
 * 名前ごとに、SQL で最初に出てくる出現（IS NULL のものを除く）の推定を使う。
 * 文字列で、名前が日付らしい（開始日、受注日_YMD など）ものは ymd にする。
 * yyyymmdd の文字列の列と比べる >= などは、長さの分からない文字列（nvarchar(4000)）と推定されるため
 */
export function guessReportParamTypes(
  probe: ReportParamProbe,
  guesses: Readonly<Record<string, DbParamGuess>>,
): GuessedParamTypes {
  const types: GuessedParamTypes = {};
  for (const { placeholder, name, nullCheck } of probe.occurrences) {
    const guess = Object.hasOwn(guesses, placeholder)
      ? guesses[placeholder]
      : undefined;
    if (nullCheck || !guess || Object.hasOwn(types, name)) continue;
    switch (guess.kind) {
      case "number":
        types[name] = "number";
        break;
      case "date":
        types[name] = "date";
        break;
      case "string": {
        const { length } = guess;
        const ymdLike = length === null || length === 8 || length >= 4000;
        types[name] = ymdLike && looksLikeDateName(name) ? "ymd" : "text";
        break;
      }
      case "other":
        break;
    }
  }
  return types;
}

/** 名前が日付らしいか（「日」を含む、YMD・DATE を含む、DT で終わる。日数・曜日などは除く） */
export function looksLikeDateName(name: string): boolean {
  return /(?<!曜)日(?![数本])|ymd|date|(?:^|_)dt$/i.test(name);
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
      if (typeof raw.options === "string" && raw.options.trim()) {
        param.options = raw.options;
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
