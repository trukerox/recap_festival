#!/usr/bin/env bash
# =============================================================================
# update-pi.sh — pull + rebuild + restart festival_recap on the Raspberry Pi
#
#   bash ~/docker/festival_recap/deploy/update-pi.sh                 # update & restart
#   bash ~/docker/festival_recap/deploy/update-pi.sh --force-rebuild # rebuild even if unchanged
#   bash ~/docker/festival_recap/deploy/update-pi.sh --install-cron  # (re)install daily cleanup cron
#
# What it does:
#   1. Pulls the repo from GitHub
#   2. Self-updates: if this script itself changed in the pull, re-execs the
#      new version automatically (so you always run the latest deploy logic)
#   3. Rebuilds + restarts the Node container if app files changed (or --force)
#   4. Migrations run automatically on container start (src/server.js)
#
# It does NOT touch Caddy (you wire that yourself) and does NOT touch MariaDB.
# After Caddy changes, reload Caddy manually — this script reminds you.
# =============================================================================
set -euo pipefail

REPO_DIR="${FESTIVAL_RECAP_DIR:-$HOME/docker/festival_recap}"
DATA_DIR="/mnt/storage/festival_recap/data"
CRON_HOUR="${FESTIVAL_RECAP_CRON_HOUR:-4}"   # 04:00 daily retention cleanup

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
step() { echo -e "\n${CYAN}${BOLD}▶  $*${NC}"; }
ok()   { echo -e "   ${GREEN}✔  $*${NC}"; }
warn() { echo -e "   ${YELLOW}⚠  $*${NC}"; }
info() { echo -e "      $*"; }

FORCE_REBUILD=false
INSTALL_CRON=false
for arg in "$@"; do
  case "$arg" in
    --force-rebuild) FORCE_REBUILD=true ;;
    --install-cron)  INSTALL_CRON=true ;;
    *) echo -e "${RED}Unknown option: $arg${NC}"; exit 1 ;;
  esac
done

[[ -d "$REPO_DIR/.git" ]] || { echo -e "${RED}Not a git repo: $REPO_DIR — run setup-pi.sh first${NC}"; exit 1; }
cd "$REPO_DIR"

# ── Cron-only mode: install the schedule and exit ────────────────────────────
if [[ "$INSTALL_CRON" == true ]]; then
  step "Installing daily retention cleanup (${CRON_HOUR}:00)"
  mkdir -p "$DATA_DIR/logs" 2>/dev/null || sudo mkdir -p "$DATA_DIR/logs"
  LINE="0 ${CRON_HOUR} * * * cd ${REPO_DIR} && docker compose exec -T festival_recap node scripts/cleanup.js >> ${DATA_DIR}/logs/cleanup.log 2>&1 # festival_recap"
  ( crontab -l 2>/dev/null | grep -v '# festival_recap' ; echo "$LINE" ) | crontab -
  ok "Cron installed:"
  info "$LINE"
  exit 0
fi

# ── 1. Pull + self-update ────────────────────────────────────────────────────
step "Pulling latest from GitHub"
BEFORE="${FESTIVALRECAP_BEFORE_SHA:-$(git rev-parse HEAD)}"
git pull --ff-only origin main
AFTER=$(git rev-parse HEAD)

if [[ "$BEFORE" == "$AFTER" ]]; then
  ok "Already up to date (${AFTER:0:7})"
else
  ok "Updated ${BEFORE:0:7} → ${AFTER:0:7}"
  if [[ -z "${FESTIVALRECAP_REEXEC:-}" ]]; then
    warn "Re-executing the updated deploy script…"
    export FESTIVALRECAP_REEXEC=1
    export FESTIVALRECAP_BEFORE_SHA="$BEFORE"
    exec bash "$REPO_DIR/deploy/update-pi.sh" "$@"
  fi
fi

# ── 2. Decide whether the app needs rebuilding ──────────────────────────────
APP_CHANGED=false
if [[ "$BEFORE" != "$AFTER" ]]; then
  if git diff --name-only "$BEFORE" "$AFTER" | grep -qvE '^(deploy/|caddy/|README|ARCHITECTURE|\.gitignore|\.gitattributes)'; then
    APP_CHANGED=true
  fi
  if git diff --name-only "$BEFORE" "$AFTER" | grep -q '^caddy/'; then
    warn "caddy/festival_recap.caddy changed — re-apply it to your Pi Caddyfile and reload Caddy."
  fi
fi

# ── 3. Rebuild + restart ─────────────────────────────────────────────────────
if [[ "$APP_CHANGED" == true || "$FORCE_REBUILD" == true ]]; then
  step "Rebuilding + restarting the festival_recap container"
  docker compose up -d --build
  sleep 2
  docker compose ps
  ok "Container rebuilt and restarted (migrations ran on startup)"
else
  ok "No app changes — container restart skipped (use --force-rebuild to override)"
fi

echo -e "\n${CYAN}${BOLD}════════════════════════════════════════════════${NC}"
echo -e "  ${GREEN}✔  Done${NC}"
echo -e "${CYAN}${BOLD}════════════════════════════════════════════════${NC}\n"
