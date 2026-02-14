#!/usr/bin/env bash
# ============================================================================
# VALENTINE RF - Deployment Script
#
# Installs and configures the VALENTINE RF Signal Intelligence Platform
# with all features, supporting Docker and bare-metal deployments.
#
# Usage:
#   bash deploy.sh                          # Interactive guided deployment
#   bash deploy.sh --docker                 # Docker deployment (recommended)
#   bash deploy.sh --bare-metal             # Bare-metal (native) deployment
#   bash deploy.sh --docker --non-interactive  # Headless Docker deploy
#   bash deploy.sh --uninstall              # Remove deployment
#
# Options:
#   --docker            Deploy using Docker Compose (recommended)
#   --bare-metal        Deploy directly on host with systemd service
#   --with-history      Enable ADS-B Postgres history (Docker only)
#   --with-nginx        Install and configure nginx reverse proxy
#   --with-caddy        Install and configure Caddy reverse proxy
#   --with-wifi         Enable host networking for WiFi monitor mode
#   --non-interactive   Skip all prompts, use defaults
#   --uninstall         Remove VALENTINE RF deployment
#   --hostname NAME     Set hostname for TLS/proxy (default: valentine.local)
#   --port PORT         Set web UI port (default: 5050)
#   --help              Show this help
# ============================================================================

# ---- Force bash ----
if [ -z "${BASH_VERSION:-}" ]; then
  echo "[x] This script must be run with bash."
  exec bash "$0" "$@"
fi

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ----------------------------
# Colors and output
# ----------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${BLUE}[*]${NC} $*"; }
ok()      { echo -e "${GREEN}[+]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
fail()    { echo -e "${RED}[x]${NC} $*"; }
section() { echo -e "\n${CYAN}${BOLD}=== $* ===${NC}\n"; }

on_error() {
  local line="$1"
  fail "Deployment failed at line ${line}"
  exit 1
}
trap 'on_error $LINENO' ERR

# ----------------------------
# Defaults
# ----------------------------
DEPLOY_MODE=""
WITH_HISTORY=false
WITH_NGINX=false
WITH_CADDY=false
WITH_WIFI=false
NON_INTERACTIVE=false
DO_UNINSTALL=false
HOSTNAME="valentine.local"
PORT=5050
INSTALL_DIR="$SCRIPT_DIR"
DATA_DIR="${INSTALL_DIR}/data"
ENV_FILE="${INSTALL_DIR}/.env"
SERVICE_NAME="valentine-rf"

# ----------------------------
# Argument parsing
# ----------------------------
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --docker)           DEPLOY_MODE="docker" ;;
      --bare-metal)       DEPLOY_MODE="bare-metal" ;;
      --with-history)     WITH_HISTORY=true ;;
      --with-nginx)       WITH_NGINX=true ;;
      --with-caddy)       WITH_CADDY=true ;;
      --with-wifi)        WITH_WIFI=true ;;
      --non-interactive)  NON_INTERACTIVE=true ;;
      --uninstall)        DO_UNINSTALL=true ;;
      --hostname)         shift; HOSTNAME="${1:-valentine.local}" ;;
      --port)             shift; PORT="${1:-5050}" ;;
      --help|-h)
        sed -n '3,27s/^# \?//p' "$0"
        exit 0
        ;;
      *)
        fail "Unknown option: $1 (use --help for usage)"
        exit 1
        ;;
    esac
    shift
  done
}

# ----------------------------
# Helpers
# ----------------------------
cmd_exists() { command -v "$1" >/dev/null 2>&1; }

ask_yes_no() {
  local prompt="$1"
  local default="${2:-n}"
  if $NON_INTERACTIVE; then
    [[ "$default" == "y" ]]
    return
  fi
  if [[ ! -t 0 ]]; then
    [[ "$default" == "y" ]]
    return
  fi
  local response
  if [[ "$default" == "y" ]]; then
    read -r -p "$prompt [Y/n]: " response
    [[ -z "$response" || "$response" =~ ^[Yy] ]]
  else
    read -r -p "$prompt [y/N]: " response
    [[ "$response" =~ ^[Yy] ]]
  fi
}

