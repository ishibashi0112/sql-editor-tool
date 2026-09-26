// 拡張本体（Node）と Webview の画面（ブラウザ）をまとめてビルドする。出力は dist/
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
    // VS Code 1.101 以降の Node は 22（tedious 20 が Node 22 以上を求める）
    target: "node22",
    external: ["vscode"],
  }),
  context({
    ...common,
    // データビュー（main）とサイドバーのテーブル検索（search）
    entryPoints: {
      main: here("../webview/src/main.tsx"),
      search: here("../webview/src/search/main.ts"),
    },
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

copyOracleBinaries();

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}

/**
 * node-oracledb の Thick モード用のバイナリ（.node）を dist/oracledb/ に置く。
 * JavaScript はまとめて extension.js に入るが、バイナリはまとめられないので、initOracleClient の binaryDir で指す（D-21）。
 * vsix（会社 PC は Windows）には win32-x64 だけを入れる
 */
function copyOracleBinaries() {
  const require = createRequire(here("../driver-oracle/package.json"));
  const release = join(
    dirname(require.resolve("oracledb/package.json")),
    "build",
    "Release",
  );
  const out = here("./dist/oracledb");
  mkdirSync(out, { recursive: true });
  for (const file of readdirSync(release)) {
    if (!file.endsWith(".node")) continue;
    if (production && !file.endsWith("-win32-x64.node")) continue;
    copyFileSync(join(release, file), join(out, file));
  }
}
