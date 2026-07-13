#!/usr/bin/env bash
# =============================================================================
# setup-pi.sh — one-time bootstrap for festival_recap on the Raspberry Pi
#
# Run once (as the `gatekeeper` user). It is location-independent: copy just
# this file to the Pi and run it, or run it from inside an existing clone.
#
#   bash setup-pi.sh            # clones the repo from GitHub (needs Pi git access)
#   bash setup-pi.sh --local    # use files already here (e.g. copied via FileZilla)
#
# What it does:
#   1. Clones (or updates) the repo at ~/docker/festival_recap  [skipped with --local]
#   2. Creates .env from .env.example (if missing)
#   3. Creates the secret files — auto-generates jwt_secret; leaves
#      db_password EMPTY for you to fill in (mode 600)
#   4. Creates the data dir at /mnt/storage/festival_recap/data (owned by the
#      container user, uid 1000)
#   5. Prints the remaining manual steps (fill secrets, create the DB user,
#      add music tracks, add the Caddy block) and how to start with update-pi.sh
#
# It does NOT start the stack and does NOT touch Caddy or MariaDB — by design.
# =============================================================================
set -euo pipefail

LOCAL_MODE=false
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL_MODE=true ;;
    *) echo "Unknown option: $arg (use --local to skip the git clone)"; exit 1 ;;
  esac
done

REPO_URL="${FESTIVAL_RECAP_REPO_URL:-git@github.com:trukerox/recap_festival.git}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
REPO_DIR="${FESTIVAL_RECAP_DIR:-$HOME/docker/festival_recap}"
if $LOCAL_MODE; then REPO_DIR="$REPO_ROOT"; fi
DATA_DIR="/mnt/storage/festival_recap/data"
MUSIC_DIR="/mnt/storage/festival_recap/music"
CONTAINER_UID=1000   # the `node` user inside the container (see docker/Dockerfile)

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
step() { echo -e "\n${CYAN}${BOLD}▶  $*${NC}"; }
ok()   { echo -e "   ${GREEN}✔  $*${NC}"; }
warn() { echo -e "   ${YELLOW}⚠  $*${NC}"; }
info() { echo -e "      $*"; }

command -v git >/dev/null    || { echo -e "${RED}git not found${NC}"; exit 1; }
command -v docker >/dev/null || { echo -e "${RED}docker not found${NC}"; exit 1; }

echo -e "${CYAN}${BOLD}
════════════════════════════════════════════════
  festival_recap — Pi setup  $(date '+%Y-%m-%d %H:%M:%S')
════════════════════════════════════════════════${NC}"

# ── 1. Clone or update ───────────────────────────────────────────────────────
step "Repository"
if $LOCAL_MODE; then
  ok "Local mode — using files already at $REPO_DIR (no git clone)"
  if [[ ! -d "$REPO_DIR/.git" ]]; then
    warn "No .git here — deploy/update-pi.sh can't pull updates until this is a"
    warn "git clone. Copy the hidden .git folder too, or git clone later."
  fi
elif [[ -d "$REPO_DIR/.git" ]]; then
  git -C "$REPO_DIR" pull --ff-only origin main
  ok "Updated existing clone at $REPO_DIR"
else
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone "$REPO_URL" "$REPO_DIR"
  ok "Cloned to $REPO_DIR"
fi
cd "$REPO_DIR"

# ── 2. .env ──────────────────────────────────────────────────────────────────
step "Environment file"
if [[ -f .env ]]; then
  ok ".env already exists (left untouched)"
else
  cp .env.example .env
  ok "Created .env from .env.example — review FFMPEG_PRESET/RENDER_* for your Pi's CPU"
fi

# ── 3. Secrets ───────────────────────────────────────────────────────────────
step "Secrets (./secrets/*.txt, mode 600)"
mkdir -p secrets

if [[ -s secrets/jwt_secret.txt ]]; then
  ok "jwt_secret.txt present"
else
  openssl rand -hex 32 > secrets/jwt_secret.txt
  ok "Generated jwt_secret.txt"
fi

if [[ -s secrets/db_password.txt ]]; then
  ok "db_password.txt present"
