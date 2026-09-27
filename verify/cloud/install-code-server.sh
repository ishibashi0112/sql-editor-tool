#!/usr/bin/env bash
# code-server（ブラウザで動く VS Code）を入れる。この環境からは VS Code 本体をダウンロードできないので、npm の code-server を使う。
# 使い方：install-code-server.sh <入れるフォルダ>
# GitHub からの取得が止められているので、インストールのスクリプトは動かさず、ネイティブの部品だけ作り直し、ripgrep は OS のものを置く
set -euo pipefail
DEST="${1:?入れるフォルダを指定してください}"
VERSION="${CS_VERSION:-4.117.0}"

need_apt=()
command -v rg >/dev/null || need_apt+=(ripgrep)
dpkg -s libkrb5-dev >/dev/null 2>&1 || need_apt+=(libkrb5-dev)
if [ ${#need_apt[@]} -gt 0 ]; then
  apt-get install -y "${need_apt[@]}" || { apt-get update && apt-get install -y "${need_apt[@]}"; }
fi

mkdir -p "$DEST"
cd "$DEST"
[ -f package.json ] || echo '{ "private": true }' > package.json
npm install "code-server@$VERSION" --ignore-scripts --no-audit --no-fund
cd node_modules/code-server/lib/vscode
npm install --omit=dev --ignore-scripts --no-audit --no-fund
# ネイティブの部品（native-watchdog は拡張ホストが使う。作らないとログにエラーが出る。kerberos は libkrb5-dev が要る）
npm rebuild @vscode/spdlog @vscode/sqlite3 @vscode/native-watchdog kerberos
mkdir -p node_modules/@vscode/ripgrep/bin
cp "$(command -v rg)" node_modules/@vscode/ripgrep/bin/rg
echo "code-server $VERSION を入れました：$DEST"
