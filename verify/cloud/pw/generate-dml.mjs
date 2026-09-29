// SQL の生成の INSERT・UPDATE・DELETE（D-49、0.14.0）を確かめる：
// テーブル検索の右クリック「SQL を生成 ▸ INSERT…」→ 新しいエディタ（▶ 実行 は出ない）→ 整形しても崩れない →
// Ctrl+Enter で「実行しません」。接続のツリーの右クリックで UPDATE。コマンドパレットから、主キーのない表（WORK_LOG）の DELETE
// （種類を選ぶ。WHERE の条件は書いてもらう）。最後に、SELECT の後ろに UPDATE を入れても、SELECT は Ctrl+Enter で実行できる
// （; なしで並べた文の区切り）。表は架空の DB「検証」の ORDER_LINES（主キー 2 列）・CUSTOMERS・WORK_LOG（主キーなし）
import { chooseMenu, collapseViews, command, frameWith, open, shot, text } from "./common.mjs";

const { browser, page } = await open();
const editorLines = page.locator(".monaco-editor .view-lines").first();
const editorText = async () => (await editorLines.innerText()).replace(/ /g, " ");
const lenses = () => page.locator(".monaco-editor .codelens-decoration").allInnerTexts();
const toasts = async () => (await page.locator(".notifications-toasts").innerText().catch(() => "")).replace(/\s+/g, " ");

await command(page, "View: Close All Editors");
await command(page, "Notifications: Clear All Notifications");
await command(page, "Focus on テーブル検索 View");
await page.waitForTimeout(1500);
await collapseViews(page, ["差分カメラ"]);

// テーブル検索：ORDER_LINES を右クリック →「SQL を生成 ▸ INSERT…」
const search = await frameWith(page, ".box input");
const connect = search.getByRole("button", { name: "接続" });
if (await connect.count()) {
  await connect.first().click();
  await page.waitForTimeout(3000);
}
await search.locator(".box input").fill("受注行");
await page.waitForTimeout(800);
await search.locator(".item", { hasText: "ORDER_LINES" }).first().click({ button: "right" });
await page.waitForTimeout(800);
await chooseMenu(page, ["SQL を生成"]);
await shot(page, "generate-dml-1-submenu");
await chooseMenu(page, ["INSERT…"]);
await page.waitForTimeout(2000);
console.log("INSERT の付けるもの：", (await text(page.locator(".quick-input-widget"))).slice(0, 300));
await shot(page, "generate-dml-2-options");
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);
const insert = await editorText();
console.log(`INSERT：\n${insert}`);
console.log("▶ 実行 の数：", (await lenses()).length);
console.log("ステータスバー：", await text(page.locator(".statusbar")));
await shot(page, "generate-dml-3-insert");

// 整形しても、コメントの前の空白が詰まるほかは変わらない
await command(page, "SQL Editor Tool: SQL を整形");
await page.waitForTimeout(1500);
console.log("整形で変わったのはコメントの前の空白だけ：", (await editorText()) === insert.replace(/(\S) +-- /g, "$1 -- "));

// Ctrl+Enter：実行しないと知らせる
await editorLines.click({ position: { x: 300, y: 5 } });
await page.keyboard.press("Control+End");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(1500);
console.log("Ctrl+Enter の知らせ：", await toasts());
await shot(page, "generate-dml-4-not-run");
await command(page, "View: Revert and Close Editor");
await command(page, "Notifications: Clear All Notifications");

// 接続のツリー：ORDER_LINES を右クリック →「SQL を生成 ▸ UPDATE…」
await collapseViews(page, ["テーブル検索"]);
const connection = page.locator(".monaco-list-row", { hasText: "検証DB" }).first();
if ((await connection.getAttribute("aria-expanded")) !== "true") await connection.click();
await page.waitForTimeout(1500);
const dbo = page.locator(".monaco-list-row", { hasText: "dbo" }).first();
if ((await dbo.getAttribute("aria-expanded")) !== "true") await dbo.click();
await page.waitForTimeout(1500);
await page.locator(".monaco-list-row", { hasText: "ORDER_LINES" }).first().click({ button: "right" });
await page.waitForTimeout(800);
await chooseMenu(page, ["SQL を生成", "UPDATE…"]);
await page.waitForTimeout(1500);
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);
console.log(`UPDATE：\n${await editorText()}`);
await shot(page, "generate-dml-5-update");
await command(page, "View: Revert and Close Editor");

// コマンドパレット：表（主キーのない WORK_LOG）→ 種類（DELETE）→ 付けるもの
await command(page, "SQL Editor Tool: SQL を生成（SELECT");
await page.waitForTimeout(1500);
await page.keyboard.type("WORK_LOG");
await page.waitForTimeout(800);
await page.keyboard.press("Enter");
await page.waitForTimeout(1000);
console.log("種類の一覧：", (await text(page.locator(".quick-input-widget"))).slice(0, 300));
await page.keyboard.type("DELETE");
await page.waitForTimeout(500);
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
console.log("DELETE の付けるもの：", (await text(page.locator(".quick-input-widget"))).slice(0, 200));
await shot(page, "generate-dml-6-delete-options");
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);
console.log(`DELETE（主キーなし）：\n${await editorText()}`);
await shot(page, "generate-dml-7-delete");
await command(page, "View: Revert and Close Editor");

// SELECT の後ろに UPDATE を入れても、SELECT は Ctrl+Enter で実行できる
await command(page, "SQL Editor Tool: SQL を生成（SELECT");
await page.waitForTimeout(1500);
await page.keyboard.type("ORDER_LINES");
await page.waitForTimeout(800);
await page.keyboard.press("Enter");
await page.waitForTimeout(1000);
await page.keyboard.type("SELECT");
await page.waitForTimeout(500);
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);
await editorLines.click({ position: { x: 300, y: 5 } });
await page.keyboard.press("Control+End");
await page.keyboard.press("Enter");
await page.keyboard.press("Shift+F10");
await page.waitForTimeout(800);
await chooseMenu(page, ["テーブルから SQL を生成（カーソルの位置に入れる）", "UPDATE…"]);
await page.waitForTimeout(1500);
await page.keyboard.type("得意先");
await page.waitForTimeout(800);
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
await page.keyboard.press("Enter");
await page.waitForTimeout(2000);
console.log(`SELECT の後ろに UPDATE：\n${await editorText()}`);
console.log("▶ 実行 の数（SELECT の分だけ）：", (await lenses()).length);
await page.keyboard.press("Control+Home");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(4000);
const results = await frameWith(page, '[data-param="ORDER_NO"]');
console.log("SELECT の入力欄：", results !== null);
if (results) {
  await results.locator('[data-param="ORDER_NO"] input').fill("D001");
  const line = results.locator('[data-param="LINE_NO"] input');
  await line.fill("1");
  await line.press("Enter");
  await page.waitForTimeout(4000);
  console.log("結果：", (await text(results.locator("body"))).match(/\d+ 行（[^）]*）/)?.[0]);
}
await shot(page, "generate-dml-8-select-with-update");
await command(page, "View: Revert and Close Editor");
await browser.close();
