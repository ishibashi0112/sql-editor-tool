// 画面の表示の設定（D-40 の列見出しの表示）。拡張が VS Code の設定から送り、画面で切り替えたら拡張に知らせる

import type {
  HeaderMode,
  PrefsMessage,
  SetHeaderModeMessage,
} from "@sql-editor-tool/host";
import { useCallback, useEffect, useState } from "react";
import type { HostApi } from "./hostApi";

/** 設定を受け取れる画面の API（データビュー・レポート・結果のパネル） */
type PrefsApi = HostApi<SetHeaderModeMessage, PrefsMessage | { type: string }>;

/** 列見出しの表示。拡張から届くまでは「両方」 */
export function useHeaderMode(
  api: PrefsApi,
): [HeaderMode, (mode: HeaderMode) => void] {
  const [mode, setMode] = useState<HeaderMode>("both");
  useEffect(
    () =>
      api.subscribe((message) => {
        if (message.type === "prefs") {
          setMode((message as PrefsMessage).headerMode);
        }
      }),
    [api],
  );
  const change = useCallback(
    (next: HeaderMode) => {
      setMode(next);
      api.post({ type: "setHeaderMode", mode: next });
    },
    [api],
  );
  return [mode, change];
}

const LABELS: Record<HeaderMode, string> = {
  both: "両方",
  logical: "論理名",
  physical: "物理名",
};

/** 列見出しに出す名前の切り替え（論理名のある列があるときだけ出す） */
export function HeaderModeToggle({
  mode,
  onChange,
}: {
  mode: HeaderMode;
  onChange(mode: HeaderMode): void;
}) {
  return (
    <span className="segmented" title="列見出しに出す名前">
      <span className="segmented-label">列名</span>
      {(["both", "logical", "physical"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          className={mode === value ? "on" : ""}
          title={
            value === "both"
              ? "物理名の下に論理名を出す"
              : value === "logical"
                ? "論理名を出す（物理名はツールチップ）"
                : "物理名だけを出す"
          }
          onClick={() => onChange(value)}
        >
          {LABELS[value]}
        </button>
      ))}
    </span>
  );
}
