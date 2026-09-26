// 段階2：利用者が書いたベースSQL を FROM 句の派生テーブルとして包む（docs/handover.md §5 段階2、§6）。
// レポート（§16）の SQL もここで扱う。レポートでは :名前 をバインド変数に置き換え、そのままでも、包んでも実行する。
// 包むこと自体が読み取り専用の守りになる（派生テーブルの中には問い合わせしか書けない）。
// ここでの字句の検査は、DB のエラーより分かりやすいメッセージを出すためのもの。
// ただし SQL Server で WITH を外に出す部分だけは括弧の外に出るので、CTE の並びを厳密に確かめる

import type { Dialect } from "./dialect";
import { QueryBuildError } from "./errors";
import { join, raw, type Sql, sql } from "./sql";

/** 派生テーブルの別名。Oracle は AS を付けられないので、どちらの方言でも付けない */
const ALIAS = "base_query";

export type TokenKind =
  | "word"
  | "quoted"
  | "string"
  /** :名前（レポートのパラメータ。D-28）。どちらの方言でも同じ */
  | "named"
  /** それ以外のバインド変数（SQL Server の @x、Oracle の :1）。使えない */
  | "param"
  | "punct"
  | "other";

export type Token = {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  /** 括弧の深さ。( と ) は外側の深さ */
  depth: number;
};

const WORD_START = /[\p{L}_#]/u;
const WORD_PART = /[\p{L}\p{N}_$#@]/u;
const NAME_START = /[\p{L}_]/u;
const NAME_PART = /[\p{L}\p{N}_]/u;

/** 字句に分ける。文字列・引用符つき識別子・コメントの中の記号を構文と取り違えないため */
export function tokenize(dialect: Dialect, text: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number, d = depth) => {
    tokens.push({ kind, text: text.slice(start, end), start, end, depth: d });
  };
  /** 1 文字の close が現れるまで読み、その直後の位置を返す。close を 2 つ重ねたものは close の文字そのもの */
  const until = (from: number, close: string, what: string): number => {
    let j = from;
    for (;;) {
      const k = text.indexOf(close, j);
      if (k < 0) throw new QueryBuildError(`SQL の${what}が閉じていません`);
      if (text.charAt(k + 1) !== close) return k + 1;
      j = k + 2;
    }
  };

  while (i < text.length) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "-" && next === "-") {
      const k = text.indexOf("\n", i);
      i = k < 0 ? text.length : k + 1;
    } else if (c === "/" && next === "*") {
      i = skipBlockComment(dialect, text, i);
    } else if (c === "'") {
      const end = until(i + 1, "'", "文字列");
      push("string", i, end);
      i = end;
    } else if (c === '"') {
      const end = until(i + 1, '"', "引用符つきの名前");
      push("quoted", i, end);
      i = end;
    } else if (c === "[" && dialect.name === "mssql") {
      const end = until(i + 1, "]", "[ ] で囲んだ名前");
      push("quoted", i, end);
      i = end;
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < text.length && WORD_PART.test(text.charAt(j))) j += 1;
      const word = text.slice(i, j).toUpperCase();
      if (text.charAt(j) === "'" && (word === "N" || isQQuote(dialect, word))) {
        const end =
          word === "N" ? until(j + 1, "'", "文字列") : skipQQuote(text, j);
        push("string", i, end);
        i = end;
      } else {
        push("word", i, j);
        i = j;
      }
    } else if (c === "@" && dialect.name === "mssql") {
      // @@ROWCOUNT などのシステム関数は変数ではない
      const isSystem = next === "@";
      let j = i + (isSystem ? 2 : 1);
      while (j < text.length && WORD_PART.test(text.charAt(j))) j += 1;
      push(isSystem || j === i + 1 ? "other" : "param", i, j);
      i = j;
    } else if (c === ":" && next === ":") {
      // PostgreSQL の型変換（col::text）や SQL Server の geometry::Point など。パラメータではない
      push("other", i, i + 2);
      i += 2;
    } else if (c === ":" && NAME_START.test(next)) {
      // :名前（D-28）。日本語の名前も使える
      let j = i + 1;
      while (j < text.length && NAME_PART.test(text.charAt(j))) j += 1;
      push("named", i, j);
      i = j;
    } else if (c === ":" && /\d/.test(next)) {
      // Oracle の :1 のような番号のバインド変数
      let j = i + 1;
      while (j < text.length && /\d/.test(text.charAt(j))) j += 1;
      push("param", i, j);
      i = j;
    } else if (c === "(") {
      push("punct", i, i + 1);
      depth += 1;
      i += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth < 0) {
        throw new QueryBuildError("SQL の括弧の対応が取れていません");
      }
      push("punct", i, i + 1);
      i += 1;
    } else if (c === "," || c === ";") {
      push("punct", i, i + 1);
      i += 1;
    } else {
      push("other", i, i + 1);
      i += 1;
    }
  }
  if (depth !== 0) {
    throw new QueryBuildError("SQL の括弧の対応が取れていません");
  }
  return tokens;
}

