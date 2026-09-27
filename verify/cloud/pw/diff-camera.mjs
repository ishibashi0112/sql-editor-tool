// 差分カメラ（D-47・D-48）を通しで確かめる：カメラを作る → 条件（列の一覧から選ぶ）→ 前を撮る →
// DB を書き換える（画面の操作の代わり）→ 後を撮って比べる → もう一度後 → 比べた記録の切り替え →
// 表でコピー（クリップボードの HTML）→ Excel で保存。最後に書き換えた行を元に戻す
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { collapseViews, command, frameWith, open, SHOTS, shot, sql, text } from "./common.mjs";

const { browser, page } = await open();
await command(page, "View: Close All Editors");
await command(page, "Focus on 差分カメラ View");
await page.waitForTimeout(1500);
await collapseViews(page, ["テーブル検索", "接続"]);
const side = await frameWith(page, ".cameras");

// 前の試しのカメラを消す
while ((await side.locator("section.camera").count()) > 0) {
  await side.locator("section.camera").first().getByTitle("カメラを消す").click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "消す" }).click();
  await page.waitForTimeout(800);
}

// 作る：名前 → 表を選ぶ（接続が 1 つなら接続は聞かない。一覧はチェックではなく行をクリックして OK）
await command(page, "SQL Editor Tool: 差分カメラを作る");
await page.waitForTimeout(1000);
await page.keyboard.type("受注登録の確認");
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);
for (const name of ["dbo.ORDERS", "dbo.CUSTOMERS"]) {
  await page.locator(".quick-input-widget input.input").first().fill(name.slice(4));
  await page.waitForTimeout(600);
  await page.locator(".quick-input-list .monaco-list-row", { hasText: name }).first().click();
  await page.waitForTimeout(300);
}
await page.getByRole("button", { name: "OK" }).click();
await page.waitForTimeout(1500);
const camera = side.locator("section.camera").last();

// 条件：列の一覧で論理名で絞って Enter、続けて書き、一覧のクリックでもう 1 つ入れる
await camera.locator(".camera-table", { hasText: "ORDERS" }).getByRole("button", { name: "条件" }).click();
await page.waitForTimeout(1500);
const area = camera.locator("textarea.condition-input");
await camera.getByRole("button", { name: /列を選んで入れる/ }).click();
await page.waitForTimeout(500);
console.log("列の一覧：", await text(camera.locator(".column-list")));
await shot(page, "diff-camera-1-picker");
await camera.locator("input.column-filter").type("受注日");
await camera.locator("input.column-filter").press("Enter");
await page.keyboard.type(" >= '20260901' AND");
await camera.getByRole("button", { name: /列を選んで入れる/ }).click();
await page.waitForTimeout(300);
await camera.locator(".column-list [role=option]", { hasText: "QTY" }).click();
await page.keyboard.type(" > 0");
console.log("条件：", await area.inputValue());
await area.press("Enter");
await page.waitForTimeout(800);

// 前を撮る → 更新・追加 → 後（1 回目）→ 削除 → もう一度後（2 回目）
await camera.getByRole("button", { name: "📷 前を撮る" }).click();
await page.waitForTimeout(3000);
console.log("前：", await text(camera.locator(".camera-state")));
try {
  sql(
    "UPDATE dbo.ORDERS SET QTY = 99 WHERE ORDER_NO = 'D001'; INSERT INTO dbo.ORDERS VALUES ('D005', '20260927', 1, 'C00002'); UPDATE dbo.CUSTOMERS SET CUST_NAME = N'山田商店（本店）' WHERE CUST_CD = 'C00001';",
  );
  await camera.getByRole("button", { name: "📷 後を撮って比べる" }).click();
  await page.waitForTimeout(4000);
  sql("DELETE FROM dbo.ORDERS WHERE ORDER_NO = 'D002';");
  const diff = await frameWith(page, ".diff");
  await diff.getByRole("button", { name: "もう一度「後」を撮る" }).click();
  await page.waitForTimeout(4000);
  console.log("差分のタブ：", await text(diff.locator(".diff-bar")));
  console.log("比べた記録：", await text(camera.locator(".camera-history")));
  await shot(page, "diff-camera-2-diff");

  // 1 回目に切り替える
  const first = await diff.locator("select.diff-history option").last().getAttribute("value");
  await diff.locator("select.diff-history").selectOption(first);
  await page.waitForTimeout(1000);
  console.log("1 回目：", await text(diff.locator(".diff-chips")));
  await camera.locator("button.history-item").first().click();
  await page.waitForTimeout(1000);
  console.log("2 回目：", await text(diff.locator(".diff-chips")));

  // 表でコピー：クリップボードの HTML とタブ区切り
  await diff.getByRole("button", { name: "表でコピー" }).click();
  await page.waitForTimeout(1000);
  const clip = await page.evaluate(async () => {
    const out = {};
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) out[type] = await (await item.getType(type)).text();
    }
    return out;
  });
  writeFileSync(join(SHOTS, "diff-camera-clip.html"), clip["text/html"] ?? "");
  console.log("表でコピー（タブ区切り）：\n" + clip["text/plain"]);

  // Excel で保存：code-server のファイルの選択はパスを打つ欄。Enter ではなく OK を押す（Enter は一覧の項目に当たる）
  await diff.getByRole("button", { name: "Excel で保存" }).click();
  await page.waitForTimeout(1500);
  await page.locator(".quick-input-widget input.input").first().fill(join(SHOTS, "diff-camera.xlsx"));
  await page.waitForTimeout(500);
  await page.locator(".quick-input-widget").getByRole("button", { name: "OK" }).click();
  await page.waitForTimeout(2500);
  console.log("通知：", await text(page.locator(".notifications-toasts")).catch(() => ""));
} finally {
  sql(
    "UPDATE dbo.ORDERS SET QTY = 5 WHERE ORDER_NO = 'D001'; DELETE FROM dbo.ORDERS WHERE ORDER_NO = 'D005'; IF NOT EXISTS (SELECT 1 FROM dbo.ORDERS WHERE ORDER_NO = 'D002') INSERT INTO dbo.ORDERS VALUES ('D002', '20260902', 7, 'C00002'); UPDATE dbo.CUSTOMERS SET CUST_NAME = N'山田商店' WHERE CUST_CD = 'C00001';",
  );
}
await browser.close();