ask_choice() {
  local prompt="$1"; shift
  local options=("$@")
  if $NON_INTERACTIVE; then
    echo "${options[0]}"
    return
  fi
  echo -e "${BLUE}${prompt}${NC}"
  local i=1
  for opt in "${options[@]}"; do
    echo "  ${i}) ${opt}"
    ((i++))
  done
  local choice
  read -r -p "Enter choice [1-${#options[@]}]: " choice
  if [[ "$choice" -ge 1 && "$choice" -le "${#options[@]}" ]] 2>/dev/null; then
    echo "${options[$((choice - 1))]}"
  else
    echo "${options[0]}"
  fi
}

need_sudo() {
  if [[ "$(id -u)" -eq 0 ]]; then
    SUDO=""
  elif cmd_exists sudo; then
    SUDO="sudo"
  else
    fail "This script requires root privileges. Run as root or install sudo."
    exit 1
  fi
}

generate_secret_key() {
  python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null \
    || openssl rand -hex 32 2>/dev/null \
    || head -c 32 /dev/urandom | xxd -p | tr -d '\n'
}

generate_password() {
  python3 -c "import secrets; print(secrets.token_urlsafe(20))" 2>/dev/null \
    || openssl rand -base64 20 2>/dev/null \
    || head -c 20 /dev/urandom | base64 | tr -d '=/+' | head -c 20
}

# ----------------------------
# Banner
# ----------------------------
show_banner() {
  echo -e "${CYAN}"
  cat << 'BANNER'
 __     ___    _     _____ _   _ _____ ___ _   _ _____   ____  _____
 \ \   / / \  | |   | ____| \ | |_   _|_ _| \ | | ____| |  _ \|  ___|
  \ \ / / _ \ | |   |  _| |  \| | | |  | ||  \| |  _|   | |_) | |_
   \ V / ___ \| |___| |___| |\  | | |  | || |\  | |___  |  _ <|  _|
    \_/_/   \_\_____|_____|_| \_| |_| |___|_| \_|_____| |_| \_\_|
BANNER
  echo -e "${NC}"
  echo "  VALENTINE RF - Signal Intelligence Platform Deployer"
  echo "  Version: $(grep -oP 'VERSION\s*=\s*"\K[^"]+' config.py 2>/dev/null || echo 'unknown')"
  echo "  =================================================="
  echo
}

# ----------------------------
# Pre-flight checks
# ----------------------------
preflight_checks() {
  section "Pre-flight Checks"

  # OS detection
  if [[ "${OSTYPE:-}" == "darwin"* ]]; then
    OS="macos"
  elif [[ -f /etc/debian_version ]]; then
    OS="debian"
  elif [[ -f /etc/redhat-release ]]; then
    OS="rhel"
  else
    OS="unknown"
  fi
  info "Operating system: ${OS}"

  # Architecture
  ARCH="$(uname -m)"
  info "Architecture: ${ARCH}"

  # Python
  if cmd_exists python3; then
    PYTHON_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
    ok "Python ${PYTHON_VER} found"
  else
    warn "Python 3 not found (required for bare-metal, optional for Docker)"
  fi

  # Docker
  if cmd_exists docker; then
    DOCKER_VER="$(docker --version 2>/dev/null | grep -oP '\d+\.\d+' | head -1 || echo 'unknown')"
    ok "Docker ${DOCKER_VER} found"
    HAS_DOCKER=true
  else
    warn "Docker not found"
    HAS_DOCKER=false
  fi

  # Docker Compose
  if docker compose version >/dev/null 2>&1; then
    ok "Docker Compose (plugin) found"
    HAS_COMPOSE=true
  elif cmd_exists docker-compose; then
    ok "docker-compose (standalone) found"
    HAS_COMPOSE=true
  else
    warn "Docker Compose not found"
    HAS_COMPOSE=false
  fi

  # Git
  if cmd_exists git; then
    ok "Git found"
  else
    warn "Git not found"
  fi

  # USB devices (SDR hardware)
  if [[ -d /dev/bus/usb ]]; then
    local usb_count
    usb_count=$(find /dev/bus/usb -type c 2>/dev/null | wc -l)
    info "USB devices available: ${usb_count}"
  else
    warn "No USB bus found (/dev/bus/usb missing)"
  fi

  echo
}