function skipBlockComment(
  dialect: Dialect,
  text: string,
  from: number,
): number {
  // SQL Server のブロックコメントは入れ子にできる。Oracle はできない
  let nest = 0;
  let i = from;
  while (i < text.length) {
    if (text.startsWith("/*", i)) {
      nest += 1;
      i += 2;
      if (dialect.name === "oracle" && nest > 1) nest = 1;
    } else if (text.startsWith("*/", i)) {
      nest -= 1;
      i += 2;
      if (nest === 0) return i;
    } else {
      i += 1;
    }
  }
  throw new QueryBuildError("SQL のコメントが閉じていません");
}

function isQQuote(dialect: Dialect, word: string): boolean {
  return dialect.name === "oracle" && (word === "Q" || word === "NQ");
}

/** Oracle の代替引用符 q'[...]'。quote は ' の位置 */
function skipQQuote(text: string, quote: number): number {
  const open = text.charAt(quote + 1);
  const pairs: Record<string, string> = {
    "[": "]",
    "(": ")",
    "{": "}",
    "<": ">",
  };
  const close = `${pairs[open] ?? open}'`;
  const k = text.indexOf(close, quote + 2);
  if (!open || k < 0) throw new QueryBuildError("SQL の文字列が閉じていません");
  return k + close.length;
}

const isWord = (token: Token | undefined, word: string) =>
  token?.kind === "word" && token.text.toUpperCase() === word;
const isPunct = (token: Token | undefined, char: string) =>
  token?.kind === "punct" && token.text === char;

/** :名前（: は除いた名前）を、実行する SQL の断片（バインド変数など）に置き換える */
export type NamedParamResolver = (name: string) => Sql;

type PrepareOptions = {
  /** エラーのメッセージに出す呼び名 */
  what: string;
  /** :名前 の置き換え。ないときは :名前 を使えない（ベースSQL） */
  resolve?: NamedParamResolver | undefined;
  /** 派生テーブルで包む。包まないときは、文をそのまま実行する（レポートの実行） */
  wrap: boolean;
  /**
   * 包むとき、SQL Server の最上位の ORDER BY（TOP も OFFSET もないもの）を取り除く。
   * false ならエラーにする（ベースSQL、D-17）。レポートは、そのまま実行するときは ORDER BY が効き、
   * 画面の絞り込みで取り直すときは画面の並べ替えを使うので、取り除いてよい
   */
  dropOrderBy?: boolean;
};

type Prepared = {
  /** SQL Server で外側の SELECT の前に出す WITH 句。なければ null */
  withClause: Sql | null;
  /** 派生テーブルの中に入れる問い合わせ（包まないときは文そのもの） */
  body: Sql;
};

