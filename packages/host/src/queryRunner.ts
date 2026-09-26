// 問い合わせを実行して、行を画面に送る（データビューとレポートで共通）。
// 上限 + 1 行まで取りにいき、はみ出したら打ち切る。中止と、受け取る側の例外もここで扱う

import type { ColumnFilterValue } from "@sql-editor-tool/core";
import type { ToWebview } from "./protocol";
import {
  type CellValue,
  type DbSession,
  isAbortError,
  type QueryRequest,
  type ResultColumn,
} from "./session";

/** 実行の状況を伝えるメッセージ（データビューとレポートの画面で同じ形） */
export type QueryMessage = Extract<
  ToWebview,
  { type: "queryStarted" | "rows" | "queryDone" | "queryFailed" }
>;

export type RunInput = {
  session: DbSession;
  /** 取得の上限（D-11） */
  maxRows: number;
  /** DB で絞り込んだ条件（画面が覚えておき、条件を外したら取り直しを勧める）。条件なしは空 */
  filters: Record<string, ColumnFilterValue>;
  /** SQL を組み立てる。ここで投げた例外（入力の誤りなど）も、実行の失敗として画面に出す */
  build(): { sql: string; params: QueryRequest["params"] };
  intent: QueryRequest["intent"];
  /** 結果の列が届いたとき。行を画面の列の並びに直す関数を返す（直さないなら null） */
  onColumns(
    columns: ResultColumn[],
    queryId: number,
  ): ((row: CellValue[]) => CellValue[]) | null;
};

export class QueryRunner {
  private queryId = 0;
  private running: AbortController | null = null;

  constructor(private readonly post: (message: QueryMessage) => void) {}

  cancel(): void {
    this.running?.abort();
  }

  /** 実行中のものがあれば止めてから、新しく実行する */
  async run(input: RunInput): Promise<void> {
    this.running?.abort();
    const queryId = ++this.queryId;
    const abort = new AbortController();
    this.running = abort;
    const { maxRows } = input;
    const started = Date.now();
    let rowCount = 0;
    let truncated = false;
    // ドライバのイベントの中で投げた例外は失われることがあるので、覚えておいて中断する
    let failure: unknown = null;

    this.post({ type: "queryStarted", queryId, filters: input.filters });
    try {
      const built = input.build();
      let reorder: ((row: CellValue[]) => CellValue[]) | null = null;
      await input.session.query(
        { sql: built.sql, params: built.params, intent: input.intent },
        {
          signal: abort.signal,
          onColumns: (columns) => {
            try {
              reorder = input.onColumns(columns, queryId);
            } catch (error) {
              failure = error;
              abort.abort();
            }
          },
          onRows: (rows) => {
            if (truncated || failure) return;
            let chunk = reorder ? rows.map(reorder) : rows;
            if (rowCount + chunk.length > maxRows) {
              truncated = true;
              chunk = chunk.slice(0, maxRows - rowCount);
            }
            rowCount += chunk.length;
            if (chunk.length > 0) {
              this.post({ type: "rows", queryId, rows: chunk });
            }
            // 上限を超えたら、残りは取らない
            if (truncated) abort.abort();
          },
        },
      );
    } catch (error) {
      const cause = failure ?? error;
      if (!(truncated && isAbortError(cause))) {
        this.post({
          type: "queryFailed",
          queryId,
          message: errorMessage(cause),
          cancelled: isAbortError(cause),
        });
        return;
      }
    } finally {
      if (this.running === abort) this.running = null;
    }
    this.post({
      type: "queryDone",
      queryId,
      rowCount,
      truncated,
      elapsedMs: Date.now() - started,
    });
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
