import { describe, expect, test } from "vitest";
import { type Filters, widenedColumns } from "./widened";

const a: Filters = { CUST_CD: { kind: "set", values: ["C00027"] } };

describe("widenedColumns", () => {
  test("条件なしで取ったなら、画面でどう絞り込んでも足りる", () => {
    expect(widenedColumns({}, a)).toEqual([]);
  });

  test("DB の条件をそのまま残して絞り込みを足すだけなら、足りる", () => {
    expect(
      widenedColumns(a, { ...a, QTY: { kind: "text", value: "1" } }),
    ).toEqual([]);
  });

  test("DB の条件を外したり変えたりした列を返す", () => {
    expect(widenedColumns(a, {})).toEqual(["CUST_CD"]);
    expect(
      widenedColumns(a, { CUST_CD: { kind: "set", values: ["C00001"] } }),
    ).toEqual(["CUST_CD"]);
  });
});