function prepare(
  dialect: Dialect,
  text: string,
  options: PrepareOptions,
): Prepared {
  const { what } = options;
  let tokens = tokenize(dialect, text);
  let end = text.length;

  // 末尾のセミコロンだけは許す（A5 などからそのまま貼れるように）
  const semicolon = tokens.findIndex((t) => t.depth === 0 && isPunct(t, ";"));
  if (semicolon >= 0) {
    if (!tokens.slice(semicolon).every((t) => isPunct(t, ";"))) {
      throw new QueryBuildError(
        `${what} に書ける文は 1 つだけです（セミコロンで区切った複数の文は使えません）`,
      );
    }
    end = tokens[semicolon]?.start ?? end;
    tokens = tokens.slice(0, semicolon);
  }
  const [first] = tokens;
  if (first === undefined) throw new QueryBuildError(`${what} が空です`);
  if (!isWord(first, "SELECT") && !isWord(first, "WITH")) {
    throw new QueryBuildError(
      `${what} は SELECT か WITH で始まる問い合わせにしてください（読み取り専用）`,
    );
  }
  const param = tokens.find(
    (t) => t.kind === "param" || (t.kind === "named" && !options.resolve),
  );
  if (param) {
    throw new QueryBuildError(
      options.resolve
        ? `${what} のバインド変数（${param.text}）は使えません。入力欄にする値は「:名前」の形で書いてください`
        : `${what} にバインド変数（${param.text}）は使えません。値は列見出しのフィルタで指定してください`,
    );
  }

  const top = tokens.filter((t) => t.depth === 0);
  // SQL Server の WITH は、CTE の並びの後が SELECT であることを確かめる（T-SQL は文をセミコロンなしで続けられるため）
  const main =
    dialect.name === "mssql" && isWord(first, "WITH")
      ? mainSelectAfterCtes(top, what)
      : null;
  for (const [i, t] of top.entries()) {
    if (isWord(t, "INTO")) {
      throw new QueryBuildError(
        `${what} に SELECT ... INTO は使えません（読み取り専用）`,
      );
    }
    if (isWord(t, "FOR") && isWord(top[i + 1], "UPDATE")) {
      throw new QueryBuildError(
        `${what} に FOR UPDATE は使えません（行をロックするため）`,
      );
    }
  }

  const emit = (from: number, to: number) =>
    fragment(text, tokens, from, to, options.resolve);
  if (!options.wrap) {
    return {
      withClause: null,
      body: emit(first.start, trimmedEnd(text, first.start, end)),
    };
  }

  // SQL Server は派生テーブルの中に WITH を書けないので、CTE の並びを外側の SELECT の前に出す
  const bodyStart = main?.start ?? first.start;
  const withClause = main
    ? emit(first.start, trimmedEnd(text, first.start, main.start))
    : null;
  const orderBy =
    dialect.name === "mssql"
      ? topLevelOrderBy(
          top.filter((t) => t.start >= bodyStart),
          end,
        )
      : null;
  if (orderBy && !options.dropOrderBy) {
    throw new QueryBuildError(
      `${what} の ORDER BY は外してください。並べ替えは列見出しで指定します`,
    );
  }
  const bodyEnd = trimmedEnd(text, bodyStart, end);
  const body = orderBy
    ? join2(
        emit(bodyStart, trimmedEnd(text, bodyStart, orderBy.start)),
        orderBy.end < bodyEnd ? emit(orderBy.end, bodyEnd) : null,
      )
    : emit(bodyStart, bodyEnd);
  return { withClause, body };
}

/** text の from〜to を SQL の断片にする。:名前 は resolve で置き換える */
function fragment(
  text: string,
  tokens: readonly Token[],
  from: number,
  to: number,
  resolve: NamedParamResolver | undefined,
): Sql {
  const parts: Sql[] = [];
  let pos = from;
  for (const t of tokens) {
    if (t.kind !== "named" || t.start < from || t.end > to || !resolve) {
      continue;
    }
    parts.push(raw(text.slice(pos, t.start)), resolve(t.text.slice(1)));
    pos = t.end;
  }
  parts.push(raw(text.slice(pos, to)));
  return join(parts, "");
}

function join2(a: Sql, b: Sql | null): Sql {
  return b ? sql`${a}\n${b}` : a;
}

/** 末尾の空白を除いた終わりの位置 */
function trimmedEnd(text: string, from: number, to: number): number {
  return from + text.slice(from, to).trimEnd().length;
}

/**
 * 最上位の字句が「名前 [(列, …)] AS (…) [, …] SELECT」の並びであることを確かめ、最後の SELECT を返す。
 * T-SQL は文をセミコロンなしで続けられるので、ここが緩いと外に出した部分に別の文が紛れ込む
 */
function mainSelectAfterCtes(top: readonly Token[], what: string): Token {
  const fail = () =>
    new QueryBuildError(
      `${what} の WITH 句を解釈できません。「WITH 名前 AS (SELECT ...) SELECT ...」の形にしてください`,
    );
  let i = 1;
  for (;;) {
    const name = top[i];
    if (name?.kind !== "word" && name?.kind !== "quoted") throw fail();
    i += 1;
    // 列名の並び
    if (isPunct(top[i], "(") && isPunct(top[i + 1], ")")) i += 2;
    if (
      !isWord(top[i], "AS") ||
      !isPunct(top[i + 1], "(") ||
      !isPunct(top[i + 2], ")")
    ) {
      throw fail();
    }
    i += 3;
    if (isPunct(top[i], ",")) {
      i += 1;
      continue;
    }
    const main = top[i];
    if (!main || !isWord(main, "SELECT")) {
      throw new QueryBuildError(
        `${what} の WITH 句の後は SELECT にしてください（読み取り専用）`,
      );
    }
    return main;
  }
}

