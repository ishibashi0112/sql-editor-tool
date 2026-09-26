// スキーマモデル。DB 上の型と「意味上の型」を分けて持つ（D-06）

import type { ReportConfig, ReportValues } from "./report";

/** DB 上の型を、SQL の生成に必要な粒度にまとめたもの。ドライバのアダプタがメタデータから作る */
export type ColumnType =
  | {
      kind: "string";
      /** NVARCHAR / NCHAR / NVARCHAR2 など。SQL Server ではバインド型の VARCHAR と NVARCHAR の選択に使う */
      unicode: boolean;
      /** CHAR / NCHAR */
      fixedLength: boolean;
      /** 宣言された長さ。MAX や不明のときは null */
      length: number | null;
    }
  | {
      kind: "number";
      precision: number | null;
      scale: number | null;
      /**
       * ドライバが値を正確に受け取れない列。SELECT で文字列に変換して取る。
       * SQL Server の 16 桁以上の decimal / numeric（tedious は JavaScript の数値で読むので、下の桁が狂う）
       */
      asText?: boolean;
    }
  | {
      kind: "datetime";
      /** 時刻部分を持ちうるか。SQL Server の date は false、datetime や Oracle の DATE は true */
      hasTime: boolean;
    }
  | { kind: "other"; dbTypeName: string };

/** 意味上の型。例：VARCHAR(8) だが中身は yyyymmdd の日付 */
export type SemanticType = { kind: "date"; format: "yyyymmdd" };

export type ColumnInfo = {
  /** DB 上の列名（引用符なし、格納されているとおりの大文字小文字）。グリッドの列キーにも使う */
  name: string;
  type: ColumnType;
  semantic?: SemanticType;
};

export type TableRef = {
  schema: string;
  name: string;
};

/**
 * 問い合わせの対象。段階1はテーブル／ビュー、段階2は利用者が書いたベースSQL か、
 * フォームの値を入れたレポートの SQL（§16）
 */
export type QuerySource =
  | { kind: "table"; table: TableRef }
  | { kind: "baseSql"; sql: string }
  | {
      kind: "report";
      sql: string;
      config: ReportConfig;
      values: ReportValues;
    };

/** DB に依存しない型の表示（例：文字列(8)、数値(15,2)、日時） */
export function columnTypeLabel(type: ColumnType): string {
  switch (type.kind) {
    case "string":
      return `${type.fixedLength ? "固定長の文字列" : "文字列"}(${type.length ?? "最大"})`;
    case "number":
      return type.precision === null
        ? "数値"
        : type.scale
          ? `数値(${type.precision},${type.scale})`
          : `数値(${type.precision})`;
    case "datetime":
      return type.hasTime ? "日時" : "日付";
    case "other":
      return type.dbTypeName;
  }
}
