// SQL の入力補完（D-39）のための、カーソルの位置の文脈の判定。DB に依存しない。
// 書きかけの SQL（閉じていない括弧・文字列・コメント）でも例外を投げないよう、baseSql.ts の tokenize とは別に、緩く字句に分ける

import type { Dialect } from "./dialect";

type ScanKind = "word" | "quoted" | "punct" | "other";

type ScanToken = {
  kind: ScanKind;
  text: string;
  start: number;
  end: number;
  /** 括弧の深さ。( と ) は外側の深さ */
  depth: number;
};

type Scanned = {
  tokens: ScanToken[];
  /** 文字列とコメントの範囲。閉じていなければ文末まで（open が true） */
  opaque: { start: number; end: number; open: boolean; line: boolean }[];
};

const WORD_START = /[\p{L}_#@$]/u;
const WORD_PART = /[\p{L}\p{N}_$#@]/u;

function scan(dialect: Dialect, text: string): Scanned {
  const tokens: ScanToken[] = [];
  const opaque: Scanned["opaque"] = [];
  let depth = 0;
  let i = 0;
  const push = (kind: ScanKind, start: number, end: number, d = depth) => {
    tokens.push({ kind, text: text.slice(start, end), start, end, depth: d });
  };
  /** close（1 文字）まで読み、その直後の位置。2 つ重ねたものは close の文字そのもの。閉じていなければ -1 */
  const until = (from: number, close: string): number => {
    let j = from;
    for (;;) {
      const k = text.indexOf(close, j);
      if (k < 0) return -1;
      if (text.charAt(k + 1) !== close) return k + 1;
      j = k + 2;
    }
  };
  const quoted = (start: number, close: string, kind: "quoted" | "string") => {
    const end = until(start + 1, close);
    if (kind === "string") {
      opaque.push({
        start,
        end: end < 0 ? text.length : end,
        open: end < 0,
        line: false,
      });
    } else {
      push("quoted", start, end < 0 ? text.length : end);
    }
    return end < 0 ? text.length : end;
  };

  while (i < text.length) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "-" && next === "-") {
      const k = text.indexOf("\n", i);
      const end = k < 0 ? text.length : k;
      opaque.push({ start: i, end, open: false, line: true });
      i = end;
    } else if (c === "/" && next === "*") {
      const end = blockCommentEnd(dialect, text, i);
      opaque.push({
        start: i,
        end: end < 0 ? text.length : end,
        open: end < 0,
        line: false,
      });
      i = end < 0 ? text.length : end;
    } else if (c === "'") {
      i = quoted(i, "'", "string");
    } else if (c === '"') {
      i = quoted(i, '"', "quoted");
    } else if (c === "[" && dialect.name === "mssql") {
      i = quoted(i, "]", "quoted");
    } else if (/\d/.test(c)) {
      // 数値（1.5 などの . を、名前の区切りと取り違えないため）
      let j = i + 1;
      while (j < text.length && /[\d.eE]/.test(text.charAt(j))) j += 1;
      push("other", i, j);
      i = j;
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < text.length && WORD_PART.test(text.charAt(j))) j += 1;
      const upper = text.slice(i, j).toUpperCase();
      // N'...'、Oracle の q'[...]' は文字列
      if (
        text.charAt(j) === "'" &&
        (upper === "N" ||
          (dialect.name === "oracle" && (upper === "Q" || upper === "NQ")))
      ) {
        i = quoted(j, "'", "string");
      } else {
        push("word", i, j);
        i = j;
      }
    } else if (c === "(") {
      push("punct", i, i + 1);
      depth += 1;
      i += 1;
    } else if (c === ")") {
      depth = Math.max(depth - 1, 0);
      push("punct", i, i + 1);
      i += 1;
    } else if (c === "." || c === "," || c === ";") {
      push("punct", i, i + 1);
      i += 1;
    } else {
      push("other", i, i + 1);
      i += 1;
    }
  }
  return { tokens, opaque };
}

/** ブロックコメントの終わりの直後の位置。閉じていなければ -1。SQL Server は入れ子にできる */
function blockCommentEnd(dialect: Dialect, text: string, from: number): number {
  let nest = 0;
  let i = from;
  while (i < text.length) {
    if (text.startsWith("/*", i)) {
      nest = dialect.name === "oracle" ? 1 : nest + 1;
      i += 2;
    } else if (text.startsWith("*/", i)) {
      nest -= 1;
      i += 2;
      if (nest === 0) return i;
    } else {
      i += 1;
    }
  }
  return -1;
}

const isIdent = (t: ScanToken | undefined): t is ScanToken =>
  t?.kind === "word" || t?.kind === "quoted";
