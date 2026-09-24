// 拡張本体（Node）と Webview の画面（ブラウザ）をまとめてビルドする。出力は dist/
import { mkdirSync, rmSync } from "node:fs";
import { context } from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const here = (path) => new URL(path, import.meta.url).pathname;

if (production) {
  // 開発ビルドの .map を vsix に入れないよう、消してから作る。vsce の出力先も用意する
  rmSync(here("./dist"), { recursive: true, force: true });
  mkdirSync(here("../../releases"), { recursive: true });
}

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: "info",
};

const contexts = await Promise.all([
  context({
    ...common,
    entryPoints: [here("./src/extension.ts")],
    outfile: here("./dist/extension.js"),
    format: "cjs",
    platform: "node",
    // VS Code 1.75 の Node は 16
    target: "node16",
    external: ["vscode"],
  }),
  context({
    ...common,
    entryPoints: [here("../webview/src/main.tsx")],
    outdir: here("./dist/webview"),
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        production ? "production" : "development",
      ),
    },
  }),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
