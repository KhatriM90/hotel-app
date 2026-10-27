#!/usr/bin/env bash
# One-time preparation of a fresh EC2 instance (t4g.large, ARM64) for the YeaStay dev and test stacks.
# Installs Docker Engine with the Compose and Buildx plugins, adds swap for image builds,
# and lets the login user run docker. Safe to re-run.
#
#   sudo bash deploy/scripts/bootstrap-ec2.sh
#
# Supports Ubuntu 22.04/24.04 and Amazon Linux 2023.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

LOGIN_USER="${SUDO_USER:-}"
SWAP_SIZE="${SWAP_SIZE:-4G}"
# Pinned plugin versions for Amazon Linux, whose repos ship Docker without Compose/Buildx.
COMPOSE_VERSION="${COMPOSE_VERSION:-v2.39.4}"
BUILDX_VERSION="${BUILDX_VERSION:-v0.29.1}"

. /etc/os-release

install_ubuntu() {
  apt-get update -y
  apt-get install -y ca-certificates curl git gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_amazon_linux() {
  dnf install -y docker git
  local arch plugins=/usr/local/lib/docker/cli-plugins
  case "$(uname -m)" in
    aarch64) arch=arm64 ;;
    x86_64) arch=amd64 ;;
    *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  mkdir -p "$plugins"
  if ! docker compose version >/dev/null 2>&1; then
    curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-$(uname -m)" \
      -o "$plugins/docker-compose"
    chmod +x "$plugins/docker-compose"
  fi
  if ! docker buildx version >/dev/null 2>&1; then
    curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-${arch}" \
      -o "$plugins/docker-buildx"
    chmod +x "$plugins/docker-buildx"
  fi
}

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1; then
  echo "Docker, Compose and Buildx already installed."
else
  case "$ID" in
    ubuntu) install_ubuntu ;;
    amzn) install_amazon_linux ;;
    *) echo "Unsupported OS: $PRETTY_NAME (use Ubuntu 22.04/24.04 or Amazon Linux 2023)" >&2; exit 1 ;;
  esac
fi

systemctl enable --now docker

# Keep container logs from filling the disk.
if [[ ! -f /etc/docker/daemon.json ]]; then
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
JSON
  systemctl restart docker
fi

# Two stacks building TypeScript at once can exceed 8 GB; swap keeps the build from being OOM-killed.
if ! swapon --show | grep -q /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l "$SWAP_SIZE" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [[ -n "$LOGIN_USER" && "$LOGIN_USER" != root ]]; then
  usermod -aG docker "$LOGIN_USER"
  echo "Added $LOGIN_USER to the docker group. Log out and back in for it to take effect."
fi

docker version --format 'Docker {{.Server.Version}}'
docker compose version
docker buildx version
echo "Bootstrap complete. Next: clone the repo and run deploy/scripts/deploy.sh (see docs/deploy-ec2.md)."
