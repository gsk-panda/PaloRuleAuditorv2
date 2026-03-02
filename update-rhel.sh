#!/bin/bash

# PaloRuleAuditor v1.1.0 Update Script for RHEL
# This script updates the PaloRuleAuditor application to version 1.1.0

# Set colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to print colored messages
print_message() {
  echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: $1${NC}"
}

print_error() {
  echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1${NC}"
}

# Function to check if command succeeded
check_status() {
  if [ $? -ne 0 ]; then
    print_error "$1"
    exit 1
  fi
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  print_error "Please run as root"
  exit 1
fi

# Backup Apache configuration if it exists
if [ -f /etc/httpd/conf.d/panoruleauditor.conf ]; then
  print_message "Backing up current Apache configuration..."
  cp /etc/httpd/conf.d/panoruleauditor.conf /etc/httpd/conf.d/panoruleauditor.conf.bak
  check_status "Failed to backup Apache configuration"
  print_message "Apache configuration backed up to /etc/httpd/conf.d/panoruleauditor.conf.bak"
fi

# Stop the current service
print_message "Stopping PaloRuleAuditor service..."
systemctl stop panoruleauditor 2>/dev/null || true

# Remove container if it exists
print_message "Removing existing container..."
podman rm -f panoruleauditor 2>/dev/null || true

# Remove existing installation
print_message "Removing existing installation..."
if [ -d /opt/PaloRuleAuditorv2 ]; then
  rm -rf /opt/PaloRuleAuditorv2
  check_status "Failed to remove existing installation"
fi

# Clone the repository
print_message "Cloning PaloRuleAuditor v1.1.0..."
git clone https://github.com/gsk-panda/PaloRuleAuditorv2.git /opt/PaloRuleAuditorv2
check_status "Failed to clone repository"

# Checkout version 1.1.0
cd /opt/PaloRuleAuditorv2
git checkout v1.1.0
check_status "Failed to checkout version 1.1.0"

# Make the install script executable
chmod +x /opt/PaloRuleAuditorv2/install-apache-rhel9.sh
check_status "Failed to make install script executable"

# Update Apache configuration to disable timeouts while preserving URL structure
print_message "Updating Apache configuration to disable timeouts..."
cat > /etc/httpd/conf.d/panoruleauditor.conf << 'EOL'
# PaloRuleAuditor - add to Apache (e.g. in conf.d or Include in main config)
# URL path and backend port must match install-apache-rhel9.sh (URL_PATH, BACKEND_PORT)

# Global timeout settings to prevent GUI timeouts
Timeout 0
ProxyTimeout 0

<Location "/audit/api">
    ProxyPass http://127.0.0.1:3010/api
    ProxyPassReverse http://127.0.0.1:3010/api
    Require all granted
</Location>

Alias "/audit" "/var/www/html/audit"
<Directory "/var/www/html/audit">
    Options -Indexes +FollowSymLinks
    Require all granted
    AllowOverride None
</Directory>

# Logging configuration
ErrorLog /var/log/httpd/panoruleauditor-error.log
CustomLog /var/log/httpd/panoruleauditor-access.log combined
EOL
check_status "Failed to update Apache configuration"

# Run the installer
print_message "Running installer..."
cd /opt/PaloRuleAuditorv2
./install-apache-rhel9.sh
check_status "Installation failed"

# Restart Apache
print_message "Restarting Apache..."
systemctl restart httpd
check_status "Failed to restart Apache"

print_message "PaloRuleAuditor v1.1.0 has been successfully installed!"
print_message "You can access the application at http://your-server-address/"
print_message "If you encounter any issues, check the logs at /var/log/httpd/panoruleauditor-error.log"
