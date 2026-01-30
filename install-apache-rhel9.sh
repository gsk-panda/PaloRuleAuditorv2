#!/bin/bash

set -e

SCRIPT_PATH="${BASH_SOURCE[0]}"
if [[ -L "$SCRIPT_PATH" ]]; then
    SCRIPT_PATH="$(readlink -f "$SCRIPT_PATH")"
fi
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
APP_NAME="PaloRuleAuditor"
APP_USER="panoruleauditor"
APP_DIR="/opt/${APP_NAME}"
SERVICE_NAME="panoruleauditor-backend"
BACKEND_PORT="3010"
WEB_ROOT="/var/www/html/audit"
URL_PATH="/audit"
NODE_VERSION="20"
REPO_URL="https://github.com/gsk-panda/PaloRuleAuditorv2.git"
CLONE_DIR="/tmp/${APP_NAME}_clone"
APACHE_CONF_D="/etc/httpd/conf.d"
APACHE_CONF_FILE="panoruleauditor.conf"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" >&2
}

error() {
    echo "[ERROR] $1" >&2
    exit 1
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        error "This script must be run as root. Use: sudo $0"
    fi
}

install_system_dependencies() {
    log "Installing system dependencies..."
    dnf install -y curl wget git tar gzip which 2>/dev/null || true
    log "System dependencies installed"
}

install_nodejs() {
    log "Installing Node.js ${NODE_VERSION}..."
    if command -v node &> /dev/null; then
        INSTALLED_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ "$INSTALLED_VERSION" -ge "$NODE_VERSION" ]]; then
            log "Node.js ${INSTALLED_VERSION} is already installed"
            return
        fi
    fi
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION}.x | bash -
    dnf install -y nodejs
    node --version
    npm --version
    log "Node.js installed"
}

create_app_user() {
    if id "$APP_USER" &>/dev/null; then
        log "User $APP_USER already exists"
    else
        useradd -r -s /bin/bash -d "$APP_DIR" -m "$APP_USER"
        log "User $APP_USER created"
    fi
}

find_source_directory() {
    for dir in "$(pwd)" "$SCRIPT_DIR"; do
        [[ -f "$dir/package.json" ]] && { echo "$dir"; return 0; }
    done
    return 1
}

clone_repository() {
    log "Cloning repository from $REPO_URL..."
    rm -rf "$CLONE_DIR"
    mkdir -p "$(dirname "$CLONE_DIR")"
    git clone "$REPO_URL" "$CLONE_DIR"
    [[ -f "$CLONE_DIR/package.json" ]] || error "Cloned repo missing package.json"
    log "Repository cloned to $CLONE_DIR"
    echo "$CLONE_DIR"
}

setup_application() {
    log "Setting up application in $APP_DIR..."
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    if [[ -d "$APP_DIR" && "$(ls -A $APP_DIR 2>/dev/null)" ]]; then
        log "Removing previous installation..."
        rm -rf "$APP_DIR"
    fi
    mkdir -p "$APP_DIR"
    local source_dir
    if source_dir=$(find_source_directory 2>/dev/null); then
        log "Using local source: $source_dir"
    else
        source_dir=$(clone_repository)
    fi
    if command -v rsync &> /dev/null; then
        rsync -av --exclude=node_modules --exclude=dist --exclude=dist-server "$source_dir/" "$APP_DIR/"
    else
        tar -cf - -C "$source_dir" --exclude=node_modules --exclude=dist --exclude=dist-server . | tar -xf - -C "$APP_DIR"
    fi
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
    [[ -f "$APP_DIR/package.json" ]] || error "package.json not found in $APP_DIR"
    [[ "$source_dir" == "$CLONE_DIR" ]] && rm -rf "$CLONE_DIR"
    log "Application files installed"
}

install_npm_dependencies() {
    log "Installing npm dependencies..."
    cd "$APP_DIR"
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
    npm install || { log "npm install failed (often esbuild/SELinux on RHEL), retrying with --ignore-scripts..."; npm install --ignore-scripts; }
    if [[ -d "$APP_DIR/node_modules" ]]; then
        find "$APP_DIR/node_modules" -type f -name "esbuild" -exec chmod +x {} \; 2>/dev/null || true
        [[ -d "$APP_DIR/node_modules/.bin" ]] && find "$APP_DIR/node_modules/.bin" -type f -exec chmod +x {} \; 2>/dev/null || true
    fi
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
    if command -v restorecon &>/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
        restorecon -R "$APP_DIR" 2>/dev/null || true
    fi
    log "npm dependencies installed"
}

