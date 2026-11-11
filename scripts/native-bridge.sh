#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -n 1)/bin:$PATH"
NODE_BIN=$(which node || echo "/opt/homebrew/bin/node")
exec "$NODE_BIN" "/Users/deskid/git/sidetab-pro/scripts/native-bridge.mjs"
