#!/usr/bin/env bash
# Deploy (or redeploy) the YeaStay edge proxy and the dev/test stacks on the EC2 host.
# Run from anywhere inside the repo checkout on the instance:
#
#   deploy/scripts/deploy.sh            # edge + dev + test
#   deploy/scripts/deploy.sh dev        # edge + dev only (likewise: test, edge)
#   DEPLOY_REF=main deploy/scripts/deploy.sh dev   # fetch and check out a ref first
#
# First run creates any missing env file under deploy/env/ from its .example, filling every
# "change-me" with a random secret. Existing env files are never overwritten.
# For edge.env it needs ACME_EMAIL; DEV_DOMAIN/TEST_DOMAIN default to <stack>.<public-ip>.sslip.io
# so HTTPS works before real DNS names exist.
set -euo pipefail

TARGET="${1:-all}"
case "$TARGET" in
  all) STACKS=(dev test) ;;
  dev|test) STACKS=("$TARGET") ;;
  edge) STACKS=() ;;
  *) echo "Usage: $0 [all|dev|test|edge]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
ENV_DIR=deploy/env

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not installed (run deploy/scripts/bootstrap-ec2.sh first)"
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing (run deploy/scripts/bootstrap-ec2.sh first)"
docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon (are you in the docker group? log out and back in)"

env_get() { # env_get <file> <KEY>
  sed -n "s/^$2=//p" "$1" | tail -n1
}

public_ip() {
  local token ip
  token=$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)
  if [[ -n "$token" ]]; then
    ip=$(curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
  fi
  [[ -n "${ip:-}" ]] || ip=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not determine the public IP; set DEV_DOMAIN and TEST_DOMAIN"
  echo "$ip"
}

init_stack_env() { # init_stack_env dev|test
  local file="$ENV_DIR/$1.env"
  [[ -f "$file" ]] && return 0
  log "Creating $file with fresh random secrets"
  local line key out=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^([A-Z_]+)=change-me ]]; then
      key="${BASH_REMATCH[1]}"
      if [[ "$key" == SEED_PASSWORD ]]; then
        line="$key=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
      else
        line="$key=$(openssl rand -hex 32)"
      fi
    fi
    out+="$line"$'\n'
  done < "$file.example"
  (umask 077 && printf '%s' "$out" > "$file")
}

init_edge_env() {
  local file="$ENV_DIR/edge.env"
  [[ -f "$file" ]] && return 0
  [[ -n "${ACME_EMAIL:-}" ]] || die "first run needs ACME_EMAIL (Let's Encrypt contact), e.g. ACME_EMAIL=you@example.com $0"
  local ip
  if [[ -z "${DEV_DOMAIN:-}" || -z "${TEST_DOMAIN:-}" ]]; then
    ip=$(public_ip)
    DEV_DOMAIN="${DEV_DOMAIN:-dev.${ip//./-}.sslip.io}"
    TEST_DOMAIN="${TEST_DOMAIN:-test.${ip//./-}.sslip.io}"
  fi
  log "Creating $file (dev: $DEV_DOMAIN, test: $TEST_DOMAIN)"
  (umask 077 && printf 'ACME_EMAIL=%s\nDEV_DOMAIN=%s\nTEST_DOMAIN=%s\n' "$ACME_EMAIL" "$DEV_DOMAIN" "$TEST_DOMAIN" > "$file")
}

if [[ -n "${DEPLOY_REF:-}" ]]; then
  log "Checking out $DEPLOY_REF"
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "working tree has local changes; commit or stash them first"
  git fetch --prune origin
  if git show-ref --verify --quiet "refs/remotes/origin/$DEPLOY_REF"; then
    git checkout -B "$DEPLOY_REF" "origin/$DEPLOY_REF"
  else
    git checkout --detach "$DEPLOY_REF"
  fi
fi
log "Deploying $(git rev-parse --short HEAD 2>/dev/null || echo 'working tree') ($TARGET)"

init_edge_env
for s in "${STACKS[@]}"; do init_stack_env "$s"; done

edge() { docker compose -p hotel-edge --env-file "$ENV_DIR/edge.env" -f deploy/compose.edge.yaml "$@"; }
stack() { # stack dev|test <compose args...>
  local s="$1"; shift
  docker compose -p "hotel-$s" --env-file "$ENV_DIR/$s.env" -f deploy/compose.stack.yaml "$@"
}

log "Starting edge Caddy"
edge up -d --remove-orphans
# Pick up Caddyfile edits without dropping connections.
edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || edge restart caddy

for s in "${STACKS[@]}"; do
  log "Building hotel-$s images"
  stack "$s" build
  log "Starting hotel-$s (migrations run before the API starts)"
  stack "$s" up -d --remove-orphans
  log "Seeding demo users in hotel-$s (idempotent; existing passwords are kept)"
  stack "$s" --profile seed run --rm seed

  printf 'Waiting for hotel-%s API health' "$s"
  healthy=""
  for _ in $(seq 1 60); do
    if stack "$s" exec -T api wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then healthy=1; break; fi
    printf '.'; sleep 2
  done
  echo
  [[ -n "$healthy" ]] || { stack "$s" logs --tail 80 api migrate; die "hotel-$s API did not become healthy"; }
done

DEV_DOMAIN=$(env_get "$ENV_DIR/edge.env" DEV_DOMAIN)
TEST_DOMAIN=$(env_get "$ENV_DIR/edge.env" TEST_DOMAIN)

log "Checking HTTPS through the edge (the first certificate can take a minute)"
for s in "${STACKS[@]}"; do
  domain=$([[ "$s" == dev ]] && echo "$DEV_DOMAIN" || echo "$TEST_DOMAIN")
  ok=""
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 --resolve "$domain:443:127.0.0.1" "https://$domain/api/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 4
  done
  if [[ -n "$ok" ]]; then
    echo "  https://$domain  OK"
  else
    echo "  https://$domain  not answering with a valid certificate yet."
    echo "    Check that DNS for $domain points at this instance and ports 80/443 are open, then: docker logs hotel-edge-caddy-1"
  fi
done

log "Done"
for s in "${STACKS[@]}"; do
  domain=$([[ "$s" == dev ]] && echo "$DEV_DOMAIN" || echo "$TEST_DOMAIN")
  cat <<EOF
hotel-$s
  Back office  https://$domain/
  Waiter PWA   https://$domain/pwa/
  API health   https://$domain/api/health
  Sign in as admin, owner, group.accounts, k1.manager, k1.reception, k1.waiter, sw.reception or km.reception
  Password     $(env_get "$ENV_DIR/$s.env" SEED_PASSWORD)   (stored in $ENV_DIR/$s.env)
EOF
done
