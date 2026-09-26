// VS Code のレポートの Webview に読み込むエントリ

import "@ishibashi0112/spreadsheet-grid/style.css";
import "../styles.css";
import type { FromReport, ToReport } from "@sql-editor-tool/host";
import { createRoot } from "react-dom/client";
import { vscodeHostApi } from "../hostApi";
import { ReportApp } from "./ReportApp";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <ReportApp api={vscodeHostApi<FromReport, ToReport>()} />,
  );
}
