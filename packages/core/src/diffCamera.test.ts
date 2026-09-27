import { describe, expect, test } from "vitest";
import { diffTable, diffText, summary, type TableSnapshot } from "./diffCamera";

// 表・列・値は架空
const STOCK = ["ITEM_CD", "WH_CD", "STOCK_QTY", "UPD_YMD"];
const snap = (
  rows: (string | number | null)[][],
  key = ["ITEM_CD", "WH_CD"],
  columns = STOCK,
): TableSnapshot => ({ columns, key, rows });

describe("diffTable", () => {
  test("キーで行を組にし、変わった列・追加・削除を出す（変更・追加・削除の順）", () => {
    const diff = diffTable(
      snap([
        ["A001", "01", 120, "20260915"],
        ["A002", "01", 40, "20260901"],
        ["B010", "02", 8, "20260920"],
      ]),
      snap([
        ["A001", "01", 117, "20260927"],
        ["A002", "01", 40, "20260901"],
        ["C020", "01", 5, "20260927"],
      ]),
    );
    expect(diff).toMatchObject({
      added: 1,
      deleted: 1,
      changedRows: 1,
      unchanged: 1,
      columnsChanged: false,
    });
    expect(diff.changes).toEqual([
      {
        kind: "changed",
        before: ["A001", "01", 120, "20260915"],
        after: ["A001", "01", 117, "20260927"],
        changed: [2, 3],
      },
      { kind: "added", row: ["C020", "01", 5, "20260927"] },
      { kind: "deleted", row: ["B010", "02", 8, "20260920"] },
    ]);
  });

  test("NULL と空文字は別の値。型が違えば（1 と '1'）変わったとみなす", () => {
    const diff = diffTable(
      snap([
        ["A", "01", null, ""],
        ["B", "01", 1, "x"],
      ]),
      snap([
        ["A", "01", null, null],
        ["B", "01", "1", "x"],
      ]),
    );
    expect(diff.changes.map((c) => c.kind === "changed" && c.changed)).toEqual([
      [3],
      [2],
    ]);
  });

  test("キーがない表は、中身がまったく同じ行を組にし、残りを追加と削除にする（同じ行が 2 つあっても数える）", () => {
    const diff = diffTable(
      snap(
        [
          ["A", "01", 1, "x"],
          ["A", "01", 1, "x"],
          ["B", "01", 2, "y"],
        ],
        [],
      ),
      snap(
        [
          ["A", "01", 1, "x"],
          ["B", "01", 3, "y"],
        ],
        [],
      ),
    );
    expect(diff).toMatchObject({
      added: 1,
      deleted: 2,
      changedRows: 0,
      unchanged: 1,
    });
  });

  test("列が変わった（足した・消した）ときは、後の列の並びで比べる", () => {
    const diff = diffTable(
      snap([["A", "01", 1, "x"]]),
      snap(
        [["A", "01", "新", 1]],
        ["ITEM_CD", "WH_CD"],
        ["ITEM_CD", "WH_CD", "NOTE", "STOCK_QTY"],
      ),
    );
    expect(diff.columnsChanged).toBe(true);
    expect(diff.changes).toEqual([
      {
        kind: "changed",
        before: ["A", "01", null, 1],
        after: ["A", "01", "新", 1],
        changed: [2],
      },
    ]);
  });
});

describe("diffText（テキストでコピー）", () => {
  test("表ごとに見出しと 1 行 1 文。論理名で、NULL と空も分かるように", () => {
    const stock = diffTable(
      snap([
        ["A001", "01", 120, "20260915"],
        ["B010", "02", 8, null],
      ]),
      snap([
        ["A001", "01", 117, "20260927"],
        ["C020", "01", 5, ""],
      ]),
    );
    const log = diffTable(snap([], []), snap([], []));
    expect(
      diffText("差分カメラ「受注登録の確認」 前 10:15:32 → 後 10:18:05", [
        {
          title: "在庫 STOCK",
          diff: stock,
          labels: ["品目コード", "倉庫", "在庫数", "更新日"],
        },
        { title: "引当履歴 ALLOC_HISTORY", diff: log, labels: STOCK },
        {
          title: "操作ログ OPERATION_LOG",
          diff: log,
          labels: [],
          error: "10 万行を超えます",
        },
      ]),
    ).toBe(
      [
        "差分カメラ「受注登録の確認」 前 10:15:32 → 後 10:18:05",
        "",
        "在庫 STOCK　変更 1 行・追加 1 行・削除 1 行",
        "✎ 品目コード=A001・倉庫=01　在庫数 120 → 117　／　更新日 20260915 → 20260927",
        "＋ 品目コード=C020・倉庫=01　在庫数=5　更新日=（空）",
        "− 品目コード=B010・倉庫=02　在庫数=8　更新日=NULL",
        "",
        "引当履歴 ALLOC_HISTORY　変化なし",
        "",
        "操作ログ OPERATION_LOG　撮れませんでした：10 万行を超えます",
      ].join("\n"),
    );
  });

  test("summary", () => {
    expect(summary(diffTable(snap([]), snap([["A", "1", 1, "x"]])))).toBe(
      "追加 1 行",
    );
  });
});
