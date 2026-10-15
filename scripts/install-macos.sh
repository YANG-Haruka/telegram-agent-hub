#!/bin/bash
# Installs the hub on macOS into ~/.agent-hub and starts it at login (launchd, restarted if it dies).
# Run from the repo root after creating config.json:  bash scripts/install-macos.sh
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/.agent-hub"
LABEL="com.agent-hub"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

command -v node >/dev/null || { echo "❌ Node.js not found. Install it first (e.g. brew install node)."; exit 1; }
[ -f "$SRC/config.json" ] || { echo "❌ $SRC/config.json missing: copy examples/config.mac.json and fill in your group ids."; exit 1; }

mkdir -p "$DEST/logs" "$HOME/Library/LaunchAgents"
cp "$SRC/hub.mjs" "$SRC/update.mjs" "$SRC/package.json" "$SRC/package-lock.json" "$SRC/config.json" "$DEST/"
cd "$DEST"
echo "▶ Installing dependencies…"
npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# The Agent SDK's bundled claude binary uses this Mac's own Claude login (also used for the usage panel).
BIN="$(ls -d "$DEST"/node_modules/@anthropic-ai/claude-agent-sdk-darwin-*/claude 2>/dev/null | head -1)"
[ -n "$BIN" ] || BIN="$(command -v claude || true)"
[ -n "$BIN" ] || { echo "❌ claude binary not found"; exit 1; }
if ! "$BIN" auth status 2>/dev/null | grep -q '"loggedIn": true'; then
  echo "▶ Claude is not logged in on this Mac — a browser window will open."
  "$BIN" auth login
fi

# Bot token and your Telegram user id (typed here, never pasted into a chat).
if ! grep -q '^TELEGRAM_BOT_TOKEN=..*' "$DEST/.env" 2>/dev/null; then
  read -rsp "▶ Bot token for THIS machine's bot (hidden): " TOK; echo
  read -rp "▶ Your Telegram user id (numeric): " OWNER
  printf 'TELEGRAM_BOT_TOKEN=%s\nOWNER_ID=%s\n' "$TOK" "$OWNER" > "$DEST/.env"
  chmod 600 "$DEST/.env"
fi

NODE="$(command -v node)"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DEST/hub.mjs</string></array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$DEST/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$DEST/logs/launchd.err.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 5
if tail -5 "$DEST"/logs/hub-*.log 2>/dev/null | grep -q "hub started"; then
  echo "✅ Hub started and will start again at login."
else
  echo "⚠️ No start-up line in the log yet:"; tail -20 "$DEST/logs/launchd.err.log" 2>/dev/null
fi
echo "Tip: in Keychain Access, turn off 'Lock after N minutes' / 'Lock when sleeping' for the login keychain, or the hub may lose the Claude login while the screen is locked."