# ----------------------------
# Deployment mode selection
# ----------------------------
select_deploy_mode() {
  if [[ -n "$DEPLOY_MODE" ]]; then
    return
  fi

  section "Deployment Mode"

  if $HAS_DOCKER && $HAS_COMPOSE; then
    echo "  1) Docker (recommended) - Containerized, isolated, reproducible"
    echo "  2) Bare-metal           - Native install, requires root, compiles SDR tools"
    echo
    local choice
    if $NON_INTERACTIVE; then
      choice="1"
    else
      read -r -p "Select deployment mode [1]: " choice
    fi
    case "${choice:-1}" in
      2) DEPLOY_MODE="bare-metal" ;;
      *) DEPLOY_MODE="docker" ;;
    esac
  elif $HAS_DOCKER; then
    warn "Docker Compose not found. Install it for Docker deployment."
    DEPLOY_MODE="bare-metal"
  else
    info "Docker not available. Using bare-metal deployment."
    DEPLOY_MODE="bare-metal"
  fi

  ok "Deployment mode: ${DEPLOY_MODE}"
}

# ----------------------------
# Feature selection
# ----------------------------
select_features() {
  if $NON_INTERACTIVE; then
    return
  fi

  section "Feature Selection"

  if [[ "$DEPLOY_MODE" == "docker" ]]; then
    if ask_yes_no "Enable ADS-B history with Postgres persistence?"; then
      WITH_HISTORY=true
      ok "ADS-B history: enabled"
    fi
  fi

  if ask_yes_no "Enable WiFi monitor mode (requires host networking in Docker)?"; then
    WITH_WIFI=true
    ok "WiFi monitor mode: enabled"
  fi

  if ! $WITH_NGINX && ! $WITH_CADDY; then
    echo
    info "A reverse proxy provides TLS/HTTPS termination (recommended for production)."
    local proxy_choice
    proxy_choice=$(ask_choice "Install a reverse proxy?" "None (skip)" "nginx" "Caddy")
    case "$proxy_choice" in
      nginx) WITH_NGINX=true; ok "Reverse proxy: nginx" ;;
      Caddy) WITH_CADDY=true; ok "Reverse proxy: Caddy" ;;
      *) info "Skipping reverse proxy" ;;
    esac
  fi
}

# ----------------------------
# Generate .env file
# ----------------------------
generate_env_file() {
  section "Generating Configuration"

  local secret_key admin_password db_password

  # Preserve existing secrets if .env already exists
  if [[ -f "$ENV_FILE" ]]; then
    info "Existing .env found. Preserving secrets."
    secret_key=$(grep -oP '^VALENTINE_SECRET_KEY=\K.*' "$ENV_FILE" 2>/dev/null || true)
    admin_password=$(grep -oP '^VALENTINE_ADMIN_PASSWORD=\K.*' "$ENV_FILE" 2>/dev/null || true)
    db_password=$(grep -oP '^VALENTINE_ADSB_DB_PASSWORD=\K.*' "$ENV_FILE" 2>/dev/null || true)
  fi

  # Generate new secrets where missing
  secret_key="${secret_key:-$(generate_secret_key)}"
  admin_password="${admin_password:-$(generate_password)}"
  db_password="${db_password:-$(generate_password)}"

  cat > "$ENV_FILE" << EOF
# ============================================================================
# VALENTINE RF - Environment Configuration
# Generated by deploy.sh on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# ============================================================================

# --- Security (REQUIRED for production) ---
VALENTINE_SECRET_KEY=${secret_key}
VALENTINE_ADMIN_PASSWORD=${admin_password}

# --- Server ---
VALENTINE_HOST=0.0.0.0
VALENTINE_PORT=${PORT}
VALENTINE_DEBUG=false
VALENTINE_LOG_LEVEL=INFO

# --- Observer Location (set to your coordinates to skip GPS prompt) ---
VALENTINE_SHARED_OBSERVER_LOCATION=true
# VALENTINE_DEFAULT_LAT=0.0
# VALENTINE_DEFAULT_LON=0.0

# --- ADS-B ---
VALENTINE_ADSB_AUTO_START=false
EOF

  if $WITH_HISTORY; then
    cat >> "$ENV_FILE" << EOF

# --- ADS-B History (Postgres) ---
VALENTINE_ADSB_HISTORY_ENABLED=true
VALENTINE_ADSB_DB_HOST=adsb_db
VALENTINE_ADSB_DB_PORT=5432
VALENTINE_ADSB_DB_NAME=valentine_adsb
VALENTINE_ADSB_DB_USER=valentine
VALENTINE_ADSB_DB_PASSWORD=${db_password}

# Postgres container variables
POSTGRES_DB=valentine_adsb
POSTGRES_USER=valentine
POSTGRES_PASSWORD=${db_password}
EOF
  fi

  if $WITH_WIFI; then
    cat >> "$ENV_FILE" << EOF

# --- WiFi Monitor Mode ---
# Host networking enabled for WiFi scanning
VALENTINE_WIFI_ENABLED=true
EOF
  fi

  cat >> "$ENV_FILE" << EOF

# --- Optional ---
# VALENTINE_WEATHER_SAT_GAIN=40.0
# VALENTINE_WEATHER_SAT_MIN_ELEVATION=15.0
# VALENTINE_ALERT_WEBHOOK_URL=
# VALENTINE_ALERT_WEBHOOK_SECRET=
# PGDATA_PATH=./pgdata
EOF

  chmod 600 "$ENV_FILE"
  ok "Configuration written to .env"
  info "Admin password: ${admin_password}"
  warn "Save this password! It will not be shown again."
  echo
}

