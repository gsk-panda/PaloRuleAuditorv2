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
WEB_ROOT="/var/www/html/audit"
BACKEND_PORT="3005"
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

prompt_input() {
    local prompt_text="$1"
    local var_name="$2"
    local is_password="${3:-false}"
    local default_value="${4:-}"
    
    while true; do
        if [[ "$is_password" == "true" ]]; then
            if [[ -n "$default_value" ]]; then
                read -sp "$prompt_text [press Enter to keep existing]: " input_value
                echo
                if [[ -z "$input_value" ]]; then
                    eval "$var_name='$default_value'"
                    break
                else
                    eval "$var_name='$input_value'"
                    break
                fi
            else
                read -sp "$prompt_text: " input_value
                echo
                if [[ -n "$input_value" ]]; then
                    eval "$var_name='$input_value'"
                    break
                else
                    echo "  Error: This field cannot be empty. Please try again."
                fi
            fi
        else
            if [[ -n "$default_value" ]]; then
                read -p "$prompt_text [default: $default_value]: " input_value
                if [[ -z "$input_value" ]]; then
                    eval "$var_name='$default_value'"
                    break
                else
                    eval "$var_name='$input_value'"
                    break
                fi
            else
                read -p "$prompt_text: " input_value
                if [[ -n "$input_value" ]]; then
                    eval "$var_name='$input_value'"
                    break
                else
                    echo "  Error: This field cannot be empty. Please try again."
                fi
            fi
        fi
    done
}

