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
SERVICE_NAME="panoruleauditor"
NODE_VERSION="20"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
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
    log "Updating system packages..."
    dnf update -y

    log "Installing system dependencies..."
    dnf install -y \
        curl \
        wget \
        git \
        tar \
        gzip \
        which \
        firewalld

    log "System dependencies installed successfully"
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

    log "Verifying Node.js installation..."
    node --version
    npm --version
    log "Node.js installed successfully"
}

create_app_user() {
    log "Creating application user..."
    
    if id "$APP_USER" &>/dev/null; then
        log "User $APP_USER already exists"
    else
        useradd -r -s /bin/bash -d "$APP_DIR" -m "$APP_USER"
        log "User $APP_USER created successfully"
    fi
}

setup_application() {
    log "Setting up application directory..."
    
    if [[ -d "$APP_DIR" && "$(ls -A $APP_DIR)" ]]; then
        log "Application directory already exists with content"
        read -p "Do you want to overwrite existing installation? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log "Installation cancelled"
            exit 0
        fi
        rm -rf "$APP_DIR"/*
    fi

    mkdir -p "$APP_DIR"
    
    log "Copying application files from $SCRIPT_DIR to $APP_DIR..."
    
    if ! [[ -f "$SCRIPT_DIR/package.json" ]]; then
        log "package.json not found in $SCRIPT_DIR"
        log "Searching for package.json in parent directories..."
        
        SEARCH_DIR="$SCRIPT_DIR"
        FOUND_DIR=""
        for i in {1..5}; do
            if [[ -f "$SEARCH_DIR/package.json" ]]; then
                FOUND_DIR="$SEARCH_DIR"
                break
            fi
            SEARCH_DIR="$(dirname "$SEARCH_DIR")"
            if [[ "$SEARCH_DIR" == "/" ]]; then
                break
            fi
        done
        
        if [[ -n "$FOUND_DIR" ]]; then
            log "Found package.json in $FOUND_DIR, using that as source directory"
            SCRIPT_DIR="$FOUND_DIR"
        else
            log "Current working directory: $(pwd)"
            log "Script location: $SCRIPT_DIR"
            log "Contents of script directory:"
            ls -la "$SCRIPT_DIR" 2>&1 || true
            error "package.json not found. Please ensure the script is in the project root directory, or run it from the project root."
        fi
    fi
    
    if command -v rsync &> /dev/null; then
        if ! rsync -av --exclude='.git' "$SCRIPT_DIR/" "$APP_DIR/"; then
            error "Failed to copy application files using rsync"
        fi
    elif command -v tar &> /dev/null; then
        cd "$SCRIPT_DIR"
        if ! tar --exclude='.git' -cf - . | (cd "$APP_DIR" && tar -xf -); then
            error "Failed to copy application files using tar"
        fi
    else
        shopt -s dotglob nullglob
        files_copied=0
        for file in "$SCRIPT_DIR"/* "$SCRIPT_DIR"/.[!.]* "$SCRIPT_DIR"/..?*; do
            if [[ -e "$file" && "$(basename "$file")" != ".git" ]]; then
                cp -r "$file" "$APP_DIR/" || error "Failed to copy $file"
                files_copied=1
            fi
        done
        shopt -u dotglob nullglob
        if [[ $files_copied -eq 0 ]]; then
            error "No files were copied. Check that $SCRIPT_DIR contains the application files."
        fi
    fi
    
    if [[ ! -f "$APP_DIR/package.json" ]]; then
        log "Files in $APP_DIR:"
        ls -la "$APP_DIR" || true
        log "Files in $SCRIPT_DIR:"
        ls -la "$SCRIPT_DIR" || true
        error "package.json not found after copying files. Copy operation may have failed."
    fi
    
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
    chmod -R 755 "$APP_DIR"
    
    log "Application files copied to $APP_DIR"
}

install_npm_dependencies() {
    log "Installing npm dependencies..."
    
    if [[ ! -f "$APP_DIR/package.json" ]]; then
        error "package.json not found in $APP_DIR. Cannot install dependencies."
    fi
    
    cd "$APP_DIR"
    
    if ! sudo -u "$APP_USER" npm install; then
        error "Failed to install npm dependencies"
    fi
    
    log "npm dependencies installed successfully"
}

setup_environment() {
    log "Setting up environment configuration..."
    
    ENV_FILE="$APP_DIR/.env.local"
    
    if [[ ! -f "$ENV_FILE" ]]; then
        cat > "$ENV_FILE" << EOF
GEMINI_API_KEY=your_gemini_api_key_here
EOF
        chown "$APP_USER:$APP_USER" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        log "Created .env.local file. Please update GEMINI_API_KEY"
    else
        log ".env.local already exists"
    fi
}

create_systemd_service() {
    log "Creating systemd service..."
    
    SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
    
    cat > "$SERVICE_FILE" << EOF
[Unit]
Description=PaloRuleAuditor Application
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment="NODE_ENV=production"
EnvironmentFile=${APP_DIR}/.env.local
ExecStart=/usr/bin/npm run dev
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    log "Systemd service created: ${SERVICE_NAME}.service"
}

configure_firewall() {
    log "Configuring firewall..."
    
    if systemctl is-active --quiet firewalld; then
        firewall-cmd --permanent --add-port=3000/tcp
        firewall-cmd --reload
        log "Firewall rule added for port 3000"
    else
        log "Firewalld is not active, skipping firewall configuration"
    fi
}

build_application() {
    log "Building application for production..."
    
    cd "$APP_DIR"
    sudo -u "$APP_USER" npm run build
    
    log "Application built successfully"
}

print_summary() {
    log "Installation completed successfully!"
    echo ""
    echo "=========================================="
    echo "Installation Summary"
    echo "=========================================="
    echo "Application Directory: $APP_DIR"
    echo "Application User: $APP_USER"
    echo "Service Name: $SERVICE_NAME"
    echo ""
    echo "Next Steps:"
    echo "1. Edit $APP_DIR/.env.local and set your GEMINI_API_KEY"
    echo "2. Start the service: systemctl start $SERVICE_NAME"
    echo "3. Enable auto-start: systemctl enable $SERVICE_NAME"
    echo "4. Check status: systemctl status $SERVICE_NAME"
    echo "5. View logs: journalctl -u $SERVICE_NAME -f"
    echo ""
    echo "For development mode, run as $APP_USER:"
    echo "  cd $APP_DIR && npm run dev"
    echo ""
    echo "For production, use the systemd service:"
    echo "  systemctl start $SERVICE_NAME"
    echo "=========================================="
}

main() {
    log "Starting installation of $APP_NAME for RHEL 9.7"
    
    check_root
    install_system_dependencies
    install_nodejs
    create_app_user
    setup_application
    install_npm_dependencies
    setup_environment
    create_systemd_service
    configure_firewall
    
    read -p "Do you want to build the application now? (Y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        build_application
    fi
    
    print_summary
}

main "$@"