const isPunct = (t: ScanToken | undefined, p: string) =>
  t?.kind === "punct" && t.text === p;
const isWord = (t: ScanToken | undefined, ...words: string[]) =>
  t?.kind === "word" && words.includes(t.text.toUpperCase());

/** 名前の字句 → 名前（引用符を外す） */
function identName(token: ScanToken): string {
  if (token.kind !== "quoted") return token.text;
  const open = token.text.charAt(0);
  const close = open === "[" ? "]" : '"';
  const inner = token.text.endsWith(close)
    ? token.text.slice(1, -1)
    : token.text.slice(1);
  return inner.replaceAll(close + close, close);
}

/** カーソルの位置の文脈 */
export type CompletionContext =
  /** 文字列・コメントの中。補完しない */
  | { kind: "none" }
  /**
   * 「名前.」の後（名前. の後に打ちかけの文字があってもよい）。path は . の前の名前（引用符を外したもの）。
   * afterFrom は FROM / JOIN の直後（schema. の後でテーブル名を補う）
   */
  | { kind: "member"; path: string[]; prefix: string; afterFrom: boolean }
  /** FROM / JOIN の後（FROM の , の後も）。テーブル名を補う */
  | { kind: "table"; prefix: string }
  /** それ以外。キーワードを補う */
  | { kind: "general"; prefix: string };

export function completionContext(
  dialect: Dialect,
  text: string,
  offset: number,
): CompletionContext {
  const { tokens, opaque } = scan(dialect, text);
  const inside = opaque.some((o) =>
    o.open || o.line
      ? o.start < offset && offset <= o.end
      : o.start < offset && offset < o.end,
  );
  if (inside) return { kind: "none" };

  // カーソルの直前まで打っている名前（打ちかけの部分）
  let index = tokens.findIndex((t) => t.start < offset && offset <= t.end);
  let prefix = "";
  let before: number;
  const current = tokens[index];
  if (current && isIdent(current)) {
    prefix = identName({ ...current, text: text.slice(current.start, offset) });
    before = index - 1;
  } else {
    // カーソルの前で終わっている最後の字句
    index = tokens.findLastIndex((t) => t.end <= offset);
    before = index;
    const last = tokens[index];
    if (last && last.kind !== "punct" && last.end === offset) {
      // 「a+」の直後など、名前でない字句に続けて打っている
      return { kind: "general", prefix: "" };
    }
  }

  // 「名前.名前.」の並び（. と名前はつながっている）
  const path: string[] = [];
  let j = before;
  const prefixStart = current && isIdent(current) ? current.start : offset;
  let expectStart = prefixStart;
  for (;;) {
    const dot = tokens[j];
    const name = tokens[j - 1];
    if (!isPunct(dot, ".") || dot?.end !== expectStart) break;
    if (!isIdent(name) || name.end !== dot.start) break;
    path.unshift(identName(name));
    expectStart = name.start;
    j -= 2;
  }
  const afterFrom = isFromPosition(tokens, j);
  if (path.length > 0) {
    return { kind: "member", path, prefix, afterFrom };
  }
  if (afterFrom) return { kind: "table", prefix };
  return { kind: "general", prefix };
}

/** tokens[at] の直後がテーブル名の位置か（FROM・JOIN の直後、FROM の並びの , の直後） */
function isFromPosition(tokens: readonly ScanToken[], at: number): boolean {
  const t = tokens[at];
  if (isWord(t, "FROM", "JOIN")) return true;
  if (!isPunct(t, ",") || !t) return false;
  // 同じ括弧の深さで、手前の句の頭が FROM か
  for (let k = at - 1; k >= 0; k -= 1) {
    const u = tokens[k];
    if (!u || u.depth < t.depth) return false;
    if (u.depth !== t.depth) continue;
    if (isWord(u, "FROM")) return true;
    if (
      isWord(
        u,
        "SELECT",
        "WHERE",
        "ON",
        "GROUP",
        "ORDER",
        "HAVING",
        "SET",
        "VALUES",
        "BY",
        "JOIN",
      )
    ) {
      return false;
    }
  }
  return false;
}

/** 文の中のテーブル参照（FROM・JOIN の後）。name が null のものは派生テーブル（列は分からない） */
export type TableReference = {
  schema: string | null;
  name: string | null;
  alias: string | null;
  /** WITH で定義した名前（列は分からない） */
  cte: boolean;
};

