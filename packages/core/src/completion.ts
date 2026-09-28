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

export function scan(dialect: Dialect, text: string): Scanned {
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
      if (text.charAt(j) === "'" && upper === "N") {
        i = quoted(j, "'", "string");
      } else if (
        text.charAt(j) === "'" &&
        dialect.name === "oracle" &&
        (upper === "Q" || upper === "NQ")
      ) {
        const end = qQuoteEnd(text, j);
        opaque.push({
          start: j,
          end: end < 0 ? text.length : end,
          open: end < 0,
          line: false,
        });
        i = end < 0 ? text.length : end;
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

/** Oracle の代替引用符 q'[...]' の終わりの直後の位置（quote は ' の位置）。閉じていなければ -1 */
function qQuoteEnd(text: string, quote: number): number {
  const open = text.charAt(quote + 1);
  if (!open) return -1;
  const pairs: Record<string, string> = {
    "[": "]",
    "(": ")",
    "{": "}",
    "<": ">",
  };
  const close = `${pairs[open] ?? open}'`;
  const k = text.indexOf(close, quote + 2);
  return k < 0 ? -1 : k + close.length;
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

/** 文の中のテーブル参照と、その字句の位置（sqlOutline で、名前の役割を決めるのに使う） */
type RefTokens = TableReference & {
  /** テーブル名の並び（スキーマ.名前）の最初と最後の字句の添字。派生テーブルなどでは null */
  nameTokens: [number, number] | null;
  /** 別名の字句の添字。なければ null */
  aliasToken: number | null;
};

/** 文の字句（tokens）の中のテーブル参照。添字は tokens の中のもの */
function readReferences(tokens: readonly ScanToken[]): RefTokens[] {
  const ctes = cteNames(tokens);
  const refs: RefTokens[] = [];

  /** tokens[at] の ( に対応する ) の位置（なければ文の終わり） */
  const closing = (at: number): number => {
    const depth = tokens[at]?.depth ?? 0;
    let i = at + 1;
    while (
      i < tokens.length &&
      !(isPunct(tokens[i], ")") && tokens[i]?.depth === depth)
    ) {
      i += 1;
    }
    return i;
  };

  const readRef = (at: number): number => {
    let i = at;
    const first = tokens[i];
    let schema: string | null = null;
    let name: string | null = null;
    let nameTokens: [number, number] | null = null;
    if (isPunct(first, "(")) {
      // 派生テーブル：中の FROM も読み、別名は ) の後
      const close = closing(i);
      walk(i + 1, close);
      i = close + 1;
    } else if (isIdent(first)) {
      const parts = [identName(first)];
      i += 1;
      while (isPunct(tokens[i], ".") && isIdent(tokens[i + 1])) {
        parts.push(identName(tokens[i + 1] as ScanToken));
        i += 2;
      }
      name = parts.at(-1) ?? null;
      schema = parts.length >= 2 ? (parts.at(-2) ?? null) : null;
      nameTokens = [at, i - 1];
      // テーブル値関数 fn(...)。列は分からない
      if (isPunct(tokens[i], "(")) {
        i = closing(i) + 1;
        name = null;
        schema = null;
        nameTokens = null;
      }
    } else {
      return at + 1;
    }
    if (isWord(tokens[i], "AS")) i += 1;
    let alias: string | null = null;
    let aliasToken: number | null = null;
    const maybe = tokens[i];
    if (
      isIdent(maybe) &&
      !(maybe.kind === "word" && NOT_ALIAS.has(maybe.text.toUpperCase()))
    ) {
      alias = identName(maybe);
      aliasToken = i;
      i += 1;
    }
    // SQL Server のテーブルのヒント WITH (NOLOCK)
    if (isWord(tokens[i], "WITH") && isPunct(tokens[i + 1], "(")) {
      i = closing(i + 1) + 1;
    }
    const cte =
      schema === null && name !== null && ctes.has(name.toUpperCase());
    refs.push({ schema, name, alias, cte, nameTokens, aliasToken });
    return i;
  };

  function walk(from: number, to: number): void {
    for (let i = from; i < to; ) {
      const t = tokens[i];
      if (isWord(t, "FROM", "JOIN")) {
        i = readRef(i + 1);
        // FROM a x, b y
        while (isPunct(tokens[i], ",") && isWord(t, "FROM")) {
          i = readRef(i + 1);
        }
      } else {
        i += 1;
      }
    }
  }
  walk(0, tokens.length);
  return refs;
}

const publicRef = ({
  schema,
  name,
  alias,
  cte,
}: RefTokens): TableReference => ({ schema, name, alias, cte });

/** カーソルのある文（; と、SQL Server の GO の行などで区切る。splitStatements と同じ）の中のテーブル参照 */
export function tableReferences(
  dialect: Dialect,
  text: string,
  offset: number,
): TableReference[] {
  const { tokens } = scan(dialect, text);
  const spans = statementSpans(dialect, text, tokens);
  // カーソルが文の区切りの直前（; の前など）にあれば、その前の文
  const span =
    spans.find((s) => s.from <= offset && offset <= s.to) ?? spans.at(-1);
  if (!span) return [];
  return readReferences(tokens.slice(span.first, span.last)).map(publicRef);
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

/**
 * 文の範囲。from〜to は区切り（; や GO の行）の間の全体（前後の空白・コメントを含む）、
 * first〜last は文の字句の添字 [first, last)
 */
type StatementSpan = { from: number; to: number; first: number; last: number };

/**
 * SQL を文に分ける。区切りは、括弧の外の ;、SQL Server の GO だけの行、Oracle の / だけの行。
 * A5:SQL Mk-2 などで ; を書かずに問い合わせを並べることがあるので、問い合わせ（SELECT / WITH で始まる文）の
 * 途中に、括弧の外で新しい問い合わせが始まったら（UNION などの後の SELECT や、WITH の後の本体の SELECT は除く）そこでも分ける
 */
function statementSpans(
  dialect: Dialect,
  text: string,
  tokens: readonly ScanToken[],
): StatementSpan[] {
  const spans: StatementSpan[] = [];
  let first = 0;
  let from = 0;
  /** 今の文で、括弧の外の SELECT が出てきたか（WITH の後の本体の SELECT を見分ける） */
  let mainSelect = false;
  const close = (last: number, to: number, nextFrom: number, next: number) => {
    spans.push({ from, to, first, last });
    first = next;
    from = nextFrom;
    mainSelect = false;
  };
  for (const [i, t] of tokens.entries()) {
    if (isPunct(t, ";") && t.depth === 0) {
      close(i, t.start, t.end, i + 1);
    } else if (isSeparatorLine(dialect, text, t)) {
      close(i, t.start, t.end, i + 1);
    } else if (i > first && startsQuery(tokens, first, i, mainSelect)) {
      close(i, t.start, t.start, i);
    } else if (isWord(t, "SELECT") && t.depth === 0) {
      mainSelect = true;
    }
  }
  close(tokens.length, text.length, text.length, tokens.length);
  return spans;
}

/** 文の区切りの行（SQL Server の GO だけの行、Oracle の / だけの行）の字句か */
function isSeparatorLine(
  dialect: Dialect,
  text: string,
  t: ScanToken,
): boolean {
  const separator =
    (dialect.name === "mssql" && isWord(t, "GO")) ||
    (dialect.name === "oracle" && t.text === "/");
  if (!separator) return false;
  const lineStart = text.lastIndexOf("\n", t.start - 1) + 1;
  const lineEnd = text.indexOf("\n", t.end);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  return line.trim() === t.text;
}

/** 文の区切りの行（GO や /）の字句の位置。整形（format.ts）はこの行で分けてから整形する */
export function separatorLines(
  dialect: Dialect,
  text: string,
): { start: number; end: number }[] {
  return scan(dialect, text)
    .tokens.filter((t) => isSeparatorLine(dialect, text, t))
    .map(({ start, end }) => ({ start, end }));
}

/** tokens[i] で新しい問い合わせが始まるか（; を書かずに並べた問い合わせの区切り） */
function startsQuery(
  tokens: readonly ScanToken[],
  first: number,
  i: number,
  mainSelect: boolean,
): boolean {
  const head = tokens[first];
  const t = tokens[i];
  // 問い合わせの途中だけ分ける（INSERT ... SELECT などは分けない。読み取り専用なので実行もしない）
  if (!isWord(head, "SELECT", "WITH") || !t || t.depth !== 0) return false;
  if (isWord(t, "SELECT")) {
    // UNION SELECT などは同じ文。WITH の後の最初の SELECT は本体
    if (isWord(tokens[i - 1], ...SET_OPERATORS, "AS")) return false;
    return !(isWord(head, "WITH") && !mainSelect);
  }
  // WITH 名前 [(列…)] AS ( の形だけ（テーブルのヒントの WITH (NOLOCK) や START WITH などは除く）
  if (isWord(t, "WITH") && isIdent(tokens[i + 1])) {
    let j = i + 2;
    if (isPunct(tokens[j], "(")) {
      while (j < tokens.length && !isPunct(tokens[j], ")")) j += 1;
      j += 1;
    }
    return isWord(tokens[j], "AS") && isPunct(tokens[j + 1], "(");
  }
  return false;
}

const SET_OPERATORS = ["UNION", "ALL", "INTERSECT", "EXCEPT", "MINUS"];

/** 文の位置。start は最初の字句の先頭、end は最後の字句の終わり（区切りの ; と前後のコメントは含まない） */
export type SqlStatementRange = { start: number; end: number };

/** SQL を文に分ける（区切りは statementSpans）。コメントや空白だけの文は除く */
export function splitStatements(
  dialect: Dialect,
  text: string,
): SqlStatementRange[] {
  const { tokens } = scan(dialect, text);
  return statementSpans(dialect, text, tokens).flatMap(toRange(tokens));
}

const toRange =
  (tokens: readonly ScanToken[]) =>
  (span: StatementSpan): SqlStatementRange[] => {
    const firstToken = tokens[span.first];
    const lastToken = tokens[span.last - 1];
    return span.last > span.first && firstToken && lastToken
      ? [{ start: firstToken.start, end: lastToken.end }]
      : [];
  };

/**
 * カーソルの位置で実行する文。文の中か、文の後ろ（次の文の前まで。書き終えた直後の位置）ならその文。
 * どの文よりも前なら最初の文
 */
export function statementAt(
  statements: readonly SqlStatementRange[],
  offset: number,
): SqlStatementRange | undefined {
  return statements.findLast((s) => s.start <= offset) ?? statements[0];
}

/** 名前（引用符を外したもの）と、その位置 */
export type SqlName = { name: string; start: number; end: number };

/** SQL に書いた名前の並び（スキーマ.テーブル.列、別名.列、列 など） */
export type NameReference = {
  parts: SqlName[];
  /** FROM・JOIN の後に書いたテーブル（ビュー）の名前 */
  table: boolean;
  /** 名前のある文（SqlOutline の statements の添字） */
  statement: number;
  /** 直後に書いた別名（列の別名・テーブルの別名）。なければ null */
  alias: string | null;
};

export type SqlOutline = {
  statements: (SqlStatementRange & { tables: TableReference[] })[];
  names: NameReference[];
};

/**
 * 論理名のホバーとインレイヒント（D-40）のための、文ごとのテーブル参照と、名前の並びの一覧。
 * 名前でないもの（キーワード、関数の呼び出し、別名の定義、:名前 などのバインド変数、SQL Server の @変数）は除く
 */
export function sqlOutline(dialect: Dialect, text: string): SqlOutline {
  const { tokens } = scan(dialect, text);
  const keywords = keywordSet(dialect);
  const outline: SqlOutline = { statements: [], names: [] };
  for (const span of statementSpans(dialect, text, tokens)) {
    const range = toRange(tokens)(span)[0];
    if (!range) continue;
    const inStatement = tokens.slice(span.first, span.last);
    const refs = readReferences(inStatement);
    const statement = outline.statements.length;
    outline.statements.push({ ...range, tables: refs.map(publicRef) });
    const tableAt = new Map<number, number>();
    const aliases = new Set<number>();
    for (const ref of refs) {
      if (ref.nameTokens) tableAt.set(ref.nameTokens[0], ref.nameTokens[1]);
      if (ref.aliasToken !== null) aliases.add(ref.aliasToken);
    }
    const ctes = cteNames(inStatement);

    for (let i = 0; i < inStatement.length; ) {
      const t = inStatement[i];
      if (!isIdent(t) || aliases.has(i)) {
        i += 1;
        continue;
      }
      // 名前.名前.… の並び（. の前後に空白のないもの）
      const parts: SqlName[] = [nameOf(t)];
      let j = i + 1;
      for (;;) {
        const dot = inStatement[j];
        const next = inStatement[j + 1];
        const prev = inStatement[j - 1];
        if (
          !isPunct(dot, ".") ||
          !isIdent(next) ||
          dot?.start !== prev?.end ||
          next.start !== dot?.end
        ) {
          break;
        }
        parts.push(nameOf(next));
        j += 2;
      }
      const before = inStatement[i - 1];
      const after = inStatement[j];
      const table = tableAt.get(i) === j - 1;
      const single =
        parts.length === 1 ? (parts[0]?.name.toUpperCase() ?? null) : null;
      const skip =
        // 関数の呼び出し
        isPunct(after, "(") ||
        // 列の別名の定義（AS の後と、名前の直後の名前）と、WITH の名前
        isWord(before, "AS") ||
        isPunct(before, ")") ||
        (isIdent(before) &&
          !(
            before.kind === "word" && keywords.has(before.text.toUpperCase())
          )) ||
        (single !== null && !table && ctes.has(single)) ||
        // :名前（レポートの入力欄）、Oracle の :x、SQL Server の @x
        (before?.kind === "other" &&
          before.text === ":" &&
          before.end === t.start) ||
        t.text.startsWith("@") ||
        (single !== null && t.kind === "word" && keywords.has(single));
      if (!skip) {
        const aliasToken = isWord(after, "AS") ? inStatement[j + 1] : after;
        const alias =
          isIdent(aliasToken) &&
          !(
            aliasToken.kind === "word" &&
            (NOT_ALIAS.has(aliasToken.text.toUpperCase()) ||
              keywords.has(aliasToken.text.toUpperCase()))
          )
            ? identName(aliasToken)
            : null;
        outline.names.push({ parts, table, statement, alias });
      }
      i = j;
    }
  }
  return outline;
}

function nameOf(token: ScanToken): SqlName {
  return { name: identName(token), start: token.start, end: token.end };
}

/** 名前として扱わない語（キーワードと予約語） */
function keywordSet(dialect: Dialect): Set<string> {
  const words = new Set(RESERVED);
  for (const keyword of sqlKeywords(dialect)) {
    for (const word of keyword.split(/[^A-Z_]+/)) if (word) words.add(word);
  }
  for (const word of EXTRA_KEYWORDS) words.add(word);
  return words;
}

const EXTRA_KEYWORDS = [
  "TOP",
  "BY",
  "NULLS",
  "FIRST",
  "LAST",
  "ROWS",
  "ROW",
  "ONLY",
  "NEXT",
  "OVER",
  "PARTITION",
  "PERCENT",
  "TIES",
  "NOLOCK",
  "APPLY",
  "PIVOT",
  "UNPIVOT",
  "INTERSECT",
  "EXCEPT",
  "ESCAPE",
  "ALL",
  "SOME",
  "PRIOR",
  "CONNECT",
  "START",
  "GO",
];

/** offset が文字列かコメントの中か（書きかけで閉じていなくてもよい） */
export function isInsideLiteral(
  dialect: Dialect,
  text: string,
  offset: number,
): boolean {
  return scan(dialect, text).opaque.some(
    (o) =>
      offset > o.start &&
      (offset < o.end || ((o.open || o.line) && offset === o.end)),
  );
}

/** コメント（-- で始まる行のコメントと、ブロックのコメント）の範囲。文字列は含まない。閉じていないコメントは文末まで */
export function sqlComments(
  dialect: Dialect,
  text: string,
): { start: number; end: number }[] {
  return scan(dialect, text)
    .opaque.filter((o) => o.line || text.startsWith("/*", o.start))
    .map(({ start, end }) => ({ start, end }));
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
/** SQL の予約語か（大文字小文字を区別しない） */
export function isReservedWord(word: string): boolean {
  return RESERVED.has(word.toUpperCase());
}

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
