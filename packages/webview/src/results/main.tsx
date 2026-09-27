// 「SQL の結果」のパネル（VS Code の下のパネルの Webview）に読み込むエントリ

import "@ishibashi0112/spreadsheet-grid/style.css";
import "../styles.css";
import type { FromResults, ToResults } from "@sql-editor-tool/host";
import { createRoot } from "react-dom/client";
import { vscodeHostApi } from "../hostApi";
import { ResultsApp } from "./ResultsApp";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <ResultsApp api={vscodeHostApi<FromResults, ToResults>()} />,
  );
}