/** 別名にならない語（テーブル名の後に続く句の頭など） */
const NOT_ALIAS = new Set([
  "WHERE",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "OUTER",
  "NATURAL",
  "ON",
  "USING",
  "GROUP",
  "ORDER",
  "HAVING",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "MINUS",
  "WITH",
  "OPTION",
  "FOR",
  "FETCH",
  "OFFSET",
  "LIMIT",
  "PIVOT",
  "UNPIVOT",
  "APPLY",
  "WINDOW",
  "CONNECT",
  "START",
  "SET",
  "VALUES",
  "TABLESAMPLE",
  "PARTITION",
  "SELECT",
  "FROM",
  "AS",
  "AND",
  "OR",
]);

/** カーソルのある文（; と、SQL Server の GO の行で区切る）の中のテーブル参照 */
export function tableReferences(
  dialect: Dialect,
  text: string,
  offset: number,
): TableReference[] {
  const { tokens } = scan(dialect, text);
  const [from, to] = statementRange(dialect, text, tokens, offset);
  const inStatement = tokens.filter((t) => t.start >= from && t.end <= to);
  const ctes = cteNames(inStatement);
  const refs: TableReference[] = [];

  /** tokens[at] の ( に対応する ) の位置（なければ文の終わり） */
  const closing = (at: number): number => {
    const depth = inStatement[at]?.depth ?? 0;
    let i = at + 1;
    while (
      i < inStatement.length &&
      !(isPunct(inStatement[i], ")") && inStatement[i]?.depth === depth)
    ) {
      i += 1;
    }
    return i;
  };

  const readRef = (at: number): number => {
    let i = at;
    const first = inStatement[i];
    let schema: string | null = null;
    let name: string | null = null;
    if (isPunct(first, "(")) {
      // 派生テーブル：中の FROM も読み、別名は ) の後
      const close = closing(i);
      walk(i + 1, close);
      i = close + 1;
    } else if (isIdent(first)) {
      const parts = [identName(first)];
      i += 1;
      while (isPunct(inStatement[i], ".") && isIdent(inStatement[i + 1])) {
        parts.push(identName(inStatement[i + 1] as ScanToken));
        i += 2;
      }
      name = parts.at(-1) ?? null;
      schema = parts.length >= 2 ? (parts.at(-2) ?? null) : null;
      // テーブル値関数 fn(...)。列は分からない
      if (isPunct(inStatement[i], "(")) {
        i = closing(i) + 1;
        name = null;
        schema = null;
      }
    } else {
      return at + 1;
    }
    if (isWord(inStatement[i], "AS")) i += 1;
    let alias: string | null = null;
    const maybe = inStatement[i];
    if (
      isIdent(maybe) &&
      !(maybe.kind === "word" && NOT_ALIAS.has(maybe.text.toUpperCase()))
    ) {
      alias = identName(maybe);
      i += 1;
    }
    // SQL Server のテーブルのヒント WITH (NOLOCK)
    if (isWord(inStatement[i], "WITH") && isPunct(inStatement[i + 1], "(")) {
      i = closing(i + 1) + 1;
    }
    const cte =
      schema === null && name !== null && ctes.has(name.toUpperCase());
    refs.push({ schema, name, alias, cte });
    return i;
  };

  function walk(from: number, to: number): void {
    for (let i = from; i < to; ) {
      const t = inStatement[i];
      if (isWord(t, "FROM", "JOIN")) {
        i = readRef(i + 1);
        // FROM a x, b y
        while (isPunct(inStatement[i], ",") && isWord(t, "FROM")) {
          i = readRef(i + 1);
        }
      } else {
        i += 1;
      }
    }
  }
  walk(0, inStatement.length);
  return refs;
}

/** WITH 名前 [(列…)] AS (…) [, 名前 AS (…)] の名前（大文字） */
function cteNames(tokens: readonly ScanToken[]): Set<string> {
  const names = new Set<string>();
  const start = tokens.findIndex((t) => isWord(t, "WITH") && t.depth === 0);
  if (start < 0) return names;
  let i = start + 1;
  for (;;) {
    const name = tokens[i];
    if (!isIdent(name)) break;
    i += 1;
    if (isPunct(tokens[i], "(")) {
      while (i < tokens.length && !isPunct(tokens[i], ")")) i += 1;
      i += 1;
    }
    if (!isWord(tokens[i], "AS")) break;
    names.add(identName(name).toUpperCase());
    i += 1;
    if (!isPunct(tokens[i], "(")) break;
    const depth = tokens[i]?.depth ?? 0;
    i += 1;
    while (
      i < tokens.length &&
      !(isPunct(tokens[i], ")") && tokens[i]?.depth === depth)
    ) {
      i += 1;
    }
    i += 1;
    if (!isPunct(tokens[i], ",")) break;
    i += 1;
  }
  return names;
}