/**
 * SQL Server の派生テーブルには、TOP か OFFSET がないと ORDER BY を書けない。
 * そのような最上位の ORDER BY の範囲（ORDER から、OPTION・FOR の前か文の終わりまで）を返す
 */
function topLevelOrderBy(
  top: readonly Token[],
  end: number,
): { start: number; end: number } | null {
  const index = top.findIndex(
    (t, i) => isWord(t, "ORDER") && isWord(top[i + 1], "BY"),
  );
  const order = top[index];
  if (!order) return null;
  const hasOffset = top.some((t) => isWord(t, "OFFSET"));
  const [, second, third] = top;
  const hasTop =
    isWord(second, "TOP") ||
    ((isWord(second, "DISTINCT") || isWord(second, "ALL")) &&
      isWord(third, "TOP"));
  if (hasOffset || hasTop) return null;
  const after = top
    .slice(index + 2)
    .find((t) => isWord(t, "OPTION") || isWord(t, "FOR"));
  return { start: order.start, end: after?.start ?? end };
}

/** FROM 句に書く対象。WITH 句は SELECT の前に置く */
export type BaseSqlSource = { withClause: Sql | null; from: Sql };

export type BaseSqlOptions = {
  /** レポートの SQL（:名前 を置き換える。ORDER BY は取り除く） */
  resolve?: NamedParamResolver | undefined;
};

export function fromBaseSql(
  dialect: Dialect,
  text: string,
  options: BaseSqlOptions = {},
): BaseSqlSource {
  const report = options.resolve !== undefined;
  const prepared = prepare(dialect, text, {
    what: report ? "SQL" : "ベースSQL",
    resolve: options.resolve,
    wrap: true,
    dropOrderBy: report,
  });
  // 利用者が自分で書いた問い合わせそのもの。上で 1 つの問い合わせであることを確かめ、括弧で包む
  return {
    withClause: prepared.withClause,
    from: sql`(\n${prepared.body}\n) ${raw(ALIAS)}`,
  };
}

/** レポートの SQL を、包まずにそのまま実行する形にする（:名前 は resolve で置き換える） */
export function reportStatement(
  dialect: Dialect,
  text: string,
  resolve: NamedParamResolver,
): Sql {
  return prepare(dialect, text, { what: "SQL", resolve, wrap: false }).body;
}

/**
 * 選択肢の候補を取る SQL（D-34）を、包まずにそのまま実行する形にする。
 * :名前 はまだ使えない（ほかの入力欄の値で候補を絞るのは、必要になったら考える）
 */
export function optionsStatement(dialect: Dialect, text: string): Sql {
  const named = tokenize(dialect, text).find((t) => t.kind === "named");
  if (named) {
    throw new QueryBuildError(
      `候補の SQL には :名前 は使えません（${named.text}）`,
    );
  }
  return prepare(dialect, text, { what: "候補の SQL", wrap: false }).body;
}

/** SQL の中の :名前 の名前（: は除く）。初めに出てきた順、重複なし */
export function namedParams(dialect: Dialect, text: string): string[] {
  const names = tokenize(dialect, text)
    .filter((t) => t.kind === "named")
    .map((t) => t.text.slice(1));
  return [...new Set(names)];
}

/**
 * ベースSQL の結果の列名を確かめる。外側の SELECT で列を名前で参照するので、重複と名前のない列は使えない。
 * names はメタデータ（SQL Server は sp_describe_first_result_set、Oracle は 0 件取得の記述情報）の列名
 */
export function checkBaseColumns(
  dialect: Dialect,
  names: readonly (string | null)[],
): void {
  const unnamed = names.flatMap((name, i) => (name ? [] : [i + 1]));
  if (unnamed.length > 0) {
    throw new QueryBuildError(
      `ベースSQL の ${unnamed.join("、")} 列目に名前がありません。AS で別名を付けてください`,
    );
  }
  // SQL Server の列名は大文字小文字を区別しないことが多い（照合順序による）ので、区別せずに比べる
  const key = (name: string) =>
    dialect.name === "mssql" ? name.toUpperCase() : name;
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const name of names) {
    if (!name) continue;
    const k = key(name);
    if (!seen.has(k)) seen.set(k, name);
    else if (!duplicates.includes(k)) duplicates.push(k);
  }
  if (duplicates.length > 0) {
    const shown = duplicates.map((k) => `「${seen.get(k) ?? k}」`).join("、");
    throw new QueryBuildError(
      `ベースSQL の列名${shown}が重複しています。AS で別名を付けてください`,
    );
  }
}
