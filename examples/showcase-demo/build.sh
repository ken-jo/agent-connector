#!/usr/bin/env bash
# examples/showcase-demo/build.sh
#
# Regenerates the agent-connector showcase demo (demo.gif + demo.mp4) with vhs.
#
# It is PORTABLE: the repo root, node, and a throwaway sandbox are all resolved
# at runtime — no machine-specific paths. Every command runs against SEEDED
# sandbox HOMEs under a mktemp dir, so it NEVER touches your real ~/.claude,
# ~/.codex, ~/.cursor, etc.
#
# Three scenes (each behind a colored bar) + a number-free brand closer:
#   ① MCP DEVELOPER        — define once, then ship it as your OWN branded CLI
#                            (`acme-db install --dry-run` → the ACME-DB banner)
#   ② THE MCP's USERS      — install via each host's OWN native marketplace
#                            (live: claude / copilot / codex / agy)
#   ③ agent-connector USER — one command drives EVERY CLI you have
#                            (`agent-connector install` / `uninstall --purge`)
#
# Prereqs:
#   - vhs + ttyd + ffmpeg          (brew install vhs ffmpeg)
#   - a BUILT repo                 (npm run build → dist/cli.js + dist/cli/sdk.js)
#   - for scene ②, the agent CLIs you want shown live: claude, copilot, codex, agy
#     (any that are missing are skipped, with a note — the demo still renders)
#
# Usage:
#   ./build.sh                                   # build against THIS checkout
#   REPO_ROOT=/path/to/agent-connector ./build.sh  # build against another checkout
set -euo pipefail

# ── resolve repo, node, output dir ──────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$HERE/../.." && pwd)}"
OUT_DIR="$HERE"
NODE="$(command -v node)"

CLI="$REPO_ROOT/dist/cli.js"
SDK="$REPO_ROOT/dist/cli/sdk.js"
CONN="$REPO_ROOT/examples/acme-db/agent-connector.config.mjs"

for f in "$CLI" "$SDK" "$CONN"; do
  [ -f "$f" ] || { echo "ERROR: missing $f — run 'npm run build' in $REPO_ROOT first." >&2; exit 1; }
done
for t in vhs ffmpeg; do
  command -v "$t" >/dev/null || { echo "ERROR: '$t' not on PATH (brew install vhs ffmpeg)." >&2; exit 1; }
done

# ── throwaway build/sandbox dir (auto-removed) ──────────────────────────────
# Canonicalize via `pwd -P`: on macOS $TMPDIR lives under /var/folders, and /var
# is a symlink to /private/var — the CLI refuses to emit through a symlinked
# path, so we resolve to the physical path first (a no-op on Linux).
BUILD_DIR="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/ac-showcase.XXXXXX")" && pwd -P)"
trap 'rm -rf "$BUILD_DIR"' EXIT
echo "repo:   $REPO_ROOT"
echo "node:   $NODE"
echo "build:  $BUILD_DIR"
echo "output: $OUT_DIR/demo.gif (+ .mp4)"

# ── seeded sandbox HOMEs (never the real config) ────────────────────────────
ACHOME="$BUILD_DIR/home-dev"          # scene ① author sandbox (4 seeded hosts)
HCLAUDE="$BUILD_DIR/home-claude"
HCOPILOT="$BUILD_DIR/home-copilot"
HCODEX="$BUILD_DIR/home-codex"
HAGY="$BUILD_DIR/home-agy"
HBULK="$BUILD_DIR/home-bulk"          # scene ③ fleet HOME (4 seeded hosts)
mkdir -p \
  "$ACHOME/.claude" "$ACHOME/.codex" "$ACHOME/.cursor" "$ACHOME/.gemini" \
  "$HCLAUDE/.claude" "$HCOPILOT/.copilot" "$HCODEX/.codex" "$HAGY/.config" \
  "$HBULK/.claude" "$HBULK/.codex" "$HBULK/.cursor" "$HBULK/.gemini"

