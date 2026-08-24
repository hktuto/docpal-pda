#!/usr/bin/env bash
# Interactive production deploy for the warehouse-prod stack.
#
#   1. Prompts for PRODUCTION_URL and DOCPAL_URL (Enter keeps the existing
#      .env value). Non-interactive: set both in the environment to skip the
#      prompts, e.g. PRODUCTION_URL=https://host DOCPAL_URL= ./scripts/deploy-prod.sh
#   2. Preserves POSTGRES_PASSWORD / AUTH_SECRET from an existing .env, or
#      generates random ones on first run.
#   3. Writes the gitignored .env (chmod 600).
#   4. Runs docker compose -f docker-compose.prod.yml up -d --build — the
#      one-shot `apk` service builds the signed release APK and publishes it
#      to apps/backend/public/apk before the backend starts.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

ENV_FILE=.env

# Read a key from the existing .env (empty when missing).
env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

# Prompt for a value, keeping the current one on empty input. Skipped when the
# variable is already set in the environment (non-interactive use).
ask() { # $1 var name, $2 prompt, $3 current value, $4 "required"|"optional"
  local name="$1" prompt="$2" current="$3" required="$4"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    if [ -n "$current" ]; then
      read -r -p "$prompt [$current]: " value
      value=${value:-$current}
    else
      while true; do
        read -r -p "$prompt: " value
        if [ -n "$value" ] || [ "$required" = "optional" ]; then
          break
        fi
        echo "  $name is required."
      done
    fi
  fi
  printf '%s' "$value"
}

PRODUCTION_URL=$(ask PRODUCTION_URL "Production URL (scheme + host, no port, e.g. https://wms.example.com)" "$(env_get PRODUCTION_URL)" required)
DOCPAL_URL=$(ask DOCPAL_URL "DocPal API URL (empty = local auth)" "$(env_get DOCPAL_URL)" optional)

POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-$(env_get POSTGRES_PASSWORD)}
AUTH_SECRET=${AUTH_SECRET:-$(env_get AUTH_SECRET)}
[ -n "$POSTGRES_PASSWORD" ] || POSTGRES_PASSWORD=$(openssl rand -hex 24)
[ -n "$AUTH_SECRET" ] || AUTH_SECRET=$(openssl rand -hex 32)

umask 077
cat > "$ENV_FILE" <<EOF
# Written by scripts/deploy-prod.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ) — gitignored, do not commit.
POSTGRES_DB=warehouse_backend
POSTGRES_USER=warehouse
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
AUTH_SECRET=$AUTH_SECRET
PRODUCTION_URL=$PRODUCTION_URL
DOCPAL_URL=$DOCPAL_URL
EOF
chmod 600 "$ENV_FILE"
echo "Wrote $ENV_FILE (mode 600)."

docker compose -f docker-compose.prod.yml up -d --build

WEB_URL=$PRODUCTION_URL
case "$WEB_URL" in http://*|https://*) ;; *) WEB_URL="https://$WEB_URL" ;; esac
echo
echo "Deploy complete."
echo "  Web PDA:      $WEB_URL:3000"
echo "  Admin console: $WEB_URL (port 8080)"
echo "  Backend API:  $WEB_URL:9002"
echo "  APK download: admin console → Settings → APK download"
