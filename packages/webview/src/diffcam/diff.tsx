// 差分カメラの差分のタブ（エディタの Webview）に読み込むエントリ

import "../styles.css";
import "./diffcam.css";
import type { FromDiffView, ToDiffView } from "@sql-editor-tool/host";
import { createRoot } from "react-dom/client";
import { vscodeHostApi } from "../hostApi";
import { DiffApp } from "./DiffApp";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <DiffApp api={vscodeHostApi<FromDiffView, ToDiffView>()} />,
  );
}
