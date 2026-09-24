// VS Code の Webview に読み込むエントリ

import "@ishibashi0112/spreadsheet-grid/style.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { vscodeHostApi } from "./hostApi";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App api={vscodeHostApi()} />);
