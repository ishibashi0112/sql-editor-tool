// 開発用ページをビルドする。出力は dev/dist（コミットしない）。index.html をブラウザで開く
import { build } from "esbuild";

await build({
  entryPoints: [new URL("./dev.tsx", import.meta.url).pathname],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  sourcemap: true,
  outdir: new URL("./dist", import.meta.url).pathname,
  logLevel: "info",
});