/** カーソルのある文の範囲 [from, to) */
function statementRange(
  dialect: Dialect,
  text: string,
  tokens: readonly ScanToken[],
  offset: number,
): [number, number] {
  const cuts: number[] = [];
  for (const t of tokens) {
    if (isPunct(t, ";") && t.depth === 0) cuts.push(t.start);
    if (dialect.name === "mssql" && isWord(t, "GO")) {
      const lineStart = text.lastIndexOf("\n", t.start - 1) + 1;
      const lineEnd = text.indexOf("\n", t.end);
      const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
      if (line.trim().toUpperCase() === "GO") cuts.push(t.start);
    }
  }
  let from = 0;
  let to = text.length;
  for (const cut of cuts) {
    if (cut < offset) from = cut + 1;
    else if (cut >= offset) {
      to = cut;
      break;
    }
  }
  return [from, to];
}

/** 補完で入れる名前。予約語や記号を含む名前、Oracle の小文字を含む名前は引用符で囲む */
export function completionIdentifier(dialect: Dialect, name: string): string {
  const plain =
    /^[\p{L}_][\p{L}\p{N}_$#]*$/u.test(name) &&
    !RESERVED.has(name.toUpperCase()) &&
    // Oracle は引用符のない名前を大文字にするので、小文字を含む名前は囲む
    !(dialect.name === "oracle" && name !== name.toUpperCase());
  return plain ? name : dialect.quoteIdent(name);
}

/** 補完に出すキーワード */
export function sqlKeywords(dialect: Dialect): string[] {
  const common = [
    "SELECT",
    "DISTINCT",
    "FROM",
    "WHERE",
    "AND",
    "OR",
    "NOT",
    "IN",
    "EXISTS",
    "BETWEEN",
    "LIKE",
    "IS NULL",
    "IS NOT NULL",
    "INNER JOIN",
    "LEFT JOIN",
    "RIGHT JOIN",
    "FULL OUTER JOIN",
    "CROSS JOIN",
    "ON",
    "AS",
    "GROUP BY",
    "HAVING",
    "ORDER BY",
    "ASC",
    "DESC",
    "UNION ALL",
    "UNION",
    "WITH",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "NULL",
    "COUNT",
    "SUM",
    "MIN",
    "MAX",
    "AVG",
    "COALESCE",
    "CAST",
    "UPPER",
    "LOWER",
    "TRIM",
    "ROW_NUMBER() OVER",
    "PARTITION BY",
  ];
  const own =
    dialect.name === "mssql"
      ? [
          "TOP",
          "ISNULL",
          "CONVERT",
          "LEN",
          "SUBSTRING",
          "GETDATE()",
          "DATEADD",
          "DATEDIFF",
          "FORMAT",
          "OFFSET",
          "FETCH NEXT",
          "WITH (NOLOCK)",
        ]
      : [
          "NVL",
          "DECODE",
          "TO_CHAR",
          "TO_DATE",
          "TO_NUMBER",
          "SUBSTR",
          "LENGTH",
          "SYSDATE",
          "TRUNC",
          "ADD_MONTHS",
          "FETCH FIRST",
          "ROWNUM",
          "MINUS",
        ];
  return [...common, ...own];
}

/** 引用符なしでは名前に使えない語（両方の DB でよく当たるものだけ） */
const RESERVED = new Set([
  "ADD",
  "ALL",
  "ALTER",
  "AND",
  "ANY",
  "AS",
  "ASC",
  "BETWEEN",
  "BY",
  "CASE",
  "CHECK",
  "COLUMN",
  "CREATE",
  "CROSS",
  "CURRENT",
  "DATE",
  "DEFAULT",
  "DELETE",
  "DESC",
  "DISTINCT",
  "DROP",
  "ELSE",
  "END",
  "EXISTS",
  "FOR",
  "FROM",
  "FULL",
  "GROUP",
  "HAVING",
  "IN",
  "INDEX",
  "INNER",
  "INSERT",
  "INTO",
  "IS",
  "JOIN",
  "KEY",
  "LEFT",
  "LEVEL",
  "LIKE",
  "NOT",
  "NULL",
  "NUMBER",
  "OF",
  "ON",
  "OR",
  "ORDER",
  "OUTER",
  "PRIMARY",
  "RIGHT",
  "ROWNUM",
  "SELECT",
  "SET",
  "SIZE",
  "TABLE",
  "THEN",
  "TO",
  "UNION",
  "UNIQUE",
  "UPDATE",
  "USER",
  "VALUES",
  "VIEW",
  "WHEN",
  "WHERE",
  "WITH",
]);