setup_backend_env() {
    local env_file="$APP_DIR/.env.local"
    if [[ ! -f "$env_file" ]]; then
        echo "PORT=$BACKEND_PORT" > "$env_file"
        chown "$APP_USER:$APP_USER" "$env_file"
        chmod 600 "$env_file"
        log "Created $env_file"
    else
        grep -q "^PORT=" "$env_file" || echo "PORT=$BACKEND_PORT" >> "$env_file"
    fi
}

prompt_panorama_config() {
    local config_file="$APP_DIR/.config"
    if [[ -t 0 ]]; then
        echo ""
        read -p "Panorama URL (e.g. https://panorama.example.com, leave empty to skip): " panorama_url
        if [[ -n "$panorama_url" ]]; then
            read -p "Panorama API key: " panorama_key
            printf 'PANORAMA_URL="%s"\nPANORAMA_API_KEY="%s"\n' "$panorama_url" "$panorama_key" > "$config_file"
            chown "$APP_USER:$APP_USER" "$config_file"
            chmod 600 "$config_file"
            log "Panorama config saved to $config_file"
        fi
    else
        log "Non-interactive: skipping Panorama prompt. Add PANORAMA_URL and PANORAMA_API_KEY to $config_file or configure in the web UI."
    fi
}

build_frontend() {
    log "Building frontend with base path $URL_PATH..."
    cd "$APP_DIR"
    export VITE_BASE_PATH="$URL_PATH/"
    npm run build
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
    [[ -d "$APP_DIR/dist" ]] || error "Frontend build failed: dist/ not found"
    log "Frontend built"
}

build_backend() {
    log "Building backend (TypeScript to JavaScript)..."
    cd "$APP_DIR"
    npm run build:server
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
    [[ -f "$APP_DIR/dist-server/server/index.js" ]] || error "Backend build failed: dist-server/server/index.js not found"
    log "Backend built"
}