# ----------------------------
# Docker deployment
# ----------------------------
deploy_docker() {
  section "Docker Deployment"

  if ! $HAS_DOCKER || ! $HAS_COMPOSE; then
    fail "Docker and Docker Compose are required for Docker deployment."
    echo
    info "Install Docker:"
    echo "  curl -fsSL https://get.docker.com | sh"
    echo "  sudo usermod -aG docker \$USER"
    echo "  # Log out and back in, then re-run this script"
    exit 1
  fi

  # Create data directory
  mkdir -p "$DATA_DIR" "$DATA_DIR/weather_sat"
  ok "Data directory: ${DATA_DIR}"

  # Generate docker-compose override for WiFi host networking
  if $WITH_WIFI; then
    info "Creating docker-compose.override.yml for host networking..."
    cat > "${INSTALL_DIR}/docker-compose.override.yml" << 'EOF'
# Auto-generated by deploy.sh - enables WiFi monitor mode
# This file overrides settings in docker-compose.yml
services:
  valentine-rf:
    network_mode: host
  valentine-rf-history:
    network_mode: host
EOF
    ok "Host networking enabled via override"
  fi

  # Select compose profile
  local profile="basic"
  if $WITH_HISTORY; then
    profile="history"
    mkdir -p "${INSTALL_DIR}/pgdata"
  fi

  # Build and start
  info "Building Docker image (this may take 15-30 minutes on first run)..."
  docker compose --env-file "$ENV_FILE" --profile "$profile" up -d --build

  # Wait for health check
  info "Waiting for health check..."
  local retries=30
  local healthy=false
  for ((i = 1; i <= retries; i++)); do
    if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
      healthy=true
      break
    fi
    sleep 2
  done

  if $healthy; then
    ok "VALENTINE RF is running and healthy!"
  else
    warn "Health check did not pass within 60 seconds."
    warn "Check logs with: docker compose logs -f"
  fi
}

# ----------------------------
# Bare-metal deployment
# ----------------------------
deploy_bare_metal() {
  section "Bare-metal Deployment"

  need_sudo

  # Run the setup.sh script for SDR tool installation
  if [[ -f "${INSTALL_DIR}/setup.sh" ]]; then
    info "Running SDR tool installer (setup.sh)..."
    if $NON_INTERACTIVE; then
      bash "${INSTALL_DIR}/setup.sh" --non-interactive
    else
      bash "${INSTALL_DIR}/setup.sh"
    fi
    ok "SDR tools installation complete"
  else
    fail "setup.sh not found in ${INSTALL_DIR}"
    exit 1
  fi

  # Ensure venv exists and deps are installed
  if [[ ! -d "${INSTALL_DIR}/venv" ]]; then
    fail "Python virtual environment not created by setup.sh"
    exit 1
  fi

  # Create data directories
  mkdir -p "$DATA_DIR" "$DATA_DIR/weather_sat" "${INSTALL_DIR}/instance"
  ok "Data directories created"

  # Download leaflet-heat plugin if missing
  if [[ ! -f "${INSTALL_DIR}/static/vendor/leaflet-heat/leaflet-heat.js" ]]; then
    info "Downloading leaflet-heat plugin..."
    mkdir -p "${INSTALL_DIR}/static/vendor/leaflet-heat"
    curl -sL "https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js" \
      -o "${INSTALL_DIR}/static/vendor/leaflet-heat/leaflet-heat.js" 2>/dev/null || true
  fi

  # Create systemd service
  install_systemd_service

  # Start the service
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE_NAME"
  $SUDO systemctl start "$SERVICE_NAME"

  # Wait for health check
  info "Waiting for health check..."
  local retries=20
  local healthy=false
  for ((i = 1; i <= retries; i++)); do
    if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
      healthy=true
      break
    fi
    sleep 3
  done

  if $healthy; then
    ok "VALENTINE RF is running and healthy!"
  else
    warn "Health check did not pass within 60 seconds."
    warn "Check logs with: sudo journalctl -u ${SERVICE_NAME} -f"
  fi
}