else
  : > secrets/db_password.txt
  warn "db_password.txt created EMPTY — you must fill it in"
fi
chmod 600 secrets/*.txt
ok "Permissions set to 600"

# ── 4. Data directory ────────────────────────────────────────────────────────
step "Data directory ($DATA_DIR)"
if [[ -d "$DATA_DIR" ]]; then
  ok "Already exists"
else
  sudo mkdir -p "$DATA_DIR"/uploads "$DATA_DIR"/renders "$DATA_DIR"/tmp
  sudo chown -R "$CONTAINER_UID:$CONTAINER_UID" /mnt/storage/festival_recap
  ok "Created and chowned to uid $CONTAINER_UID (container user)"
fi

# ── 4b. Music directory ──────────────────────────────────────────────────────
# Lives under /mnt/storage (same as the data dir above), NOT in the git
# checkout — bind-mounted read-write in docker-compose.yml so the "Music" tab
# can download tracks into it directly. Bootstrapped once from the repo's
# music/library.json template; that template file is never touched again
# after this — the live copy on the Pi is the one that grows over time.
step "Music directory ($MUSIC_DIR)"
if [[ -d "$MUSIC_DIR" ]]; then
  ok "Already exists"
else
  sudo mkdir -p "$MUSIC_DIR"
  sudo chown -R "$CONTAINER_UID:$CONTAINER_UID" "$MUSIC_DIR"
  ok "Created and chowned to uid $CONTAINER_UID (container user)"
fi
if [[ -s "$MUSIC_DIR/library.json" ]]; then
  ok "library.json already present — left untouched"
else
  sudo cp "$REPO_DIR/music/library.json" "$MUSIC_DIR/library.json"
  sudo chown "$CONTAINER_UID:$CONTAINER_UID" "$MUSIC_DIR/library.json"
  ok "Bootstrapped library.json from the repo template"
fi

# ── 5. Next steps ────────────────────────────────────────────────────────────
echo -e "\n${CYAN}${BOLD}════════════════════════════════════════════════${NC}"
echo -e "  ${BOLD}Setup complete. Finish these manual steps:${NC}"
echo -e "${CYAN}${BOLD}════════════════════════════════════════════════${NC}"

echo -e "\n${BOLD}1) Fill the DB password secret:${NC}"
info "nano $REPO_DIR/secrets/db_password.txt"

echo -e "\n${BOLD}2) Create the MariaDB database + user${NC} (must match db_password.txt):"
info "PW=\$(cat $REPO_DIR/secrets/db_password.txt)"
info "docker exec -i mariadb mariadb -uroot -p -e \\"
info "  \"CREATE DATABASE IF NOT EXISTS festival_recap CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
info "   CREATE USER IF NOT EXISTS 'festival_recap'@'%' IDENTIFIED BY '\$PW';"
info "   GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,INDEX,REFERENCES ON festival_recap.* TO 'festival_recap'@'%';"
info "   FLUSH PRIVILEGES;\""
info "(reference SQL: $REPO_DIR/scripts/sql/000_create_db_user.sql)"

echo -e "\n${BOLD}3) Add royalty-free music${NC} — easiest is the web UI's Music tab (paste"
info "a pixabay.com/music/... link, it downloads the track itself). For the"
info "manual/bulk path instead, edit $MUSIC_DIR/library.json directly on the"
info "Pi (NOT the repo's music/library.json — that's only the bootstrap"
info "template), then: docker compose exec -T festival_recap node scripts/seed-music.js"
info "(see music/README.md for both paths)"

echo -e "\n${BOLD}4) Add the Caddy site block${NC} (you wire Caddy yourself):"
info "Append the block in $REPO_DIR/caddy/festival_recap.caddy to your Pi Caddyfile,"
info "then: docker exec caddy-prod caddy reload --config /etc/caddy/Caddyfile"

echo -e "\n${BOLD}5) Build + start the stack:${NC}"
info "bash $REPO_DIR/deploy/update-pi.sh"

echo -e "\n${BOLD}6) (optional) Schedule daily retention cleanup:${NC}"
info "bash $REPO_DIR/deploy/update-pi.sh --install-cron"
echo ""