deploy_static_to_apache() {
    log "Deploying static files to $WEB_ROOT..."
    mkdir -p "$WEB_ROOT"
    rm -rf "$WEB_ROOT"/*
    cp -r "$APP_DIR/dist"/* "$WEB_ROOT/"
    chown -R apache:apache "$WEB_ROOT"
    chmod -R 755 "$WEB_ROOT"
    log "Static files deployed"
}

create_systemd_service() {
    local service_file="/etc/systemd/system/${SERVICE_NAME}.service"
    local selinux_line=""
    if command -v getenforce &>/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
        selinux_line="SELinuxContext=system_u:system_r:unconfined_service_t:s0"
    fi
    cat > "$service_file" << EOF
[Unit]
Description=PaloRuleAuditor Backend API
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
${selinux_line}
Environment="NODE_ENV=production"
Environment="PORT=${BACKEND_PORT}"
EnvironmentFile=-${APP_DIR}/.env.local
ExecStart=/usr/bin/node dist-server/server/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    log "Systemd service created: $SERVICE_NAME"
}

write_apache_config() {
    local conf_path="${APACHE_CONF_D}/${APACHE_CONF_FILE}"
    log "Writing Apache config to $conf_path..."
    cat > "$conf_path" << EOF
# PaloRuleAuditor - add to Apache (e.g. in conf.d or Include in main config)
# URL path and backend port must match install-apache-rhel9.sh (URL_PATH, BACKEND_PORT)

<Location "${URL_PATH}/api">
    ProxyPass http://127.0.0.1:${BACKEND_PORT}/api
    ProxyPassReverse http://127.0.0.1:${BACKEND_PORT}/api
    Require all granted
</Location>

Alias "${URL_PATH}" "${WEB_ROOT}"
<Directory "${WEB_ROOT}">
    Options -Indexes +FollowSymLinks
    Require all granted
    AllowOverride None
</Directory>
EOF
    log "Apache config written. Enable proxy modules if needed: a2enmod proxy proxy_http (or uncomment in httpd.conf)."
}

enable_apache_proxy() {
    local mods="proxy proxy_http"
    for mod in $mods; do
        if [[ -f "/etc/httpd/conf.modules.d/00-base.conf" ]] && grep -q "LoadModule ${mod}_module" /etc/httpd/conf.modules.d/*.conf 2>/dev/null; then
            log "Proxy modules present"
            return
        fi
    done
    log "Ensure these are enabled in Apache: LoadModule proxy_module; LoadModule proxy_http_module"
}

fix_selinux_for_app() {
    if ! command -v getenforce &>/dev/null || [[ "$(getenforce 2>/dev/null)" != "Enforcing" ]]; then
        return 0
    fi
    log "Setting SELinux context so backend can read and run app files..."
    if [[ -d "$APP_DIR" ]]; then
        if command -v semanage &>/dev/null; then
            semanage fcontext -a -t usr_t "${APP_DIR}(/.*)?" 2>/dev/null || true
            restorecon -R "$APP_DIR" 2>/dev/null || true
        else
            chcon -R -t usr_t "$APP_DIR" 2>/dev/null || true
        fi
        log "SELinux context updated for $APP_DIR"
    fi
}

start_services() {
    systemctl enable "$SERVICE_NAME"
    systemctl start "$SERVICE_NAME"
    log "Backend service started"
    if systemctl is-active --quiet httpd 2>/dev/null || systemctl is-active --quiet apache2 2>/dev/null; then
        systemctl reload httpd 2>/dev/null || systemctl reload apache2 2>/dev/null || true
        log "Apache reloaded"
    else
        log "Start or reload Apache manually after adding the config snippet."
    fi
}

print_summary() {
    echo ""
    echo "=========================================="
    echo "PaloRuleAuditor – Apache installation"
    echo "=========================================="
    echo "App dir:      $APP_DIR"
    echo "Backend:      $SERVICE_NAME (port $BACKEND_PORT)"
    echo "Static files: $WEB_ROOT"
    echo "URL path:     $URL_PATH"
    echo ""
    echo "Apache config written to: ${APACHE_CONF_D}/${APACHE_CONF_FILE}"
    echo "If your Apache uses a different layout, add the following to your vhost or conf.d:"
    echo ""
    cat "${APACHE_CONF_D}/${APACHE_CONF_FILE}"
    echo ""
    echo "=========================================="
    echo "Next steps:"
    echo "  1. Ensure Apache has proxy_module and proxy_http_module enabled."
    echo "  2. Reload Apache: systemctl reload httpd"
    echo "  3. Open https://YOUR_SERVER${URL_PATH}/ in a browser."
    echo "  4. Panorama URL/API key: configure in UI or edit $APP_DIR/.config"
    echo "  5. Backend logs: journalctl -u $SERVICE_NAME -f"
    echo "=========================================="
}

main() {
    if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
        echo "Usage: sudo $0 [OPTIONS]"
        echo "Install PaloRuleAuditor behind Apache on RHEL 9."
        echo ""
        echo "Options:"
        echo "  --url-path PATH    URL path (default: /audit)"
        echo "  --web-root PATH    Directory for static files (default: /var/www/html/audit)"
        echo "  --backend-port N   Backend port (default: 3010)"
        exit 0
    fi
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --url-path) URL_PATH="${2:-/audit}"; shift 2 ;;
            --web-root) WEB_ROOT="$2"; shift 2 ;;
            --backend-port) BACKEND_PORT="$2"; shift 2 ;;
            *) shift ;;
        esac
    done
    [[ "$URL_PATH" =~ ^/ ]] || URL_PATH="/$URL_PATH"
    log "Starting Apache install (path=$URL_PATH, webroot=$WEB_ROOT, port=$BACKEND_PORT)"
    check_root
    install_system_dependencies
    install_nodejs
    create_app_user
    setup_application
    install_npm_dependencies
    setup_backend_env
    prompt_panorama_config
    build_frontend
    build_backend
    deploy_static_to_apache
    create_systemd_service
    write_apache_config
    enable_apache_proxy
    fix_selinux_for_app
    start_services
    print_summary
}

main "$@"