# ----------------------------
# Systemd service
# ----------------------------
install_systemd_service() {
  section "Installing Systemd Service"

  local service_file="/etc/systemd/system/${SERVICE_NAME}.service"

  $SUDO tee "$service_file" > /dev/null << EOF
[Unit]
Description=VALENTINE RF Signal Intelligence Platform
After=network.target bluetooth.target
Wants=bluetooth.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${INSTALL_DIR}/venv/bin/python ${INSTALL_DIR}/valentine.py
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=valentine-rf

# Security hardening
NoNewPrivileges=false
ProtectSystem=false
ProtectHome=false
# SDR and network tools need broad access (root for airmon-ng, rtl_fm, etc.)
# If WiFi monitor mode is not needed, consider running as a dedicated user
# with only SYS_RAWIO and NET_RAW capabilities.
AmbientCapabilities=CAP_SYS_RAWIO CAP_NET_ADMIN CAP_NET_RAW

[Install]
WantedBy=multi-user.target
EOF

  ok "Systemd service installed: ${service_file}"
  info "Manage with:"
  echo "  sudo systemctl start ${SERVICE_NAME}"
  echo "  sudo systemctl stop ${SERVICE_NAME}"
  echo "  sudo systemctl status ${SERVICE_NAME}"
  echo "  sudo journalctl -u ${SERVICE_NAME} -f"
}

# ----------------------------
# Reverse proxy: nginx
# ----------------------------
install_nginx_proxy() {
  section "Configuring nginx Reverse Proxy"

  need_sudo

  if ! cmd_exists nginx; then
    info "Installing nginx..."
    if [[ "$OS" == "debian" ]]; then
      $SUDO apt-get update -y >/dev/null
      $SUDO apt-get install -y nginx >/dev/null
    elif [[ "$OS" == "macos" ]]; then
      brew install nginx
    else
      fail "Cannot auto-install nginx on this OS. Install manually."
      return 1
    fi
  fi
  ok "nginx installed"

  # Generate self-signed certificate if none exists
  local cert_dir="/etc/ssl/valentine"
  if [[ ! -f "${cert_dir}/valentine.pem" ]]; then
    info "Generating self-signed TLS certificate..."
    $SUDO mkdir -p "$cert_dir"
    $SUDO openssl req -x509 -nodes -days 3650 \
      -newkey rsa:2048 \
      -keyout "${cert_dir}/valentine.key" \
      -out "${cert_dir}/valentine.pem" \
      -subj "/CN=${HOSTNAME}" \
      -addext "subjectAltName=DNS:${HOSTNAME},DNS:localhost,IP:127.0.0.1" \
      >/dev/null 2>&1
    $SUDO chmod 600 "${cert_dir}/valentine.key"
    ok "TLS certificate generated (self-signed, 10 years)"
  fi

  # Write nginx config
  local nginx_conf
  if [[ -d /etc/nginx/sites-available ]]; then
    nginx_conf="/etc/nginx/sites-available/valentine-rf"
  elif [[ -d /etc/nginx/conf.d ]]; then
    nginx_conf="/etc/nginx/conf.d/valentine-rf.conf"
  else
    nginx_conf="/etc/nginx/conf.d/valentine-rf.conf"
    $SUDO mkdir -p /etc/nginx/conf.d
  fi

  $SUDO tee "$nginx_conf" > /dev/null << EOF
# VALENTINE RF - nginx reverse proxy configuration
# Generated by deploy.sh on $(date -u +"%Y-%m-%d %H:%M:%S UTC")

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name ${HOSTNAME};
    return 301 https://\$host\$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    server_name ${HOSTNAME};

    ssl_certificate     ${cert_dir}/valentine.pem;
    ssl_certificate_key ${cert_dir}/valentine.key;

    # Modern TLS configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # Security headers
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # SSE support - disable buffering for real-time streaming
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # WebSocket support (Listening Post, Meshtastic)
    location /ws {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
    }
}
EOF

  # Enable site (Debian/Ubuntu style)
  if [[ -d /etc/nginx/sites-enabled ]]; then
    $SUDO ln -sf "$nginx_conf" /etc/nginx/sites-enabled/valentine-rf
    # Remove default site if it conflicts
    if [[ -f /etc/nginx/sites-enabled/default ]]; then
      $SUDO rm -f /etc/nginx/sites-enabled/default
    fi
  fi

  # Test and reload
  if $SUDO nginx -t 2>/dev/null; then
    $SUDO systemctl enable nginx 2>/dev/null || true
    $SUDO systemctl reload nginx 2>/dev/null || $SUDO systemctl start nginx
    ok "nginx configured and running"
    info "HTTPS available at: https://${HOSTNAME}"
  else
    fail "nginx configuration test failed. Check: sudo nginx -t"
  fi
}

