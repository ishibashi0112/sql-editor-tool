// サイドバーの「差分カメラ」（Webview のビュー）に読み込むエントリ

import "../styles.css";
import "./diffcam.css";
import type { FromCameraView, ToCameraView } from "@sql-editor-tool/host";
import { createRoot } from "react-dom/client";
import { vscodeHostApi } from "../hostApi";
import { CameraApp } from "./CameraApp";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <CameraApp api={vscodeHostApi<FromCameraView, ToCameraView>()} />,
  );
}
