// DB に送る直前の読み取り専用の確認（CLAUDE.md、D-05）。ドライバが実行の前に呼ぶ。
// 送る SQL は core が組み立てたものと、ドライバの固定のメタデータ取得だけ。組み立ての誤りで
// 書き込みの文が紛れ込んでも DB に届かないよう、最後にもう一度確かめる

import { type Token, tokenize } from "./baseSql";
import { scan } from "./completion";
import { type Dialect, type DialectName, getDialect } from "./dialect";

/**
 * 問い合わせに現れてはいけない語（書き込み、定義の変更、権限、プロシージャの実行、FOR UPDATE）。
 * どれも両方の DB で予約語なので、引用符なしの列名としては現れない
 */
const FORBIDDEN_WORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "INTO",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "EXEC",
  "EXECUTE",
]);

/** SELECT / WITH で始まる 1 つの問い合わせでなければ例外を投げる */
export function assertReadOnlyQuery(dialect: DialectName, text: string): void {
  let tokens: Token[];
  try {
    tokens = tokenize(getDialect(dialect), text);
  } catch {
    throw readOnlyError("SQL を解釈できません");
  }
  // 末尾のセミコロンは Oracle ではエラーになるので、core もドライバも付けない。ここでは 1 つも認めない
  if (tokens.some((t) => t.kind === "punct" && t.text === ";")) {
    throw readOnlyError("複数の文が含まれています");
  }
  const [first] = tokens;
  const head = first?.kind === "word" ? first.text.toUpperCase() : "";
  if (head !== "SELECT" && head !== "WITH") {
    throw readOnlyError(`先頭が ${head || "SELECT / WITH"} ではありません`);
  }
  const forbidden = tokens.find(
    (t) => t.kind === "word" && FORBIDDEN_WORDS.has(t.text.toUpperCase()),
  );
  if (forbidden) {
    throw readOnlyError(`${forbidden.text.toUpperCase()} が含まれています`);
  }
}

function readOnlyError(reason: string): Error {
  return new Error(
    `読み取り専用のため、SELECT / WITH の問い合わせ以外は実行しません（${reason}）`,
  );
}

/** 問い合わせではない文の頭の語（このツールでは実行しない） */
const WRITE_HEADS = new Set([...FORBIDDEN_WORDS].filter((w) => w !== "INTO"));

/**
 * 書き込みや定義の変更などの文なら、その頭の語（INSERT・UPDATE など。WITH … UPDATE のような SQL Server の書き方は本体の語）。
 * 問い合わせ（SELECT・WITH … SELECT）やそれ以外なら null。
 * .sql の実行（D-41）で、DB に問い合わせる前に「実行しません」と知らせ、▶ 実行 を出さないのに使う（SQL の生成、D-49）
 */
export function writeStatementKeyword(
  dialect: Dialect,
  text: string,
): string | null {
  const words = scan(dialect, text).tokens.filter(
    (t) => t.kind === "word" && t.depth === 0,
  );
  const [first] = words;
  if (!first) return null;
  let head = first.text.toUpperCase();
  if (head === "WITH") {
    const body = words.find((t) =>
      ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"].includes(
        t.text.toUpperCase(),
      ),
    );
    head = body?.text.toUpperCase() ?? head;
  }
  return WRITE_HEADS.has(head) ? head : null;
}
