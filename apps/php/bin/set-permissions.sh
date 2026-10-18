#!/bin/bash
# ------------------------------------------------------------------
# A script that sets file permissions for Sakura Rental Server.
#
# It assumes a CGI / FastCGI (suEXEC) setup.
# Run it at the root of the directory deployed to.
#
# Usage:
#   bash bin/set-permissions.sh            # Applies to the current directory.
#   bash bin/set-permissions.sh /path/to   # Applies to the given directory.
# ------------------------------------------------------------------

set -euo pipefail

TARGET="${1:-.}"

if [[ ! -f "${TARGET}/index.php" ]]; then
    echo "Error: index.php が見つかりません。デプロイ先のルートを指定してください。" >&2
    exit 1
fi

echo "==> パーミッションを設定します: ${TARGET}"

# ── Directories: 755 ──────────────────────────────────────────────
find "${TARGET}" -type d -exec chmod 755 {} +

# ── Regular files: 644 ───────────────────────────────────────────
find "${TARGET}" -type f -exec chmod 644 {} +

# ── .env (secrets): 600 ──────────────────────────────────────────
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
