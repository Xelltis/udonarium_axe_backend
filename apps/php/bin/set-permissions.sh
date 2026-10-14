#!/bin/bash
# ------------------------------------------------------------------
# さくらのレンタルサーバー向けパーミッション設定スクリプト
#
# CGI / FastCGI (suEXEC) 環境を想定。
# デプロイ先ディレクトリのルートで実行してください。
#
# 使い方:
#   bash bin/set-permissions.sh            # カレントディレクトリに適用
#   bash bin/set-permissions.sh /path/to   # 指定ディレクトリに適用
# ------------------------------------------------------------------

set -euo pipefail

TARGET="${1:-.}"

if [[ ! -f "${TARGET}/index.php" ]]; then
    echo "Error: index.php が見つかりません。デプロイ先のルートを指定してください。" >&2
    exit 1
fi

echo "==> パーミッションを設定します: ${TARGET}"

# ── ディレクトリ: 755 ─────────────────────────────────────────────
find "${TARGET}" -type d -exec chmod 755 {} +

# ── 一般ファイル: 644 ────────────────────────────────────────────
find "${TARGET}" -type f -exec chmod 644 {} +

# ── .env（機密情報）: 600 ────────────────────────────────────────
if [[ -f "${TARGET}/.env" ]]; then
    chmod 600 "${TARGET}/.env"
    echo "    .env                -> 600"
fi

echo ""
echo "==> 完了"
echo ""
echo "  ディレクトリ          755 (rwxr-xr-x)"
echo "  一般ファイル          644 (rw-r--r--)"
echo "  .env                  600 (rw-------)"
