#!/bin/bash

# SAML-Protected Apache Installation Script for RHEL 9.7
# Deploys PaloRuleAuditor at https://panovision.sncorp.com/audit with SAML authentication

set -e

DOMAIN="panovision.sncorp.com"
URL_PATH="/audit"
WEB_ROOT="/var/www/html/audit"
BACKEND_PORT="3010"
APP_DIR="/opt/PaloRuleAuditor"
MELLON_DIR="/etc/httpd/mellon"

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

print_header() {
    echo ""
    echo "============================================================"
    echo "  PaloRuleAuditor - SAML-Protected Apache Installation"
    echo "  Domain: $DOMAIN"
    echo "  URL: https://$DOMAIN$URL_PATH"
    echo "============================================================"
    echo ""
}

install_mod_auth_mellon() {
    log "Installing mod_auth_mellon for SAML authentication..."
    
    if rpm -qa | grep -q mod_auth_mellon; then
        log "mod_auth_mellon already installed"
    else
        dnf install -y mod_auth_mellon
        log "mod_auth_mellon installed"
    fi
    
    # Verify installation
    if ! httpd -M 2>/dev/null | grep -q auth_mellon; then
        error "mod_auth_mellon not loaded. Check Apache configuration."
    fi
    
    log "mod_auth_mellon is loaded and ready"
}

run_base_installation() {
    log "Running base Apache installation..."
    
    if [[ ! -f "./install-apache-rhel9.sh" ]]; then
        error "install-apache-rhel9.sh not found. Run this script from the repository root."
    fi
    
    chmod +x ./install-apache-rhel9.sh
    ./install-apache-rhel9.sh --url-path "$URL_PATH" --web-root "$WEB_ROOT" --backend-port "$BACKEND_PORT"
    
    log "Base installation completed"
}

setup_mellon_metadata() {
    log "Setting up SAML metadata directory..."
    
    mkdir -p "$MELLON_DIR"
    cd "$MELLON_DIR"
    
    if [[ -f "mellon.key" && -f "mellon.cert" && -f "mellon_metadata.xml" ]]; then
        log "Mellon metadata already exists. Skipping generation."
        log "To regenerate, delete files in $MELLON_DIR and run again."
        return
    fi
    
    log "Generating Service Provider metadata..."
    
    # Generate SP metadata
    /usr/libexec/mod_auth_mellon/mellon_create_metadata.sh \
        "https://${DOMAIN}${URL_PATH}" \
        "https://${DOMAIN}/mellon"
    
    # Rename files for easier reference
    mv "https_${DOMAIN}_${URL_PATH//\//_}.cert" mellon.cert 2>/dev/null || true
    mv "https_${DOMAIN}_${URL_PATH//\//_}.key" mellon.key 2>/dev/null || true
    mv "https_${DOMAIN}_${URL_PATH//\//_}.xml" mellon_metadata.xml 2>/dev/null || true
    
    # Alternative naming pattern
    mv "https_${DOMAIN}_mellon.cert" mellon.cert 2>/dev/null || true
    mv "https_${DOMAIN}_mellon.key" mellon.key 2>/dev/null || true
    mv "https_${DOMAIN}_mellon.xml" mellon_metadata.xml 2>/dev/null || true
    
    # Set permissions
    chown apache:apache mellon.*
    chmod 600 mellon.key
    chmod 644 mellon.cert mellon_metadata.xml 2>/dev/null || true
    
    log "Service Provider metadata generated"
    log "SP metadata location: $MELLON_DIR/mellon_metadata.xml"
}

