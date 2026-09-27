// code-server の画面を Playwright で操作するときの共通の部品。start.sh で SQL Server と code-server を起こしてから使う。
// Webview（結果のパネル・差分カメラなど）の中の要素は、frameWith でその Webview のフレームを探して操作する
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

export const WORK = process.env.WORK ?? "/tmp/sql-editor-tool-verify";
export const SHOTS = process.env.SHOTS ?? join(WORK, "shots");
const CS_URL = `http://127.0.0.1:${process.env.CS_PORT ?? "18080"}`;

/** 入れてある Chromium（PLAYWRIGHT_BROWSERS_PATH の下）。CHROME_PATH で変えられる */
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d))) {
    const path = join(root, dir, "chrome-linux", "chrome");
    if (existsSync(path)) return path;
  }
  throw new Error(`Chromium が見つかりません（${root}）。CHROME_PATH で指定してください`);
}

/**
 * code-server を開く。code-server は接続のパスワード（SecretStorage）をブラウザの側に保存するので、
 * 同じブラウザのプロファイルを使い続ける（毎回新しいブラウザだと、追加した接続のパスワードが消える）
 */
export async function open() {
  const browser = await chromium.launchPersistentContext(join(WORK, "pwprofile"), {
    executablePath: chromePath(),
    viewport: { width: 1400, height: 900 },
  });
  await browser.grantPermissions(["clipboard-read", "clipboard-write"], { origin: CS_URL });
  const page = browser.pages()[0] ?? (await browser.newPage());
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(`${CS_URL}/?folder=${encodeURIComponent(join(WORK, "ws"))}`);
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await page.waitForTimeout(4000);
  return { browser, page };
}

/** コマンドパレット（F1）からコマンドを実行する */
export async function command(page, text) {
  await page.keyboard.press("F1");
  await page.waitForTimeout(400);
  await page.keyboard.type(text);
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
}

/** selector の要素がある Webview のフレーム（見つからなければ null） */
export async function frameWith(page, selector, tries = 20) {
  for (let i = 0; i < tries; i++) {
    for (const f of page.frames()) {
      if (await f.locator(selector).count().catch(() => 0)) return f;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/** 要素の文字（空白をまとめる） */
export async function text(locator) {
  return (await locator.innerText()).replace(/\s+/g, " ");
}

/** スクリーンショットを SHOTS に撮る */
export async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

/** サイドバーの「SQL Editor Tool」のビューのうち、names のものを畳む（ほかのビューを広くする） */
export async function collapseViews(page, names) {
  for (const name of names) {
    const header = page.locator(".pane-header", { hasText: name }).first();
    if ((await header.getAttribute("aria-expanded")) === "true") await header.click();
    await page.waitForTimeout(300);
  }
}

export function dbPassword() {
  return readFileSync(join(WORK, ".dbpw"), "utf8").trim();
}

/** Docker の SQL Server で SQL を流す（画面の操作の代わりに DB を書き換えるときなど）。パスワードはコマンドの引数に出さない */
export function sql(query, database = "検証") {
  return execFileSync(
    "docker",
    ["exec", "-e", "SQLCMDPASSWORD", "mssql", "/opt/mssql-tools18/bin/sqlcmd", "-C", "-S", "localhost", "-U", "sa", "-d", database, "-f", "65001", "-b", "-Q", query],
    { env: { ...process.env, SQLCMDPASSWORD: dbPassword() } },
  ).toString();
}
