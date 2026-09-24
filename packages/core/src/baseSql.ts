// 段階2：利用者が書いたベースSQL を FROM 句の派生テーブルとして包む（docs/handover.md §5 段階2、§6）。
// 包むこと自体が読み取り専用の守りになる（派生テーブルの中には問い合わせしか書けない）。
// ここでの字句の検査は、DB のエラーより分かりやすいメッセージを出すためのもの。
// ただし SQL Server で WITH を外に出す部分だけは括弧の外に出るので、CTE の並びを厳密に確かめる

import type { Dialect } from "./dialect";
import { QueryBuildError } from "./errors";
import { raw, type Sql, sql } from "./sql";

/** 派生テーブルの別名。Oracle は AS を付けられないので、どちらの方言でも付けない */
const ALIAS = "base_query";

type TokenKind = "word" | "quoted" | "string" | "param" | "punct" | "other";

type Token = {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  /** 括弧の深さ。( と ) は外側の深さ */
  depth: number;
};

const WORD_START = /[\p{L}_#]/u;
const WORD_PART = /[\p{L}\p{N}_$#@]/u;

/** 字句に分ける。文字列・引用符つき識別子・コメントの中の記号を構文と取り違えないため */
function tokenize(dialect: Dialect, text: string): Token[] {
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
      if (k < 0)
        throw new QueryBuildError(`ベースSQL の${what}が閉じていません`);
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
    } else if (
      c === ":" &&
      dialect.name === "oracle" &&
      /[\p{L}\p{N}_]/u.test(next)
    ) {
      let j = i + 1;
      while (j < text.length && WORD_PART.test(text.charAt(j))) j += 1;
      push("param", i, j);
      i = j;
    } else if (c === "(") {
      push("punct", i, i + 1);
      depth += 1;
      i += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth < 0) {
        throw new QueryBuildError("ベースSQL の括弧の対応が取れていません");
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
    throw new QueryBuildError("ベースSQL の括弧の対応が取れていません");
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
  throw new QueryBuildError("ベースSQL のコメントが閉じていません");
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
  if (!open || k < 0)
    throw new QueryBuildError("ベースSQL の文字列が閉じていません");
  return k + close.length;
}

const isWord = (token: Token | undefined, word: string) =>
  token?.kind === "word" && token.text.toUpperCase() === word;
const isPunct = (token: Token | undefined, char: string) =>
  token?.kind === "punct" && token.text === char;

type Prepared = {
  /** SQL Server で外側の SELECT の前に出す WITH 句。なければ null */
  withClause: string | null;
  /** 派生テーブルの中に入れる問い合わせ */
  body: string;
};

function prepare(dialect: Dialect, text: string): Prepared {
  let tokens = tokenize(dialect, text);
  let end = text.length;

  // 末尾のセミコロンだけは許す（A5 などからそのまま貼れるように）
  const semicolon = tokens.findIndex((t) => t.depth === 0 && isPunct(t, ";"));
  if (semicolon >= 0) {
    if (!tokens.slice(semicolon).every((t) => isPunct(t, ";"))) {
      throw new QueryBuildError(
        "ベースSQL に書ける文は 1 つだけです（セミコロンで区切った複数の文は使えません）",
      );
    }
    end = tokens[semicolon]?.start ?? end;
    tokens = tokens.slice(0, semicolon);
  }
  const [first] = tokens;
  if (first === undefined) throw new QueryBuildError("ベースSQL が空です");
  if (!isWord(first, "SELECT") && !isWord(first, "WITH")) {
    throw new QueryBuildError(
      "ベースSQL は SELECT か WITH で始まる問い合わせにしてください（読み取り専用）",
    );
  }
  const param = tokens.find((t) => t.kind === "param");
  if (param) {
    throw new QueryBuildError(
      `ベースSQL にバインド変数（${param.text}）は使えません。値は列見出しのフィルタで指定してください`,
    );
  }

  const top = tokens.filter((t) => t.depth === 0);
  let bodyStart = first.start;
  let withClause: string | null = null;
  if (dialect.name === "mssql" && isWord(first, "WITH")) {
    // SQL Server は派生テーブルの中に WITH を書けないので、CTE の並びを外側の SELECT の前に出す
    const main = mainSelectAfterCtes(top);
    bodyStart = main.start;
    withClause = text.slice(first.start, main.start).trimEnd();
  }

  for (const [i, t] of top.entries()) {
    if (isWord(t, "INTO")) {
      throw new QueryBuildError(
        "ベースSQL に SELECT ... INTO は使えません（読み取り専用）",
      );
    }
    if (isWord(t, "FOR") && isWord(top[i + 1], "UPDATE")) {
      throw new QueryBuildError(
        "ベースSQL に FOR UPDATE は使えません（行をロックするため）",
      );
    }
  }

  if (dialect.name === "mssql")
    checkOrderBy(top.filter((t) => t.start >= bodyStart));

  return { withClause, body: text.slice(bodyStart, end).trimEnd() };
}

/**
 * 最上位の字句が「名前 [(列, …)] AS (…) [, …] SELECT」の並びであることを確かめ、最後の SELECT を返す。
 * T-SQL は文をセミコロンなしで続けられるので、ここが緩いと外に出した部分に別の文が紛れ込む
 */
function mainSelectAfterCtes(top: readonly Token[]): Token {
  const fail = () =>
    new QueryBuildError(
      "ベースSQL の WITH 句を解釈できません。「WITH 名前 AS (SELECT ...) SELECT ...」の形にしてください",
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
        "ベースSQL の WITH 句の後は SELECT にしてください（読み取り専用）",
      );
    }
    return main;
  }
}

/** SQL Server の派生テーブルには、TOP か OFFSET がないと ORDER BY を書けない */
function checkOrderBy(top: readonly Token[]): void {
  const hasOrderBy = top.some(
    (t, i) => isWord(t, "ORDER") && isWord(top[i + 1], "BY"),
  );
  if (!hasOrderBy) return;
  const hasOffset = top.some((t) => isWord(t, "OFFSET"));
  const [, second, third] = top;
  const hasTop =
    isWord(second, "TOP") ||
    ((isWord(second, "DISTINCT") || isWord(second, "ALL")) &&
      isWord(third, "TOP"));
  if (!hasOffset && !hasTop) {
    throw new QueryBuildError(
      "ベースSQL の ORDER BY は外してください。並べ替えは列見出しで指定します",
    );
  }
}

/** FROM 句に書く対象。WITH 句は SELECT の前に置く */
export type BaseSqlSource = { withClause: Sql | null; from: Sql };

export function fromBaseSql(dialect: Dialect, text: string): BaseSqlSource {
  const prepared = prepare(dialect, text);
  // ベースSQL は利用者が自分で書いた問い合わせそのもの。上で 1 つの問い合わせでバインド変数がないことを確かめ、括弧で包む
  return {
    withClause: prepared.withClause === null ? null : raw(prepared.withClause),
    from: sql`(\n${raw(prepared.body)}\n) ${raw(ALIAS)}`,
  };
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
