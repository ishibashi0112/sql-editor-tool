/** SQL を組み立てられないときのエラー。メッセージはそのまま画面に出す */
export class QueryBuildError extends Error {
  constructor(
    message: string,
    /** 原因の列（列に紐づかないときは undefined） */
    readonly columnKey?: string,
  ) {
    super(message);
    this.name = "QueryBuildError";
  }
}
