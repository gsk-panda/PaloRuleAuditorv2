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
SOURCE_DIR=""
REPO_URL="https://github.com/gsk-panda/PaloRuleAuditorv2.git"
CLONE_DIR="/tmp/${APP_NAME}_clone"

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

find_source_directory() {
    local search_dirs=()
    
    if [[ -n "$SOURCE_DIR" ]]; then
        search_dirs+=("$SOURCE_DIR")
    fi
    
    search_dirs+=("$(pwd)")
    search_dirs+=("$SCRIPT_DIR")
    
    for dir in "${search_dirs[@]}"; do
        if [[ -f "$dir/package.json" ]]; then
            echo "$dir"
            return 0
        fi
    done
    
    SEARCH_DIR="$SCRIPT_DIR"
    for i in {1..5}; do
        if [[ -f "$SEARCH_DIR/package.json" ]]; then
            echo "$SEARCH_DIR"
            return 0
        fi
        SEARCH_DIR="$(dirname "$SEARCH_DIR")"
        if [[ "$SEARCH_DIR" == "/" ]]; then
            break
        fi
    done
    
    return 1
}

clone_repository() {
    {
        log "Cloning repository from $REPO_URL..."
        
        if [[ -d "$CLONE_DIR" ]]; then
            log "Removing existing clone directory..."
            rm -rf "$CLONE_DIR"
        fi
        
        mkdir -p "$(dirname "$CLONE_DIR")"
        
        if ! command -v git &> /dev/null; then
            error "git is not installed. Please install git first."
        fi
        
        if ! git clone "$REPO_URL" "$CLONE_DIR"; then
            error "Failed to clone repository from $REPO_URL"
        fi
        
        if [[ ! -f "$CLONE_DIR/package.json" ]]; then
            error "Cloned repository does not contain package.json. Repository may be incorrect."
        fi
        
        log "Repository cloned successfully to $CLONE_DIR"
    } >&2
    
    echo "$CLONE_DIR"
}

setup_application() {
    log "Setting up application directory..."
    
    if [[ -d "$APP_DIR" && "$(ls -A $APP_DIR 2>/dev/null)" ]]; then
        log "Previous installation detected in $APP_DIR"
        read -p "Do you want to remove the existing installation and reinstall? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log "Installation cancelled"
            exit 0
        fi
        log "Removing existing installation..."
        systemctl stop "$SERVICE_NAME" 2>/dev/null || true
        systemctl disable "$SERVICE_NAME" 2>/dev/null || true
        rm -rf "$APP_DIR"
        log "Previous installation removed"
    fi

    mkdir -p "$APP_DIR"
    
    if [[ ! -w "$APP_DIR" ]]; then
        error "Destination directory $APP_DIR is not writable"
    fi
    
    local source_dir
    if ! source_dir=$(find_source_directory); then
        log "Project files not found locally"
        if [[ -n "$SOURCE_DIR" ]]; then
            log "Specified source directory $SOURCE_DIR does not contain package.json"
            error "Invalid source directory specified"
        fi
        
        log "Attempting to clone repository from $REPO_URL..."
        source_dir=$(clone_repository)
    fi
    
    log "Using source directory: $source_dir"
    log "Verifying source directory contains files..."
    log "Source directory contents:"
    ls -la "$source_dir" 2>&1 | head -10 || true
    
    log "Copying application files from $source_dir to $APP_DIR..."
    
    if command -v rsync &> /dev/null; then
        log "Using rsync to copy files..."
        if ! rsync -av --exclude='.git' "$source_dir/" "$APP_DIR/"; then
            error "Failed to copy application files using rsync"
        fi
        log "rsync completed"
    elif command -v tar &> /dev/null; then
        log "Using tar to copy files..."
        cd "$source_dir"
        if ! tar --exclude='.git' -cf - . | (cd "$APP_DIR" && tar -xf -); then
            error "Failed to copy application files using tar"
        fi
        log "tar completed"
    else
        log "Using cp to copy files..."
        shopt -s dotglob nullglob
        files_copied=0
        for file in "$source_dir"/* "$source_dir"/.[!.]* "$source_dir"/..?*; do
            if [[ -e "$file" && "$(basename "$file")" != ".git" ]]; then
                log "Copying: $(basename "$file")"
                cp -r "$file" "$APP_DIR/" || error "Failed to copy $file"
                files_copied=1
            fi
        done
        shopt -u dotglob nullglob
        if [[ $files_copied -eq 0 ]]; then
            error "No files were copied. Check that $source_dir contains the application files."
        fi
        log "cp completed, $files_copied file(s) copied"
    fi
    
    log "Verifying copy operation..."
    log "Destination directory contents:"
    ls -la "$APP_DIR" 2>&1 | head -20 || true
    
    if [[ ! -f "$APP_DIR/package.json" ]]; then
        log "ERROR: package.json not found in destination!"
        log "Source directory: $source_dir"
        log "Destination directory: $APP_DIR"
        log "Source directory file count: $(find "$source_dir" -type f | wc -l)"
        log "Destination directory file count: $(find "$APP_DIR" -type f 2>/dev/null | wc -l)"
        error "package.json not found after copying files. Copy operation may have failed."
    fi
    
    log "Copy verification successful - package.json found in destination"
    
    log "Setting ownership and permissions..."
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
    chmod -R 755 "$APP_DIR"
    log "Ownership set to $APP_USER:$APP_USER"
    
    log "Application files copied to $APP_DIR"
    
    if [[ -d "$CLONE_DIR" && "$source_dir" == "$CLONE_DIR" ]]; then
        log "Cleaning up temporary clone directory..."
        rm -rf "$CLONE_DIR"
        log "Temporary files removed"
    fi
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
    log "Note: The service runs both frontend (Vite) and backend (Express) servers"
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
    if [[ $# -gt 0 ]]; then
        if [[ "$1" == "-h" || "$1" == "--help" ]]; then
            echo "Usage: $0 [SOURCE_DIRECTORY|--repo REPO_URL]"
            echo ""
            echo "Install PaloRuleAuditor application"
            echo ""
            echo "Arguments:"
            echo "  SOURCE_DIRECTORY    Path to the project root directory (optional)"
            echo "                      If not specified, script will search for package.json"
            echo "                      in current directory, script directory, and parent directories"
            echo "                      If not found, will clone from default repository"
            echo ""
            echo "  --repo REPO_URL     Git repository URL to clone (default: $REPO_URL)"
            echo ""
            exit 0
        elif [[ "$1" == "--repo" ]]; then
            if [[ -z "$2" ]]; then
                error "Repository URL required after --repo"
            fi
            REPO_URL="$2"
            log "Using repository URL: $REPO_URL"
        else
            SOURCE_DIR="$(cd "$1" && pwd)"
            if [[ ! -d "$SOURCE_DIR" ]]; then
                error "Source directory does not exist: $1"
            fi
            if [[ ! -f "$SOURCE_DIR/package.json" ]]; then
                error "package.json not found in specified directory: $SOURCE_DIR"
            fi
            log "Using specified source directory: $SOURCE_DIR"
        fi
    fi
    
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