get_config() {
    local config_file="$APP_DIR/.config"
    
    if [[ -f "$config_file" ]]; then
        source "$config_file"
        log "Found existing configuration"
    fi
    
    echo ""
    echo "=========================================="
    echo "Panorama Configuration"
    echo "=========================================="
    echo "Please provide your Panorama connection details:"
    echo ""
    
    prompt_input "Panorama URL (e.g., https://panorama.example.com)" "PANORAMA_URL" false "${PANORAMA_URL:-}"
    prompt_input "Panorama API Key" "PANORAMA_API_KEY" true "${PANORAMA_API_KEY:-}"
    
    log "Saving configuration..."
    cat > "$config_file" << EOF
PANORAMA_URL="$PANORAMA_URL"
PANORAMA_API_KEY="$PANORAMA_API_KEY"
EOF
    chmod 600 "$config_file"
    chown "$APP_USER:$APP_USER" "$config_file"
    log "Configuration saved to $config_file"
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
        httpd \
        mod_ssl

    log "Enabling required Apache modules..."
    if command -v a2enmod &> /dev/null; then
        a2enmod proxy proxy_http rewrite ssl 2>/dev/null || true
    else
        log "Note: a2enmod not found. Please ensure mod_proxy, mod_proxy_http, mod_rewrite, and mod_ssl are enabled."
    fi

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
        log "Removing existing installation..."
        systemctl stop "${APP_NAME}-backend" 2>/dev/null || true
        systemctl disable "${APP_NAME}-backend" 2>/dev/null || true
        rm -rf "$APP_DIR"
        log "Previous installation removed"
    fi

    mkdir -p "$APP_DIR"
    mkdir -p "$WEB_ROOT"
    
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
        if ! rsync -av "$source_dir/" "$APP_DIR/"; then
            error "Failed to copy application files using rsync"
        fi
        log "rsync completed"
    elif command -v tar &> /dev/null; then
        log "Using tar to copy files..."
        cd "$source_dir"
        if ! tar -cf - . | (cd "$APP_DIR" && tar -xf -); then
            error "Failed to copy application files using tar"
        fi
        log "tar completed"
    else
        log "Using cp to copy files..."
        shopt -s dotglob nullglob
        files_copied=0
        for file in "$source_dir"/* "$source_dir"/.[!.]* "$source_dir"/..?*; do
            if [[ -e "$file" ]]; then
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
    
    log "Ensuring proper permissions before npm install..."
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
    chmod -R u+w "$APP_DIR"
    
    log "Running npm install as $APP_USER..."
    if ! sudo -u "$APP_USER" npm install; then
        error "Failed to install npm dependencies"
    fi
    
    log "Fixing permissions on node_modules binaries..."
    if [[ -d "$APP_DIR/node_modules" ]]; then
        find "$APP_DIR/node_modules" -type f -name "esbuild" -exec chmod +x {} \; 2>/dev/null || true
        find "$APP_DIR/node_modules/.bin" -type f -exec chmod +x {} \; 2>/dev/null || true
        chown -R "$APP_USER:$APP_USER" "$APP_DIR/node_modules"
    fi
    
    log "npm dependencies installed successfully"
}

setup_environment() {
    log "Setting up environment configuration..."
    
    ENV_FILE="$APP_DIR/.env.local"
    
    if [[ ! -f "$ENV_FILE" ]]; then
        cat > "$ENV_FILE" << EOF
GEMINI_API_KEY=your_gemini_api_key_here
PORT=$BACKEND_PORT
EOF
        chown "$APP_USER:$APP_USER" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        log "Created .env.local file"
    else
        if ! grep -q "PORT=" "$ENV_FILE"; then
            echo "PORT=$BACKEND_PORT" >> "$ENV_FILE"
        fi
        log ".env.local already exists, updated if needed"
    fi
}

build_application() {
    log "Building application for production..."
    
    cd "$APP_DIR"
    export VITE_BASE_PATH="/audit/"
    sudo -u "$APP_USER" -E npm run build
    
    log "Copying built frontend to web root..."
    if [[ -d "$APP_DIR/dist" ]]; then
        rm -rf "$WEB_ROOT"/*
        cp -r "$APP_DIR/dist"/* "$WEB_ROOT/"
        chown -R apache:apache "$WEB_ROOT"
        chmod -R 755 "$WEB_ROOT"
        log "Frontend files copied to $WEB_ROOT"
    else
        error "Build directory not found. Build may have failed."
    fi
    
    log "Application built successfully"
}

create_backend_service() {
    log "Creating systemd service for backend..."
    
    SERVICE_FILE="/etc/systemd/system/${APP_NAME}-backend.service"
    
    cat > "$SERVICE_FILE" << EOF
[Unit]
Description=PaloRuleAuditor Backend API Service
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment="NODE_ENV=production"
Environment="PORT=${BACKEND_PORT}"
EnvironmentFile=${APP_DIR}/.env.local
ExecStart=/usr/bin/node ${APP_DIR}/dist/server/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    log "Systemd service created: ${APP_NAME}-backend.service"
}

configure_apache() {
    log "Configuring Apache..."
    
    APACHE_CONF="/etc/httpd/conf.d/panoruleauditor.conf"
    
    cat > "$APACHE_CONF" << 'EOF'
<VirtualHost *:443>
    ServerName panovision.sncorp.com
    DocumentRoot /var/www/html
    
    SSLEngine on
    SSLCertificateFile /etc/pki/tls/certs/panovision.sncorp.com.crt
    SSLCertificateKeyFile /etc/pki/tls/private/panovision.sncorp.com.key
    
    <Directory /var/www/html/audit>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>
    
    ProxyPreserveHost On
    ProxyRequests Off
    
    <Location /audit/api>
        ProxyPass http://localhost:3005/api
        ProxyPassReverse http://localhost:3005/api
    </Location>
    
    Alias /audit /var/www/html/audit
    
    <Directory /var/www/html/audit>
        RewriteEngine On
        RewriteBase /audit/
        RewriteRule ^index\.html$ - [L]
        RewriteCond %{REQUEST_FILENAME} !-f
        RewriteCond %{REQUEST_FILENAME} !-d
        RewriteRule . /audit/index.html [L]
    </Directory>
    
    ErrorLog /var/log/httpd/panoruleauditor_error.log
    CustomLog /var/log/httpd/panoruleauditor_access.log combined
</VirtualHost>
EOF

    log "Apache configuration created at $APACHE_CONF"
    log "Note: Please ensure SSL certificates are configured correctly"
    log "Note: You may need to adjust the ProxyPass directive based on your Apache setup"
    log "Note: Ensure mod_proxy and mod_rewrite are enabled: a2enmod proxy proxy_http rewrite"
}

update_backend_config() {
    log "Updating backend to use stored configuration..."
    
    CONFIG_FILE="$APP_DIR/.config"
    if [[ ! -f "$CONFIG_FILE" ]]; then
        error "Configuration file not found. Please run get_config first."
    fi
    
    source "$CONFIG_FILE"
    
    log "Backend will use Panorama URL: $PANORAMA_URL"
    log "Note: The backend service will read configuration from $CONFIG_FILE"
}

print_summary() {
    log "Installation completed successfully!"
    echo ""
    echo "=========================================="
    echo "Installation Summary"
    echo "=========================================="
    echo "Application Directory: $APP_DIR"
    echo "Web Root: $WEB_ROOT"
    echo "Application User: $APP_USER"
    echo "Backend Service: ${APP_NAME}-backend"
    echo "Backend Port: $BACKEND_PORT"
    echo "Panorama URL: $PANORAMA_URL"
    echo ""
    echo "Next Steps:"
    echo "1. Review Apache configuration: /etc/httpd/conf.d/panoruleauditor.conf"
    echo "2. Ensure SSL certificates are configured for panovision.sncorp.com"
    echo "3. Start the backend service: systemctl start ${APP_NAME}-backend"
    echo "4. Enable backend auto-start: systemctl enable ${APP_NAME}-backend"
    echo "5. Restart Apache: systemctl restart httpd"
    echo "6. Check backend status: systemctl status ${APP_NAME}-backend"
    echo "7. View backend logs: journalctl -u ${APP_NAME}-backend -f"
    echo "8. View Apache logs: tail -f /var/log/httpd/panoruleauditor_*.log"
    echo ""
    echo "Access the application at: https://panovision.sncorp.com/audit"
    echo ""
    echo "To update Panorama configuration, edit: $APP_DIR/.config"
    echo "Then restart the backend service: systemctl restart ${APP_NAME}-backend"
    echo "=========================================="
}

main() {
    if [[ $# -gt 0 ]]; then
        if [[ "$1" == "-h" || "$1" == "--help" ]]; then
            echo "Usage: $0 [SOURCE_DIRECTORY|--repo REPO_URL]"
            echo ""
            echo "Install PaloRuleAuditor application for Apache deployment"
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
    
    log "Starting installation of $APP_NAME for RHEL 9.7 with Apache"
    
    check_root
    install_system_dependencies
    install_nodejs
    create_app_user
    setup_application
    install_npm_dependencies
    setup_environment
    get_config
    update_backend_config
    
    log "Building application..."
    build_application
    
    create_backend_service
    configure_apache
    
    print_summary
}

main "$@"
