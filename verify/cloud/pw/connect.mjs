// 接続「検証DB」（Docker の SQL Server、架空の DB「検証」）を追加する。最初に 1 回だけ実行する
import { command, dbPassword, open, shot } from "./common.mjs";

const { browser, page } = await open();
await command(page, "SQL Editor Tool: 接続を追加");
// DB の種類 → ホスト名 → ポート → データベース名 → ユーザー名 → パスワード → 接続名
const port = process.env.MSSQL_PORT ?? "14330";
const steps = ["SQL Server", "localhost", port, "検証", "sa", dbPassword(), "検証DB"];
for (const value of steps) {
  await page.waitForSelector(".quick-input-widget:not([style*='display: none']) input", { timeout: 10000 });
  await page.locator(".quick-input-widget input.input").first().fill(value);
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
}
await page.waitForTimeout(2000);
console.log("撮りました：", await shot(page, "connect"));
await browser.close();
