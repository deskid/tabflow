#!/usr/bin/env bash
set -euo pipefail

# macOS Chrome Native Messaging Host 一键安装脚本
# 默认绑定已发布到 Chrome Web Store 的 TabFlow 扩展 ID，可通过参数或 EXTENSION_ID 环境变量覆盖
EXTENSION_ID="${1:-${EXTENSION_ID:-pnjgkehmcfheoecnhenfeidkpkdjifkm}}"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BRIDGE_SH="$SCRIPT_DIR/native-bridge.sh"

if [ ! -f "$BRIDGE_SH" ]; then
  echo "❌ 未找到桥接脚本: $BRIDGE_SH" >&2
  exit 1
fi

NODE_BIN="${TABFLOW_NODE:-$(command -v node || true)}"
CODEX_BIN="${TABFLOW_CODEX_EXECUTABLE:-$(command -v codex || true)}"

[ -n "$NODE_BIN" ] || { echo "❌ 未找到 node，请先安装 Node.js 24+" >&2; exit 1; }
[ -n "$CODEX_BIN" ] || { echo "❌ 未找到 codex，请先安装官方 Codex CLI" >&2; exit 1; }

NODE_BIN="$("$NODE_BIN" -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$NODE_BIN")"
CODEX_BIN="$("$NODE_BIN" -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$CODEX_BIN")"

SUPPORT_DIR="$HOME/Library/Application Support/TabFlow"
HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
LAUNCHER="$SUPPORT_DIR/run-codex-bridge.sh"
MANIFEST="$HOST_DIR/com.tabflow.codex_bridge.json"

mkdir -p "$SUPPORT_DIR" "$HOST_DIR"

{
  echo '#!/bin/sh'
  echo 'set -eu'
  echo "export TABFLOW_NODE=\"$NODE_BIN\""
  echo "export TABFLOW_CODEX_EXECUTABLE=\"$CODEX_BIN\""
  if [ -n "${CODEX_HOME:-}" ]; then
    echo "export CODEX_HOME=\"$CODEX_HOME\""
  fi
  echo "exec \"$BRIDGE_SH\""
} > "$LAUNCHER"
chmod +x "$LAUNCHER"

cat > "$MANIFEST" <<EOF
{
  "name": "com.tabflow.codex_bridge",
  "description": "TabFlow official Codex app-server stdio bridge",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "✅ 已生成启动器: $LAUNCHER"
echo "✅ 已注册 Chrome Host: $MANIFEST"
echo "🔍 正在自检 Native Host 连接..."

"$NODE_BIN" -e '
const { spawn } = require("node:child_process");
const launcher = process.argv[1];
const frame = (obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length);
  return Buffer.concat([h, b]);
};
const child = spawn(launcher, [], { stdio: ["pipe", "pipe", "pipe"] });
let buf = Buffer.alloc(0);
const timer = setTimeout(() => {
  child.kill();
  console.error("❌ 自检超时（60s）");
  process.exit(1);
}, 60000);
child.stdout.on("data", (c) => { buf = Buffer.concat([buf, c]); });
child.on("error", (err) => {
  clearTimeout(timer);
  console.error("❌ 启动器执行失败:", err.message);
  process.exit(1);
});
child.on("exit", (code) => {
  clearTimeout(timer);
  if (code !== 0) {
    console.error("❌ 自检失败，退出码:", code);
    process.exit(1);
  }
  const replies = [];
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    replies.push(JSON.parse(buf.subarray(4, n + 4).toString("utf8")));
    buf = buf.subarray(n + 4);
  }
  const status = replies[1] || {};
  console.log("✅ 自检结果:", JSON.stringify({
    ping: replies[0]?.type === "PONG",
    loggedIn: status.account?.loggedIn ?? null,
    modelCount: Array.isArray(status.models) ? status.models.length : 0,
    ...(status.accountErrorCode ? { accountErrorCode: status.accountErrorCode } : {}),
    ...(status.modelsErrorCode ? { modelsErrorCode: status.modelsErrorCode } : {})
  }));
  if (status.account?.loggedIn === false) {
    console.log("⚠️ 当前未登录 Codex，请先在终端运行: codex login");
  }
});
child.stdin.end(Buffer.concat([frame({ action: "PING" }), frame({ action: "GET_CODEX_STATUS" })]));
' "$LAUNCHER"