# ----------------------------
# Reverse proxy: Caddy
# ----------------------------
install_caddy_proxy() {
  section "Configuring Caddy Reverse Proxy"

  need_sudo

  if ! cmd_exists caddy; then
    info "Installing Caddy..."
    if [[ "$OS" == "debian" ]]; then
      $SUDO apt-get update -y >/dev/null
      $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null 2>&1
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      $SUDO apt-get update -y >/dev/null
      $SUDO apt-get install -y caddy >/dev/null
    elif [[ "$OS" == "macos" ]]; then
      brew install caddy
    else
      fail "Cannot auto-install Caddy on this OS. Install manually."
      return 1
    fi
  fi
  ok "Caddy installed"

  # Write Caddyfile
  local caddyfile="/etc/caddy/Caddyfile"
  $SUDO mkdir -p /etc/caddy

  $SUDO tee "$caddyfile" > /dev/null << EOF
# VALENTINE RF - Caddy reverse proxy configuration
# Generated by deploy.sh on $(date -u +"%Y-%m-%d %H:%M:%S UTC")

${HOSTNAME} {
    reverse_proxy localhost:${PORT}

    # Security headers
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }
}
EOF

  $SUDO systemctl enable caddy 2>/dev/null || true
  $SUDO systemctl reload caddy 2>/dev/null || $SUDO systemctl start caddy
  ok "Caddy configured and running"
  info "HTTPS available at: https://${HOSTNAME}"
  info "Caddy auto-manages TLS certificates."
}

