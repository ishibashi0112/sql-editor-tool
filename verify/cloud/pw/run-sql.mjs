// .sql の実行（D-41・D-43）：BI用の確認.sql を開いて Ctrl+Enter → 入力欄に値を入れて Enter → 結果を出す
import { command, frameWith, open, shot, text } from "./common.mjs";

const { browser, page } = await open();
await command(page, "View: Close All Editors");
await page.keyboard.press("Control+p");
await page.waitForTimeout(500);
await page.keyboard.type("BI用の確認");
await page.waitForTimeout(800);
await page.keyboard.press("Enter");
await page.waitForTimeout(3000);
await page.keyboard.press("Control+g");
await page.keyboard.type("2");
await page.keyboard.press("Enter");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(4000);
const results = await frameWith(page, '[data-param="開始日"]');
console.log("入力欄：", results !== null);
if (results) {
  // 名前が「日」で終わるので日付の欄になる（D-43）。日付の欄は yyyy-mm-dd で入れる
  await results.locator('[data-param="開始日"] input').fill("2026-09-01");
  const customer = results.locator('[data-param="得意先"] input');
  await customer.fill("C00001");
  await customer.press("Enter");
  await page.waitForTimeout(4000);
  console.log("結果：", (await text(results.locator("body"))).slice(0, 400));
}
console.log("撮りました：", await shot(page, "run-sql"));
await browser.close();
