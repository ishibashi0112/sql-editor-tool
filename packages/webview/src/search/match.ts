// テーブル検索の判定。名前の部分一致で、全角半角・大文字小文字を区別しない

import type { SchemaObject } from "@sql-editor-tool/host";

export type SearchHit = {
  object: SchemaObject;
  /** 名前の中で、最初の語に一致した範囲（強調表示用）。出せないときは null */
  highlight: readonly [number, number] | null;
};

/** 全角英数と半角カナをそろえ、大文字小文字を区別しない */
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

/**
 * 空白で区切った語をすべて含むもの（「スキーマ.名前」のどこかに含む）。
 * 並びは、名前が最初の語で始まるもの → 名前に含むもの → スキーマだけに含むもの、同じなら名前が短い順
 */
export function searchObjects(
  objects: readonly SchemaObject[],
  query: string,
  limit: number,
): { hits: SearchHit[]; total: number } {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const [first] = terms;
  if (first === undefined) return { hits: [], total: 0 };
  const found: { object: SchemaObject; name: string; index: number }[] = [];
  for (const object of objects) {
    const name = normalize(object.name);
    const full = `${normalize(object.schema)}.${name}`;
    if (terms.every((term) => full.includes(term))) {
      found.push({ object, name, index: name.indexOf(first) });
    }
  }
  const rank = (index: number) => (index === 0 ? 0 : index > 0 ? 1 : 2);
  found.sort(
    (a, b) =>
      rank(a.index) - rank(b.index) ||
      a.name.length - b.name.length ||
      a.name.localeCompare(b.name, "ja") ||
      a.object.schema.localeCompare(b.object.schema, "ja"),
  );
  const hits = found.slice(0, limit).map(({ object, name, index }) => ({
    object,
    // 正規化で文字数が変わる名前（半角カナの濁点など）は、位置がずれるので強調しない
    highlight:
      index >= 0 && name.length === object.name.length
        ? ([index, index + first.length] as const)
        : null,
  }));
  return { hits, total: found.length };
}
