// SQL の生成（D-49）を通しで確かめる：テーブル検索の右クリック「SQL を生成…」→ 付けるものを選ぶ（前の選び方のまま Enter）→
// 新しいエディタに SELECT（論理名のコメント、主キーの :名前、主キーの順）→ 整形しても形が変わらない →
// Ctrl+Enter → 主キーの入力欄（論理名）に値 → 1 行。
// 続けて、.sql の右クリック「テーブルから SQL を生成（カーソルの位置に入れる）」で別の表を入れ、
// 名前を付けて保存しても接続が引き継がれることと、接続のツリーの表の右クリックにもあることを確かめる。
// 表は架空の DB「検証」の ORDER_LINES（主キー 2 列）と CUSTOMERS
import { rmSync } from "node:fs";
import { join } from "node:path";
import { collapseViews, command, frameWith, open, shot, text, WORK } from "./common.mjs";

const { browser, page } = await open();
await command(page, "View: Close All Editors");
await command(page, "Focus on テーブル検索 View");
await page.waitForTimeout(1500);
await collapseViews(page, ["差分カメラ"]);

// テーブル検索：未接続なら接続し、ORDER_LINES を論理名で探す
const search = await frameWith(page, ".box input");
const connect = search.getByRole("button", { name: "接続" });
if (await connect.count()) {
  await connect.first().click();
  await page.waitForTimeout(3000);
}
await search.locator(".box input").fill("受注行");
await page.waitForTimeout(800);
const row = search.locator(".item", { hasText: "ORDER_LINES" }).first();
console.log("検索の結果：", await text(row));

// 右クリック → 「SQL を生成…」
await row.click({ button: "right" });
await page.waitForTimeout(800);
await shot(page, "generate-sql-1-menu");
await page.locator(".context-view .action-label", { hasText: "SQL を生成…" }).first().click();
await page.waitForTimeout(2500);
console.log("付けるもの：", (await text(page.locator(".quick-input-widget"))).slice(0, 600));
await shot(page, "generate-sql-2-options");
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);

const editorLines = page.locator(".monaco-editor .view-lines").first();
console.log("生成した SQL：\n" + (await editorLines.innerText()).replace(/ /g, " "));
console.log("タブ：", await text(page.locator(".tabs-container")));
console.log("ステータスバー：", await text(page.locator(".statusbar")));
await shot(page, "generate-sql-3-editor");

// 整形（D-45）しても、コメントの前の空白が詰まるほかは変わらない（, は行の終わり）
const before = (await editorLines.innerText()).replace(/\u00a0/g, " ");
await command(page, "SQL Editor Tool: SQL を整形");
await page.waitForTimeout(1500);
const after = (await editorLines.innerText()).replace(/\u00a0/g, " ");
console.log("整形した後：\n" + after);
console.log("整形で変わったのはコメントの前の空白だけ：", after === before.replace(/ +-- /g, " -- "));
await shot(page, "generate-sql-3b-formatted");

// Ctrl+Enter → 主キーの入力欄（表示名は論理名）
await editorLines.click({ position: { x: 300, y: 5 } });
await page.keyboard.press("Control+Home");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(4000);
const results = await frameWith(page, '[data-param="ORDER_NO"]');
console.log("入力欄：", results !== null);
if (results) {
  await results.locator('[data-param="ORDER_NO"] input').fill("D001");
  const line = results.locator('[data-param="LINE_NO"] input');
  await line.fill("2");
  await line.press("Enter");
  await page.waitForTimeout(4000);
  console.log("結果：", (await text(results.locator("body"))).slice(0, 500));
}
await shot(page, "generate-sql-4-run");

// .sql の右クリック（Shift+F10。カーソルは動かない）：文の後ろで「テーブルから SQL を生成（カーソルの位置に入れる）」→
// 得意先を論理名で探す
await editorLines.click({ position: { x: 300, y: 5 } });
await page.keyboard.press("Control+End");
await page.keyboard.press("Enter");
await page.keyboard.press("Shift+F10");
await page.waitForTimeout(1000);
const menuItem = page.locator(".context-view .action-label", { hasText: "テーブルから SQL を生成" }).first();
console.log("エディタの右クリックの項目：", await menuItem.count());
await shot(page, "generate-sql-5-editor-menu");
await menuItem.click();
await page.waitForTimeout(1500);
await page.keyboard.type("得意先");
await page.waitForTimeout(800);
console.log("表の一覧：", (await text(page.locator(".quick-input-list"))).slice(0, 200));
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
// 付けるもの：スキーマ名を外す（行をクリックしてから OK。README の癖）。外した選び方は次に覚えている
await page.locator(".quick-input-list .monaco-list-row", { hasText: "スキーマ名を付ける" }).first().click();
await page.waitForTimeout(300);
await shot(page, "generate-sql-6-options-here");
await page.getByRole("button", { name: "OK" }).click();
await page.waitForTimeout(2000);
console.log("入れた後：\n" + (await editorLines.innerText()).replace(/ /g, " "));
await shot(page, "generate-sql-7-inserted");

// 名前を付けて保存 → 接続が引き継がれる（ステータスバーが「（自動）」にならない）
const saved = join(WORK, "ws", "生成した.sql");
rmSync(saved, { force: true });
await page.keyboard.press("Control+Shift+s");
await page.waitForTimeout(1200);
await page.locator(".quick-input-widget input.input").first().fill(saved);
await page.waitForTimeout(500);
await page.getByRole("button", { name: "OK" }).click();
await page.waitForTimeout(6500);
console.log("保存した後のタブ：", await text(page.locator(".tabs-container")));
console.log("保存した後のステータスバー：", await text(page.locator(".statusbar")));
await shot(page, "generate-sql-8-saved");

// 接続のツリーの表の右クリックにも「SQL を生成…」がある
await collapseViews(page, ["テーブル検索"]);
const connection = page.locator(".monaco-list-row", { hasText: "検証DB" }).first();
if ((await connection.getAttribute("aria-expanded")) !== "true") await connection.click();
await page.waitForTimeout(1500);
const dbo = page.locator(".monaco-list-row", { hasText: "dbo" }).first();
if ((await dbo.getAttribute("aria-expanded")) !== "true") await dbo.click();
await page.waitForTimeout(1500);
await page.locator(".monaco-list-row", { hasText: "CUSTOMERS" }).first().click({ button: "right" });
await page.waitForTimeout(800);
console.log("ツリーの右クリック：", await text(page.locator(".context-view").first()));
await shot(page, "generate-sql-9-tree-menu");
await page.locator(".context-view .action-label", { hasText: "SQL を生成…" }).first().click();
await page.waitForTimeout(2000);
// 前に外したスキーマ名は外れたまま（5 つのうち 4 つ）。付け直して、次に流したときも同じ選び方から始める
console.log("覚えた選び方：", (await text(page.locator(".quick-input-widget"))).slice(0, 80));
await page.locator(".quick-input-list .monaco-list-row", { hasText: "スキーマ名を付ける" }).first().click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "OK" }).click();
await page.waitForTimeout(2000);
console.log("ツリーから：\n" + (await editorLines.innerText()).replace(/\u00a0/g, " "));
await command(page, "View: Revert and Close Editor");
await browser.close();
