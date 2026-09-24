// VS Code の配色（body の vscode-light / vscode-dark / vscode-high-contrast クラス）をグリッドの theme にする

import type { GridTheme } from "@ishibashi0112/spreadsheet-grid";
import { useEffect, useState } from "react";

function currentTheme(): GridTheme {
  const classes = document.body.classList;
  if (
    classes.contains("vscode-light") ||
    classes.contains("vscode-high-contrast-light")
  ) {
    return "light";
  }
  if (
    classes.contains("vscode-dark") ||
    classes.contains("vscode-high-contrast")
  ) {
    return "dark";
  }
  // VS Code の外（開発用ページ）では OS の設定に従う
  return "auto";
}

export function useVsCodeTheme(): GridTheme {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}