prompt_idp_metadata() {
    log "IdP metadata configuration..."
    
    if [[ -f "$MELLON_DIR/idp_metadata.xml" ]]; then
        log "IdP metadata already exists at $MELLON_DIR/idp_metadata.xml"
        read -p "Do you want to replace it? (y/N): " replace
        if [[ ! "$replace" =~ ^[Yy]$ ]]; then
            return
        fi
    fi
    
    echo ""
    echo "You need to provide your Identity Provider (IdP) metadata."
    echo "Choose one of the following options:"
    echo ""
    echo "1. Download from IdP metadata URL"
    echo "2. Paste metadata XML content"
    echo "3. Skip (configure manually later)"
    echo ""
    read -p "Select option (1-3): " option
    
    case $option in
        1)
            read -p "Enter IdP metadata URL: " idp_url
            if [[ -n "$idp_url" ]]; then
                curl -f -o "$MELLON_DIR/idp_metadata.xml" "$idp_url" || error "Failed to download IdP metadata"
                chown apache:apache "$MELLON_DIR/idp_metadata.xml"
                chmod 644 "$MELLON_DIR/idp_metadata.xml"
                log "IdP metadata downloaded successfully"
            fi
            ;;
        2)
            echo "Paste IdP metadata XML (press Ctrl+D when done):"
            cat > "$MELLON_DIR/idp_metadata.xml"
            chown apache:apache "$MELLON_DIR/idp_metadata.xml"
            chmod 644 "$MELLON_DIR/idp_metadata.xml"
            log "IdP metadata saved"
            ;;
        3)
            log "Skipping IdP metadata configuration"
            log "You must manually create $MELLON_DIR/idp_metadata.xml before SAML will work"
            ;;
        *)
            log "Invalid option. Skipping IdP metadata configuration"
            ;;
    esac
}

create_saml_apache_config() {
    log "Creating SAML-protected Apache configuration..."
    
    local conf_file="/etc/httpd/conf.d/panoruleauditor.conf"
    
    # Backup existing config
    if [[ -f "$conf_file" ]]; then
        cp "$conf_file" "${conf_file}.backup.$(date +%Y%m%d_%H%M%S)"
        log "Backed up existing config to ${conf_file}.backup.*"
    fi
    
    cat > "$conf_file" << 'EOF'
# PaloRuleAuditor with SAML Authentication
# URL: https://panovision.sncorp.com/audit

# ============================================================================
# SAML Authentication Configuration (mod_auth_mellon)
# ============================================================================

# Mellon endpoint for SAML operations
<Location /mellon>
    MellonEnable "info"
    MellonSPPrivateKeyFile /etc/httpd/mellon/mellon.key
    MellonSPCertFile /etc/httpd/mellon/mellon.cert
    MellonSPMetadataFile /etc/httpd/mellon/mellon_metadata.xml
    MellonIdPMetadataFile /etc/httpd/mellon/idp_metadata.xml
    MellonEndpointPath /mellon
    MellonVariable "cookie"
    MellonSecureCookie On
    MellonCookieSameSite None
    Order allow,deny
    Allow from all
</Location>

# ============================================================================
# Protected Application Paths
# ============================================================================

# Protect the entire /audit application with SAML
<Location /audit>
    # Enable SAML authentication
    MellonEnable "auth"
    
    # SAML configuration
    MellonSPPrivateKeyFile /etc/httpd/mellon/mellon.key
    MellonSPCertFile /etc/httpd/mellon/mellon.cert
    MellonSPMetadataFile /etc/httpd/mellon/mellon_metadata.xml
    MellonIdPMetadataFile /etc/httpd/mellon/idp_metadata.xml
    MellonEndpointPath /mellon
    MellonVariable "cookie"
    MellonSecureCookie On
    MellonCookieSameSite None
    
    # Require valid SAML session
    Require valid-user
    
    # Optional: Uncomment to require specific groups/roles
    # MellonCond "groups" "panorama-admins" [OR]
    # MellonCond "roles" "firewall-auditor" [OR]
    
    # Set environment variables from SAML attributes
    MellonSetEnv "username" "uid"
    MellonSetEnv "email" "email"
    MellonSetEnv "displayName" "displayName"
</Location>

# ============================================================================
# Backend API Proxy (also SAML-protected)
# ============================================================================

<Location /audit/api>
    # Proxy to Node.js backend
    ProxyPass http://127.0.0.1:3010/api
    ProxyPassReverse http://127.0.0.1:3010/api
    ProxyTimeout 3600
    
    # Pass SAML user information to backend
    RequestHeader set X-Remote-User "%{MELLON_username}e"
    RequestHeader set X-Remote-Email "%{MELLON_email}e"
    RequestHeader set X-Remote-DisplayName "%{MELLON_displayName}e"
    
    # Allow authenticated users
    Require valid-user
</Location>

# ============================================================================
# Static Frontend Files
# ============================================================================

Alias /audit /var/www/html/audit
<Directory /var/www/html/audit>
    Options -Indexes +FollowSymLinks
    AllowOverride None
    
    # Allow authenticated users
    Require valid-user
    
    # Handle React Router (SPA routing)
    <IfModule mod_rewrite.c>
        RewriteEngine On
        RewriteBase /audit/
        RewriteRule ^index\.html$ - [L]
        RewriteCond %{REQUEST_FILENAME} !-f
        RewriteCond %{REQUEST_FILENAME} !-d
        RewriteRule . /audit/index.html [L]
    </IfModule>
</Directory>
EOF
    
    log "SAML-protected Apache configuration created"
}