# ----------------------------
# Uninstall
# ----------------------------
uninstall() {
  section "Uninstalling VALENTINE RF"

  if ! ask_yes_no "This will stop and remove the VALENTINE RF deployment. Continue?"; then
    info "Uninstall cancelled."
    exit 0
  fi

  need_sudo

  # Stop Docker containers
  if $HAS_COMPOSE; then
    info "Stopping Docker containers..."
    docker compose --profile basic down 2>/dev/null || true
    docker compose --profile history down 2>/dev/null || true
    ok "Docker containers stopped"
  fi

  # Stop systemd service
  if [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
    info "Stopping systemd service..."
    $SUDO systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    $SUDO systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    $SUDO rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    $SUDO systemctl daemon-reload
    ok "Systemd service removed"
  fi

  # Remove nginx config
  if [[ -f /etc/nginx/sites-available/valentine-rf ]]; then
    $SUDO rm -f /etc/nginx/sites-available/valentine-rf
    $SUDO rm -f /etc/nginx/sites-enabled/valentine-rf
    $SUDO systemctl reload nginx 2>/dev/null || true
    ok "nginx configuration removed"
  fi
  if [[ -f /etc/nginx/conf.d/valentine-rf.conf ]]; then
    $SUDO rm -f /etc/nginx/conf.d/valentine-rf.conf
    $SUDO systemctl reload nginx 2>/dev/null || true
    ok "nginx configuration removed"
  fi

  # Remove docker-compose override
  rm -f "${INSTALL_DIR}/docker-compose.override.yml"

  info "The .env file and data/ directory were preserved."
  info "Remove them manually if no longer needed:"
  echo "  rm -f ${ENV_FILE}"
  echo "  rm -rf ${DATA_DIR}"

  ok "Uninstall complete."
  exit 0
}

# ----------------------------
# Post-deployment summary
# ----------------------------
show_summary() {
  section "Deployment Complete"

  local url="http://localhost:${PORT}"
  local tls_url=""

  if $WITH_NGINX || $WITH_CADDY; then
    tls_url="https://${HOSTNAME}"
  fi

  echo -e "  ${BOLD}Deployment mode:${NC}  ${DEPLOY_MODE}"
  echo -e "  ${BOLD}Web UI:${NC}           ${url}"
  if [[ -n "$tls_url" ]]; then
    echo -e "  ${BOLD}HTTPS:${NC}            ${tls_url}"
  fi
  echo -e "  ${BOLD}Admin user:${NC}       admin"
  echo -e "  ${BOLD}Admin password:${NC}   (see .env file)"
  echo -e "  ${BOLD}Config file:${NC}      ${ENV_FILE}"
  echo -e "  ${BOLD}Data directory:${NC}   ${DATA_DIR}"
  echo

  if [[ "$DEPLOY_MODE" == "docker" ]]; then
    echo -e "  ${BOLD}Common commands:${NC}"
    echo "    docker compose logs -f              # View logs"
    echo "    docker compose restart              # Restart"
    echo "    docker compose --profile basic down # Stop"
    echo "    docker compose --profile basic up -d --build  # Rebuild"
  else
    echo -e "  ${BOLD}Common commands:${NC}"
    echo "    sudo systemctl status ${SERVICE_NAME}    # Check status"
    echo "    sudo journalctl -u ${SERVICE_NAME} -f    # View logs"
    echo "    sudo systemctl restart ${SERVICE_NAME}   # Restart"
    echo "    sudo systemctl stop ${SERVICE_NAME}      # Stop"
  fi

  echo
  echo -e "  ${BOLD}Features installed:${NC}"

  local features=(
    "Pager decoding (POCSAG/FLEX)"
    "433MHz IoT sensor monitoring"
    "ADS-B aircraft tracking"
    "ACARS aircraft datalink messages"
    "AIS vessel tracking"
    "WiFi reconnaissance"
    "Bluetooth scanning & tracker detection"
    "Satellite pass prediction"
    "ISS SSTV image decoding"
    "Weather satellite imagery (NOAA APT & Meteor LRPT)"
    "APRS amateur packet radio"
    "Meshtastic LoRa mesh networking"
    "Utility meter reading (rtlamr)"
    "Digital voice decoding (DMR/P25/NXDN/D-STAR)"
    "TSCM counter-surveillance analysis"
    "Listening Post with WebSDR"
  )
  for f in "${features[@]}"; do
    echo -e "    ${GREEN}+${NC} ${f}"
  done

  if $WITH_HISTORY; then
    echo -e "    ${GREEN}+${NC} ADS-B history (Postgres persistence)"
  fi

  echo
  if $WITH_NGINX || $WITH_CADDY; then
    ok "TLS/HTTPS termination active via reverse proxy"
  else
    warn "No reverse proxy configured. Set one up for production use."
    info "Re-run with --with-nginx or --with-caddy to add one."
  fi

  echo
  ok "VALENTINE RF is ready. Open ${url} in your browser."
}

# ----------------------------
# Main
# ----------------------------
main() {
  parse_args "$@"
  show_banner

  # Handle uninstall
  if $DO_UNINSTALL; then
    preflight_checks
    uninstall
  fi

  # Run deployment
  preflight_checks
  select_deploy_mode
  select_features
  generate_env_file

  case "$DEPLOY_MODE" in
    docker)     deploy_docker ;;
    bare-metal) deploy_bare_metal ;;
    *)          fail "Unknown deploy mode: ${DEPLOY_MODE}"; exit 1 ;;
  esac

  # Reverse proxy
  if $WITH_NGINX; then
    install_nginx_proxy
  elif $WITH_CADDY; then
    install_caddy_proxy
  fi

  show_summary
}

main "$@"
