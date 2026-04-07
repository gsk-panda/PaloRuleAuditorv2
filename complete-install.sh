#!/bin/bash

# Complete Installation Script for PaloRuleAuditor with SAML
# This script clones the repository and runs the SAML installation
# Usage: curl -sSL https://raw.githubusercontent.com/gsk-panda/PaloRuleAuditorv2/v1.1/complete-install.sh | sudo bash

set -e

REPO_URL="https://github.com/gsk-panda/PaloRuleAuditorv2.git"
BRANCH="v1.1"
INSTALL_DIR="/tmp/PaloRuleAuditor_install"
DOMAIN="panovision.sncorp.com"
URL_PATH="/audit"

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
    echo "  PaloRuleAuditor - Complete SAML Installation"
    echo "  Domain: $DOMAIN"
    echo "  URL: https://$DOMAIN$URL_PATH"
    echo "============================================================"
    echo ""
}

install_git() {
    if ! command -v git &> /dev/null; then
        log "Installing git..."
        dnf install -y git
    else
        log "Git already installed"
    fi
}

clone_repository() {
    log "Cloning repository from $REPO_URL (branch: $BRANCH)..."
    
    # Remove old install directory if it exists
    if [[ -d "$INSTALL_DIR" ]]; then
        log "Removing old installation directory..."
        rm -rf "$INSTALL_DIR"
    fi
    
    # Clone repository
    git clone -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    
    if [[ ! -d "$INSTALL_DIR" ]]; then
        error "Failed to clone repository"
    fi
    
    log "Repository cloned successfully"
}

run_saml_installation() {
    log "Running SAML installation script..."
    
    cd "$INSTALL_DIR"
    
    if [[ ! -f "install-saml-apache.sh" ]]; then
        error "install-saml-apache.sh not found in repository"
    fi
    
    chmod +x install-saml-apache.sh
    ./install-saml-apache.sh
}

cleanup() {
    log "Cleaning up temporary files..."
    if [[ -d "$INSTALL_DIR" ]]; then
        rm -rf "$INSTALL_DIR"
    fi
    log "Cleanup complete"
}

main() {
    check_root
    print_header
    
    log "Starting complete installation..."
    
    # Install dependencies
    install_git
    
    # Clone repository
    clone_repository
    
    # Run SAML installation
    run_saml_installation
    
    # Cleanup
    cleanup
    
    echo ""
    echo "============================================================"
    echo "  Installation Complete!"
    echo "============================================================"
    echo ""
    echo "Application URL: https://$DOMAIN$URL_PATH"
    echo ""
    echo "Next Steps:"
    echo "  1. Register SP with your Identity Provider"
    echo "     - SP Metadata: /etc/httpd/mellon/mellon_metadata.xml"
    echo "     - Entity ID: https://$DOMAIN$URL_PATH"
    echo "     - ACS URL: https://$DOMAIN/mellon/postResponse"
    echo ""
    echo "  2. Configure IdP metadata (if not done during install):"
    echo "     - Save IdP metadata to: /etc/httpd/mellon/idp_metadata.xml"
    echo "     - Restart Apache: systemctl restart httpd"
    echo ""
    echo "  3. Configure Panorama credentials:"
    echo "     - Edit: /opt/PaloRuleAuditor/.config"
    echo "     - Add: PANORAMA_URL and PANORAMA_API_KEY"
    echo "     - Restart: systemctl restart panoruleauditor-backend"
    echo ""
    echo "  4. Test the application:"
    echo "     - Open: https://$DOMAIN$URL_PATH"
    echo ""
    echo "For detailed documentation, see:"
    echo "  /opt/PaloRuleAuditor/SAML_DEPLOYMENT_GUIDE.md"
    echo ""
    echo "============================================================"
}

main "$@"
