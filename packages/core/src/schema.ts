// スキーマモデル。DB 上の型と「意味上の型」を分けて持つ（D-06）

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
  | { kind: "number"; precision: number | null; scale: number | null }
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

/** 問い合わせの対象。段階1はテーブル／ビュー、段階2は利用者が書いたベースSQL */
export type QuerySource =
  | { kind: "table"; table: TableRef }
  | { kind: "baseSql"; sql: string };
