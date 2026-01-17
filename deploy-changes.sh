#!/bin/bash

set -e

APP_DIR="/opt/PaloRuleAuditor"
SERVICE_NAME="panoruleauditor"
APP_USER="panoruleauditor"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        echo "This script must be run as root. Use: sudo $0"
        exit 1
    fi
}

main() {
    log "Deploying changes to PaloRuleAuditor..."
    
    check_root
    
    if [[ ! -d "$APP_DIR" ]]; then
        log "ERROR: Application directory $APP_DIR not found!"
        log "Please run install-rhel9.sh first to install the application."
        exit 1
    fi
    
    log "Stopping service..."
    systemctl stop "$SERVICE_NAME" || true
    
    log "Copying updated files..."
    
    if [[ -f "$SOURCE_DIR/server/panoramaService.ts" ]]; then
        cp "$SOURCE_DIR/server/panoramaService.ts" "$APP_DIR/server/panoramaService.ts"
        chown "$APP_USER:$APP_USER" "$APP_DIR/server/panoramaService.ts"
        log "  Updated server/panoramaService.ts"
    fi
    
    if [[ -f "$SOURCE_DIR/server/index.ts" ]]; then
        cp "$SOURCE_DIR/server/index.ts" "$APP_DIR/server/index.ts"
        chown "$APP_USER:$APP_USER" "$APP_DIR/server/index.ts"
        log "  Updated server/index.ts"
    fi
    
    log "Starting service..."
    systemctl start "$SERVICE_NAME"
    
    sleep 2
    
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        log "Service started successfully!"
        log "View logs with: journalctl -u $SERVICE_NAME -f"
    else
        log "WARNING: Service may not have started correctly"
        log "Check status with: systemctl status $SERVICE_NAME"
        log "View logs with: journalctl -u $SERVICE_NAME -n 50"
    fi
}

main "$@"