enable_selinux_httpd_network() {
    if command -v getenforce &>/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
        log "Enabling SELinux boolean for Apache network connections..."
        setsebool -P httpd_can_network_connect on
        log "SELinux configured for Apache proxy"
    fi
}

test_apache_config() {
    log "Testing Apache configuration..."
    
    if apachectl configtest 2>&1 | grep -q "Syntax OK"; then
        log "Apache configuration test passed"
        return 0
    else
        error "Apache configuration test failed. Run 'apachectl configtest' for details."
    fi
}

restart_services() {
    log "Restarting services..."
    
    # Restart backend
    systemctl restart panoruleauditor-backend
    log "Backend service restarted"
    
    # Restart Apache
    systemctl restart httpd
    log "Apache restarted"
    
    # Enable services on boot
    systemctl enable panoruleauditor-backend
    systemctl enable httpd
    log "Services enabled for automatic startup"
}

print_summary() {
    echo ""
    echo "============================================================"
    echo "  Installation Complete!"
    echo "============================================================"
    echo ""
    echo "Application URL: https://$DOMAIN$URL_PATH"
    echo ""
    echo "Service Provider (SP) Metadata:"
    echo "  Location: $MELLON_DIR/mellon_metadata.xml"
    echo "  Entity ID: https://$DOMAIN$URL_PATH"
    echo "  ACS URL: https://$DOMAIN/mellon/postResponse"
    echo ""
    
    if [[ -f "$MELLON_DIR/idp_metadata.xml" ]]; then
        echo "IdP Metadata: Configured ✓"
    else
        echo "IdP Metadata: NOT CONFIGURED ✗"
        echo "  Action required: Create $MELLON_DIR/idp_metadata.xml"
    fi
    
    echo ""
    echo "Next Steps:"
    echo "  1. Register SP with your Identity Provider:"
    echo "     - Provide SP metadata: $MELLON_DIR/mellon_metadata.xml"
    echo "     - Entity ID: https://$DOMAIN$URL_PATH"
    echo "     - ACS URL: https://$DOMAIN/mellon/postResponse"
    echo ""
    
    if [[ ! -f "$MELLON_DIR/idp_metadata.xml" ]]; then
        echo "  2. Configure IdP metadata:"
        echo "     - Download or obtain IdP metadata XML"
        echo "     - Save to: $MELLON_DIR/idp_metadata.xml"
        echo "     - Set permissions: chown apache:apache idp_metadata.xml"
        echo "     - Restart Apache: systemctl restart httpd"
        echo ""
    fi
    
    echo "  3. Configure Panorama credentials:"
    echo "     - Edit: $APP_DIR/.config"
    echo "     - Add: PANORAMA_URL and PANORAMA_API_KEY"
    echo "     - Restart: systemctl restart panoruleauditor-backend"
    echo ""
    echo "  4. Test the application:"
    echo "     - Open: https://$DOMAIN$URL_PATH"
    echo "     - You should be redirected to IdP login"
    echo "     - After login, application should load"
    echo ""
    echo "Service Management:"
    echo "  Backend: systemctl status panoruleauditor-backend"
    echo "  Apache:  systemctl status httpd"
    echo "  Logs:    journalctl -u panoruleauditor-backend -f"
    echo "           tail -f /var/log/httpd/error_log"
    echo ""
    echo "Troubleshooting:"
    echo "  See: SAML_DEPLOYMENT_GUIDE.md"
    echo "  Test config: apachectl configtest"
    echo "  Backend health: curl http://localhost:3010/health"
    echo ""
    echo "============================================================"
}

main() {
    check_root
    print_header
    
    log "Starting SAML-protected installation..."
    
    # Install mod_auth_mellon
    install_mod_auth_mellon
    
    # Run base installation
    run_base_installation
    
    # Setup SAML
    setup_mellon_metadata
    prompt_idp_metadata
    create_saml_apache_config
    
    # Configure system
    enable_selinux_httpd_network
    
    # Test and restart
    test_apache_config
    restart_services
    
    # Show summary
    print_summary
}

main "$@"
