#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_BIN=${TABFLOW_NODE:-$(command -v node)}
exec "$NODE_BIN" "$SCRIPT_DIR/native-bridge.mjs"
