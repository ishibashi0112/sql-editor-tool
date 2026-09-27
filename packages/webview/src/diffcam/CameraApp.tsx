// サイドバーの「差分カメラ」（D-47）。カメラごとに「前を撮る」→ 画面を操作 →「後を撮って比べる」。
// 比べた記録の一覧と、表の条件の入力欄（列の候補付き）もここに出す（D-48）

import type {
  CameraItem,
  ConditionColumn,
  FromCameraView,
  ToCameraView,
} from "@sql-editor-tool/host";
import { useEffect, useRef, useState } from "react";
import type { HostApi } from "../hostApi";
import { ConditionEditor } from "./ConditionEditor";

export type CameraApi = HostApi<FromCameraView, ToCameraView>;

/** 条件を書いている表 */
type Editing = { id: string; index: number };

/** 条件の入力欄の列の候補（取っているところは columns が null） */
type EditingColumns = {
  columns: ConditionColumn[] | null;
  error?: string | undefined;
};

/** サイドバーに出す比べた記録の数（ほかは「もっと見る」） */
const HISTORY_SHOWN = 3;

export function CameraApp({ api }: { api: CameraApi }) {
  const [cameras, setCameras] = useState<CameraItem[] | null>(null);
  /** 畳んだカメラ */
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [editingColumns, setEditingColumns] = useState<EditingColumns>({
    columns: null,
  });

  /** 届いた列の候補が、今書いている表のものか確かめる */
  const editingRef = useRef<Editing | null>(null);

  useEffect(() => {
    const unsubscribe = api.subscribe((message) => {
      if (message.type === "state") setCameras(message.cameras);
      else if (message.type === "columns") {
        const current = editingRef.current;
        if (current?.id === message.id && current.index === message.index) {
          setEditingColumns({ columns: message.columns, error: message.error });
        }
      }
    });
    api.post({ type: "ready" });
    return unsubscribe;
  }, [api]);

  const edit = (next: Editing | null) => {
    editingRef.current = next;
    setEditing(next);
    if (!next) return;
    setEditingColumns({ columns: null });
    api.post({ type: "loadColumns", id: next.id, index: next.index });
  };

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
          editing={editing?.id === camera.id ? editing.index : null}
          editingColumns={editingColumns}
          onEdit={(index) => edit({ id: camera.id, index })}
          onEditDone={() => edit(null)}
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
  editing,
  editingColumns,
  onEdit,
  onEditDone,
}: {
  camera: CameraItem;
  folded: boolean;
  onToggle(): void;
  post(message: FromCameraView): void;
  /** 条件を書いている表の添字 */
  editing: number | null;
  editingColumns: EditingColumns;
  onEdit(index: number): void;
  onEditDone(): void;
}) {
  const { id, before, busy, history } = camera;
  const [moreHistory, setMoreHistory] = useState(false);
  const shownHistory = moreHistory ? history : history.slice(0, HISTORY_SHOWN);
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
          {history.length > 0 && (
            <div className="camera-history">
              <div className="camera-history-title">
                比べた記録（クリックで差分を開く。VS Code を閉じるまで）
              </div>
              <ul>
                {shownHistory.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      className="history-item"
                      onClick={() =>
                        post({ type: "openDiff", id, entry: h.id })
                      }
                      title={`前 ${clock(h.beforeAt)} → 後 ${clock(h.afterAt)}`}
                    >
                      <span className="history-seq">{h.seq} 回目</span>
                      <span className="history-time">{clock(h.afterAt)}</span>
                      <span className="history-summary">{h.summary}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {history.length > HISTORY_SHOWN && (
                <button
                  type="button"
                  className="link"
                  onClick={() => setMoreHistory((v) => !v)}
                >
                  {moreHistory
                    ? "少なくする"
                    : `ほか ${history.length - HISTORY_SHOWN} 回を見る`}
                </button>
              )}
            </div>
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
                    aria-expanded={editing === index}
                    onClick={() =>
                      editing === index ? onEditDone() : onEdit(index)
                    }
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
                {editing === index ? (
                  <ConditionEditor
                    table={table.logicalName ?? table.name}
                    initial={table.where ?? ""}
                    dialect={camera.dialect}
                    columns={editingColumns.columns}
                    columnsError={editingColumns.error}
                    onSave={(where) => {
                      post({ type: "setCondition", id, index, where });
                      onEditDone();
                    }}
                    onCancel={onEditDone}
                  />
                ) : (
                  table.where && (
                    <button
                      type="button"
                      className="camera-where"
                      title="条件を変える"
                      onClick={() => onEdit(index)}
                    >
                      条件：{table.where}
                    </button>
                  )
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
