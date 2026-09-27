// 設定の書き出し・読み込み（別の PC への引き継ぎ、D-44）のうち、VS Code に依存しない部分。
// 書き出すのは、接続（パスワードは除く）・ファイルごとの接続・入力欄の設定と値・列の設定・拡張の設定。
// ファイルごとのものは .sql の URI で覚えているので、別の PC で .sql の置き場所が違えば、フォルダを付け替える

export const SETTINGS_FORMAT = "sql-editor-tool-settings";
export const SETTINGS_VERSION = 1;

/** 書き出すファイルの中身。パスワードは入れない */
export type SettingsExport = {
  format: typeof SETTINGS_FORMAT;
  version: number;
  exportedAt: string;
  /** 接続（id は PC ごとに振り直すので、読み込むときは使わない） */
  connections: Record<string, unknown>[];
  /** .sql の URI → 接続名 */
  fileConnections: Record<string, string>;
  /** .sql の URI → 入力欄の設定 */
  paramSettings: Record<string, unknown>;
  /** .sql の URI → 入力欄に最後に入れた値 */
  formValues: Record<string, unknown>;
  /** [接続名, スキーマ, テーブル] の JSON → 列の設定 */
  tableSettings: Record<string, unknown>;
  /** 差分カメラ（D-47）。0.11.0 より前の書き出しにはない */
  diffCameras: Record<string, unknown>[];
  /** 拡張の設定（sqlEditorTool. を除いた名前 → 値）。自分で変えたものだけ */
  settings: Record<string, unknown>;
};

/** 読み込んだ JSON を確かめる。形が違えば、分かるメッセージで例外を投げる */
export function parseSettingsExport(value: unknown): SettingsExport {
  if (!isObject(value) || value.format !== SETTINGS_FORMAT) {
    throw new Error(
      "SQL Editor Tool の設定のファイルではありません（「設定を書き出す」で作ったファイルを選んでください）",
    );
  }
  if (typeof value.version !== "number" || value.version > SETTINGS_VERSION) {
    throw new Error(
      "新しい版の拡張で書き出した設定です。拡張を新しくしてから読み込んでください",
    );
  }
  const record = (key: string): Record<string, unknown> =>
    isObject(value[key]) ? (value[key] as Record<string, unknown>) : {};
  const strings = (key: string): Record<string, string> =>
    Object.fromEntries(
      Object.entries(record(key)).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  const connections = Array.isArray(value.connections)
    ? value.connections.filter(
        (c): c is Record<string, unknown> =>
          isObject(c) &&
          typeof c.name === "string" &&
          (c.driver === "mssql" ||
            c.driver === "oracle" ||
            c.driver === "demo"),
      )
    : [];
  return {
    format: SETTINGS_FORMAT,
    version: value.version,
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : "",
    connections,
    fileConnections: strings("fileConnections"),
    paramSettings: record("paramSettings"),
    formValues: record("formValues"),
    tableSettings: record("tableSettings"),
    diffCameras: Array.isArray(value.diffCameras)
      ? value.diffCameras.filter(
          (c): c is Record<string, unknown> =>
            isObject(c) &&
            typeof c.id === "string" &&
            typeof c.name === "string",
        )
      : [],
    settings: record("settings"),
  };
}

/** ファイルごとの設定の URI（file: のもの） */
export function fileUris(settings: SettingsExport): string[] {
  const uris = new Set([
    ...Object.keys(settings.fileConnections),
    ...Object.keys(settings.paramSettings),
    ...Object.keys(settings.formValues),
  ]);
  return [...uris].filter((uri) => uri.startsWith("file:///"));
}

/**
 * URI のいちばん深い共通のフォルダ（末尾の / なし）。ドライブの直下より浅い（file:///c%3A など）なら null。
 * 大文字小文字は区別しない（Windows のパスのため）。返すのは最初の URI の書き方
 */
export function commonFolder(uris: readonly string[]): string | null {
  const [first] = uris;
  if (first === undefined) return null;
  // "file:", "", "", "c%3A", "Users", …, ファイル名
  const split = (uri: string) => uri.split("/").slice(0, -1);
  let common = split(first);
  for (const uri of uris.slice(1)) {
    const parts = split(uri);
    let n = 0;
    while (
      n < common.length &&
      n < parts.length &&
      common[n]?.toLowerCase() === parts[n]?.toLowerCase()
    ) {
      n += 1;
    }
    common = common.slice(0, n);
  }
  // file: / 空 / 空 / ドライブ（か最初のフォルダ）/ その下 の 5 つ以上
  return common.length >= 5 ? common.join("/") : null;
}

/**
 * ファイルごとの設定の URI を、from のフォルダの下から to のフォルダの下に付け替える（別の PC で置き場所が違うとき）。
 * from の下にないものはそのまま
 */
export function remapFolders(
  settings: SettingsExport,
  from: string,
  to: string,
): SettingsExport {
  const prefix = `${from}/`.toLowerCase();
  const target = to.endsWith("/") ? to : `${to}/`;
  const move = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(record).map(([uri, value]) => [
        uri.toLowerCase().startsWith(prefix)
          ? target + uri.slice(prefix.length)
          : uri,
        value,
      ]),
    );
  return {
    ...settings,
    fileConnections: move(settings.fileConnections),
    paramSettings: move(settings.paramSettings),
    formValues: move(settings.formValues),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
