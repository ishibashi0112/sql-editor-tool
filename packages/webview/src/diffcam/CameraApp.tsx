// サイドバーの「差分カメラ」（D-47）。カメラごとに「前を撮る」→ 画面を操作 →「後を撮って比べる」

import type {
  CameraItem,
  FromCameraView,
  ToCameraView,
} from "@sql-editor-tool/host";
import { useEffect, useState } from "react";
import type { HostApi } from "../hostApi";

export type CameraApi = HostApi<FromCameraView, ToCameraView>;

export function CameraApp({ api }: { api: CameraApi }) {
  const [cameras, setCameras] = useState<CameraItem[] | null>(null);
  /** 畳んだカメラ */
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const unsubscribe = api.subscribe((message) => {
      if (message.type === "state") setCameras(message.cameras);
    });
    api.post({ type: "ready" });
    return unsubscribe;
  }, [api]);

  if (cameras === null) return null;
  const toggle = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="cameras">
      {cameras.length === 0 && (
        <p className="camera-help">
          画面を操作する前と後で表を撮って、変わった行と列を比べます（動作確認・検証の記録に）。
        </p>
      )}
      {cameras.map((camera) => (
        <Camera
          key={camera.id}
          camera={camera}
          folded={folded.has(camera.id)}
          onToggle={() => toggle(camera.id)}
          post={(message) => api.post(message)}
        />
      ))}
      <button
        type="button"
        className="link"
        onClick={() => api.post({ type: "create" })}
      >
        ＋ カメラを作る
      </button>
    </div>
  );
}

function Camera({
  camera,
  folded,
  onToggle,
  post,
}: {
  camera: CameraItem;
  folded: boolean;
  onToggle(): void;
  post(message: FromCameraView): void;
}) {
  const { id, before, busy } = camera;
  return (
    <section className="camera">
      <div className="camera-title">
        <button
          type="button"
          className="fold"
          aria-expanded={!folded}
          onClick={onToggle}
        >
          {folded ? "▸" : "▾"}{" "}
          <span className="camera-name">{camera.name}</span>
        </button>
        <span className="camera-meta">
          {camera.connection}・{camera.tables.length} 表
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="icon"
          title="名前を変える"
          onClick={() => post({ type: "rename", id })}
        >
          ✎
        </button>
        <button
          type="button"
          className="icon"
          title="カメラを消す"
          onClick={() => post({ type: "delete", id })}
        >
          🗑
        </button>
      </div>
      {!folded && (
        <>
          <div className="camera-buttons">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => post({ type: "takeBefore", id })}
            >
              📷 前を撮る
            </button>
            <button
              type="button"
              disabled={busy !== null || before === null}
              title={
                before === null ? "先に「前を撮る」を押してください" : undefined
              }
              onClick={() => post({ type: "takeAfter", id })}
            >
              📷 後を撮って比べる
            </button>
          </div>
          <p className="camera-state">
            {busy ? (
              <>
                「{busy.what === "before" ? "前" : "後"}」を撮っています…（
                {busy.done} / {busy.total} 表）{" "}
                <button
                  type="button"
                  className="link"
                  onClick={() => post({ type: "cancel", id })}
                >
                  中止
                </button>
              </>
            ) : before ? (
              <>
                前：<b>{clock(before.takenAt)}</b> に撮影（{before.tables} 表・
                {before.rows.toLocaleString("ja-JP")} 行・
                {(before.elapsedMs / 1000).toFixed(1)} 秒
                {before.errors > 0 ? `・撮れなかった表 ${before.errors}` : ""}）
                <br />→ 画面を操作してから「後を撮って比べる」
              </>
            ) : (
              "まだ「前」を撮っていません"
            )}
          </p>
          {camera.hasDiff && (
            <button
              type="button"
              className="link"
              onClick={() => post({ type: "openDiff", id })}
            >
              前回の差分を開く
            </button>
          )}
          <ul className="camera-tables">
            {camera.tables.map((table, index) => (
              <li key={`${table.schema}.${table.name}`}>
                <div className="camera-table">
                  <span className="table-name">
                    {table.logicalName ?? table.name}
                  </span>
                  {table.logicalName && (
                    <span className="table-phys">{table.name}</span>
                  )}
                  <span className="spacer" />
                  <button
                    type="button"
                    className="icon"
                    title="条件を付ける・変える（大きい表は行を絞る）"
                    onClick={() => post({ type: "editCondition", id, index })}
                  >
                    条件
                  </button>
                  <button
                    type="button"
                    className="icon"
                    title="この表を外す"
                    onClick={() => post({ type: "removeTable", id, index })}
                  >
                    ×
                  </button>
                </div>
                {table.where && (
                  <button
                    type="button"
                    className="camera-where"
                    title="条件を変える"
                    onClick={() => post({ type: "editCondition", id, index })}
                  >
                    条件：{table.where}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="link"
            onClick={() => post({ type: "addTables", id })}
          >
            ＋ 表を足す・外す
          </button>
        </>
      )}
    </section>
  );
}

function clock(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
