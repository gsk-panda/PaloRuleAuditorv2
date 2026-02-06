#!/bin/bash

set -e

APP_NAME="PaloRuleAuditor"
APP_DIR="/opt/${APP_NAME}"
CLONE_DIR="/tmp/${APP_NAME}_clone"
REPO_URL="https://github.com/gsk-panda/PaloRuleAuditorv2.git"
SERVICE_NAME="panoruleauditor-backend"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        echo "This script must be run as root. Use: sudo $0"
        exit 1
    fi
}

check_root

log "Stopping services..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl stop httpd 2>/dev/null || true

log "Removing previous installation at $APP_DIR..."
rm -rf "$APP_DIR"

log "Removing existing clone at $CLONE_DIR..."
rm -rf "$CLONE_DIR"

log "Cloning repository..."
git clone "$REPO_URL" "$CLONE_DIR"

log "Setting execute permission on install-apache-rhel9.sh..."
chmod +x "$CLONE_DIR/install-apache-rhel9.sh"

log "Running Apache installation..."
cd "$CLONE_DIR"
exec ./install-apache-rhel9.sh