# ── package the native bundles each scene-② install consumes ────────────────
# Each bundle's root dir is literally named `acme-db` so the on-screen command
# reads cleanly as `./acme-db`. copilot reuses the claude-plugin bundle.
STORE_CLAUDE="$BUILD_DIR/store-claude"
STORE_CODEX="$BUILD_DIR/store-codex"
STORE_AGY="$BUILD_DIR/store-agy"
pkg() { # <format> <store-dir>
  mkdir -p "$2"
  HOME="$ACHOME" ACME_DB_DSN=demo "$NODE" "$CLI" package \
    --connector "$CONN" --format "$1" --out "$2/acme-db" >/dev/null
  echo "packaged $1 -> $2/acme-db"
}
pkg claude-plugin "$STORE_CLAUDE"
pkg codex-plugin  "$STORE_CODEX"
pkg agy-plugin    "$STORE_AGY"

# ── branded SDK CLI wrapper (scene ① shows the ACME-DB banner) ──────────────
# A connector author can ship their connector as their OWN branded CLI via the
# public SDK (see examples/branded-cli/). The brand name drives the banner, so
# `acme-db install` renders the big "ACME-DB" banner + the same
# `powered by @ken-jo/agent-connector` footer. We import the SDK from the built
# dist by absolute path because this wrapper lives under the throwaway dir.
cat > "$BUILD_DIR/acme-db-cli.mjs" <<EOF
import { createConnectorCli } from "$SDK";
createConnectorCli({ name: "acme-db", connector: "$CONN" })
  .run()
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((err) => { process.stderr.write(\`acme-db: fatal: \${err?.stack ?? err}\n\`); process.exitCode = 1; });
EOF

# ── scene bars + brand closer: REAL ANSI bytes ──────────────────────────────
# vhs `Type "..."` doubles backslashes, so escapes can't live in the tape; we
# printf them here (real ESC/SGR bytes + UTF-8 ①②③ · — glyphs) and the tape
# just `cat`s these files DURING a Hide block, so the cat command never shows.
printf '\033[1;30;46m  \xe2\x91\xa0 MCP DEVELOPER  \xc2\xb7  build your MCP once: server + hooks  \033[0m\n' > "$BUILD_DIR/bar1.txt"
printf '\033[1;30;42m  \xe2\x91\xa1 THE MCP USERS  \xc2\xb7  install with their OWN CLI \xe2\x80\x94 no agent-connector needed  \033[0m\n' > "$BUILD_DIR/bar2.txt"
printf '\033[1;30;43m  \xe2\x91\xa2 agent-connector USER  \xc2\xb7  ONE command drives EVERY CLI you have  \033[0m\n' > "$BUILD_DIR/bar3.txt"
{
  printf '\n'
  printf '  \033[1;36magent-connector\033[0m   \033[2;37m\xe2\x80\x94   write your MCP server once \xc2\xb7 ship to every agent CLI\033[0m\n'
  printf '  \033[2;37mnpm i -g @ken-jo/agent-connector   \xc2\xb7   github.com/ken-jo/agent-connector\033[0m\n'
  printf '\n'
} > "$BUILD_DIR/closer.txt"

# ── generate the vhs tape (absolute paths baked in; vhs can't interpolate) ──
TAPE="$BUILD_DIR/demo.tape"
cat > "$TAPE" <<EOF
Output "$OUT_DIR/demo.gif"
Output "$OUT_DIR/demo.mp4"

Set Shell "zsh"
Set FontSize 14
Set Width 1600
Set Height 860
Set Theme "Dracula"
Set Padding 22
Set TypingSpeed 6ms

Hide
Type "setopt interactive_comments"
Enter
Type "preexec() { echo; }"
Enter
Type "export ACME_DB_DSN=demo TERM=xterm-256color COLORTERM=truecolor"
Enter
Type "alias agent-connector='$NODE $CLI'"
Enter
Type "alias acme-db='$NODE $BUILD_DIR/acme-db-cli.mjs'"
Enter
Type "PROMPT='%F{green}❯ %f'"
Enter
Type "export HOME=$ACHOME"
Enter
Type "cd $REPO_ROOT/examples/acme-db"
Enter
Type "clear"
Enter
Sleep 600ms
Show

# ═══ (1) MCP DEVELOPER ═════════════════════════════════════════════════════
Hide
Type "clear; cat $BUILD_DIR/bar1.txt; echo"
Enter
Show
Sleep 1200ms

Type "# your whole connector — server + hooks — is just a few lines:"
Enter
Sleep 500ms
Type "sed -n '32,50p' agent-connector.config.mjs"
Enter
Sleep 2200ms
Type "# ^ the ENTIRE connector: 80 lines. That's all you write."
Enter
Sleep 1500ms

Type "# define once — then ship it as your OWN branded CLI:"
Enter
Sleep 500ms
Type "acme-db install --dry-run"
Enter
Sleep 3500ms
Type "# the SAME definition also carries: commands, skills, subagents, statusline, memory, actions"
Enter
Sleep 2000ms

Hide
Type "clear"
Enter
Show
EOF

# ── scene ② installs — only for CLIs present on PATH (skip the rest) ────────
have() { command -v "$1" >/dev/null; }
SKIPPED=()
{
  echo ""
  echo "# ═══ (2) THE MCP's USERS ═══════════════════════════════════════════════════"
} >> "$TAPE"

emit2() { # <home> <cwd> <pre-sleep ms> <command>
  cat >> "$TAPE" <<EOF
Hide
Type "clear; export HOME=$1; cd $2; cat $BUILD_DIR/bar2.txt; echo"
Enter
Show
Sleep ${3}ms
Type "$4"
Enter
Sleep 2800ms
EOF
}
if have claude; then
  emit2 "$HCLAUDE" "$STORE_CLAUDE" 1200 "claude plugin marketplace add ./acme-db && claude plugin install acme-db@agent-connector"
else SKIPPED+=("claude"); fi
if have copilot; then
  emit2 "$HCOPILOT" "$STORE_CLAUDE" 300 "copilot plugin marketplace add acme-db/ && copilot plugin install acme-db@agent-connector"
else SKIPPED+=("copilot"); fi
if have codex; then
  emit2 "$HCODEX" "$STORE_CODEX" 300 "codex plugin marketplace add ./acme-db && codex plugin add acme-db@agent-connector"
else SKIPPED+=("codex"); fi
if have agy; then
  emit2 "$HAGY" "$STORE_AGY/acme-db" 300 "agy plugin install ./acme-db"
else SKIPPED+=("agy"); fi
[ ${#SKIPPED[@]} -gt 0 ] && echo "NOTE: scene-② CLIs not on PATH, skipped: ${SKIPPED[*]}"

# ── scene ③ + brand closer ──────────────────────────────────────────────────
cat >> "$TAPE" <<EOF
Hide
Type "clear"
Enter
Show

# ═══ (3) agent-connector USER ══════════════════════════════════════════════
Hide
Type "export HOME=$HBULK; cd $REPO_ROOT/examples"
Enter
Type "clear; cat $BUILD_DIR/bar3.txt; echo"
Enter
Show
Sleep 1200ms

Type "# grab a connector project, then deploy it to ALL your CLIs at once:"
Enter
Sleep 400ms
Type "cd acme-db                      # a connector project (agent-connector.config.mjs)"
Enter
Sleep 300ms
Type "agent-connector install         # auto-discovers the config -> every CLI at once"
Enter
Sleep 3800ms

Type "agent-connector uninstall --purge"
Enter
Sleep 3800ms

Hide
Type "clear"
Enter
Show

# ═══ BRAND CLOSER (number-free) ════════════════════════════════════════════
Hide
Type "clear; cat $BUILD_DIR/closer.txt"
Enter
Show
Sleep 3500ms
EOF

# ── render (vhs runs the live installs for real; ttyd can flake → retry once) ─
echo "rendering with vhs (~1 min; scene-② installs run live)…"
vhs "$TAPE" || { echo "vhs failed once; retrying…" >&2; vhs "$TAPE"; }

echo "done:"
ls -lh "$OUT_DIR/demo.gif" "$OUT_DIR/demo.mp4" 2>/dev/null || true
