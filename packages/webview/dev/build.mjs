// 開発用ページをビルドする。出力は dev/dist（コミットしない）。index.html（データビュー）、search.html（テーブル検索）、report.html（レポート）をブラウザで開く
import { build } from "esbuild";

await build({
  entryPoints: [
    new URL("./dev.tsx", import.meta.url).pathname,
    new URL("./search.ts", import.meta.url).pathname,
    new URL("./report.tsx", import.meta.url).pathname,
  ],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  sourcemap: true,
  outdir: new URL("./dist", import.meta.url).pathname,
  logLevel: "info",
});
