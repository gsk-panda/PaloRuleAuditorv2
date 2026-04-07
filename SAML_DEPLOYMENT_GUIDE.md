# SAML-Protected Apache Deployment Guide (RHEL 9.7)

This guide covers deploying PaloRuleAuditor on RHEL 9.7 with Apache and SAML authentication at `https://panovision.sncorp.com/audit`.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Architecture Overview](#architecture-overview)
- [Installation Steps](#installation-steps)
- [SAML Configuration](#saml-configuration)
- [Apache Configuration](#apache-configuration)
- [Testing and Verification](#testing-and-verification)
- [Troubleshooting](#troubleshooting)
- [Maintenance](#maintenance)

## Prerequisites

### System Requirements

- **OS**: RHEL 9.7
- **Apache**: 2.4+ with mod_ssl enabled
- **Node.js**: 20.x (will be installed by script)
- **Domain**: `panovision.sncorp.com` with valid SSL certificate
- **SAML**: Identity Provider (IdP) configured and accessible

### Required Apache Modules

```bash
# Check if modules are enabled
httpd -M | grep -E 'proxy|ssl|auth_mellon'

# Required modules:
# - mod_ssl (for HTTPS)
# - mod_proxy (for backend proxying)
# - mod_proxy_http (for HTTP proxying)
# - mod_auth_mellon (for SAML authentication)
```

### Install mod_auth_mellon

```bash
# Install SAML authentication module
sudo dnf install -y mod_auth_mellon

# Verify installation
rpm -qa | grep mod_auth_mellon
```

### SSL Certificate

Ensure your SSL certificate is configured for `panovision.sncorp.com`:

```bash
# Typical locations:
# Certificate: /etc/pki/tls/certs/panovision.sncorp.com.crt
# Private Key: /etc/pki/tls/private/panovision.sncorp.com.key
# CA Chain: /etc/pki/tls/certs/ca-bundle.crt
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    User Browser                              │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Apache (panovision.sncorp.com)                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  mod_ssl (HTTPS termination)                         │   │
│  └────────────────────┬─────────────────────────────────┘   │
│                       │                                      │
│  ┌────────────────────▼─────────────────────────────────┐   │
│  │  mod_auth_mellon (SAML authentication)               │   │
│  │  - Protects /audit/* paths                           │   │
│  │  - Validates SAML assertions                         │   │
│  │  - Sets user attributes (REMOTE_USER, etc.)          │   │
│  └────────────────────┬─────────────────────────────────┘   │
│                       │                                      │
│       ┌───────────────┴────────────────┐                    │
│       │                                │                    │
│  ┌────▼─────────────┐      ┌──────────▼──────────────┐     │
│  │  Static Files    │      │  Proxy to Backend       │     │
│  │  /audit/         │      │  /audit/api/*           │     │
│  │  (React app)     │      │  → localhost:3010       │     │
│  └──────────────────┘      └─────────────┬───────────┘     │
└────────────────────────────────────────────┼───────────────┘
                                             │
                         ┌───────────────────▼───────────────┐
                         │  Node.js Backend (port 3010)      │
                         │  - Express API server             │
                         │  - Panorama integration           │
                         │  - Rule audit logic               │
                         └───────────────────────────────────┘
```

## Installation Steps

### Step 1: Run Base Installation

Use the existing installation script with the `/audit` path:

```bash
# Clone the repository (if not already done)
cd /tmp
git clone https://github.com/gsk-panda/PaloRuleAuditorv2.git
cd PaloRuleAuditorv2

# Make script executable
chmod +x install-apache-rhel9.sh

# Run installation
sudo ./install-apache-rhel9.sh --url-path /audit --web-root /var/www/html/audit --backend-port 3010
```

**What this does:**
- Installs Node.js 20
- Creates `panoruleauditor` user
- Installs application to `/opt/PaloRuleAuditor`
- Builds frontend with base path `/audit/`
- Deploys static files to `/var/www/html/audit`
- Creates systemd service `panoruleauditor-backend` on port 3010
- Writes basic Apache config to `/etc/httpd/conf.d/panoruleauditor.conf`

### Step 2: Configure Panorama Credentials

```bash
# Edit configuration file
sudo nano /opt/PaloRuleAuditor/.config

# Add your Panorama details:
PANORAMA_URL="https://your-panorama.example.com"
PANORAMA_API_KEY="your-api-key-here"

# Set permissions
sudo chown panoruleauditor:panoruleauditor /opt/PaloRuleAuditor/.config
sudo chmod 600 /opt/PaloRuleAuditor/.config
```

### Step 3: Verify Backend Service

```bash
# Check service status
sudo systemctl status panoruleauditor-backend

# View logs
sudo journalctl -u panoruleauditor-backend -f

# Restart if needed
sudo systemctl restart panoruleauditor-backend
```

## SAML Configuration

### Step 1: Generate Mellon Metadata

```bash
# Create directory for SAML metadata
sudo mkdir -p /etc/httpd/mellon
cd /etc/httpd/mellon

# Generate service provider metadata
# Replace panovision.sncorp.com with your actual domain
sudo /usr/libexec/mod_auth_mellon/mellon_create_metadata.sh \
    https://panovision.sncorp.com/audit \
    https://panovision.sncorp.com/mellon

# This creates three files:
# - https_panovision.sncorp.com_audit.cert (SP certificate)
# - https_panovision.sncorp.com_audit.key (SP private key)
# - https_panovision.sncorp.com_audit.xml (SP metadata)

# Rename for easier reference
sudo mv https_panovision.sncorp.com_audit.cert mellon.cert
sudo mv https_panovision.sncorp.com_audit.key mellon.key
sudo mv https_panovision.sncorp.com_audit.xml mellon_metadata.xml

# Set permissions
sudo chown apache:apache mellon.*
sudo chmod 600 mellon.key
sudo chmod 644 mellon.cert mellon_metadata.xml
```

### Step 2: Obtain IdP Metadata

You need to get the SAML metadata from your Identity Provider (IdP). This is typically:

**Option A: Download from IdP URL**
```bash
# If your IdP provides a metadata URL
sudo curl -o /etc/httpd/mellon/idp_metadata.xml https://your-idp.example.com/metadata

# Set permissions
sudo chown apache:apache /etc/httpd/mellon/idp_metadata.xml
sudo chmod 644 /etc/httpd/mellon/idp_metadata.xml
```

**Option B: Manually create from IdP details**
```bash
# Create file with IdP metadata provided by your SAML administrator
sudo nano /etc/httpd/mellon/idp_metadata.xml

# Paste the IdP metadata XML
# Set permissions
sudo chown apache:apache /etc/httpd/mellon/idp_metadata.xml
sudo chmod 644 /etc/httpd/mellon/idp_metadata.xml
```

### Step 3: Register SP with IdP

Provide your SP metadata to your SAML administrator:

```bash
# Display SP metadata
sudo cat /etc/httpd/mellon/mellon_metadata.xml
```

**Information to provide:**
- **Entity ID**: `https://panovision.sncorp.com/audit`
- **ACS URL**: `https://panovision.sncorp.com/mellon/postResponse`
- **SP Metadata**: Contents of `mellon_metadata.xml`

**Request these attributes from IdP:**
- `uid` or `username` (for user identification)
- `email` (optional, for audit logging)
- `displayName` (optional, for UI display)

## Apache Configuration

### Step 1: Update Main Apache Config

Edit the panoruleauditor config to add SAML protection:

```bash
sudo nano /etc/httpd/conf.d/panoruleauditor.conf
```

Replace the contents with:

```apache
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
    
    # SAML configuration (inherited from /mellon)
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
    
    # Optional: Require specific attribute values
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
    # SAML protection inherited from /audit
    
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
    # SAML protection inherited from /audit
    
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
```

### Step 2: Configure SSL Virtual Host

Ensure your SSL virtual host is properly configured:

```bash
sudo nano /etc/httpd/conf.d/ssl.conf
```

Add or verify:

```apache
<VirtualHost *:443>
    ServerName panovision.sncorp.com
    
    # SSL Configuration
    SSLEngine on
    SSLCertificateFile /etc/pki/tls/certs/panovision.sncorp.com.crt
    SSLCertificateKeyFile /etc/pki/tls/private/panovision.sncorp.com.key
    SSLCertificateChainFile /etc/pki/tls/certs/ca-bundle.crt
    
    # Modern SSL configuration
    SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1
    SSLCipherSuite HIGH:!aNULL:!MD5
    SSLHonorCipherOrder on
    
    # Security headers
    Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
    Header always set X-Frame-Options "SAMEORIGIN"
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-XSS-Protection "1; mode=block"
    
    # Include PaloRuleAuditor config
    # (This is automatically loaded from conf.d/panoruleauditor.conf)
    
    # Logging
    ErrorLog logs/panovision_error.log
    CustomLog logs/panovision_access.log combined
</VirtualHost>
```

### Step 3: Enable Required Apache Modules

```bash
# Check current modules
httpd -M | grep -E 'proxy|ssl|auth_mellon|rewrite|headers'

# Modules should show:
# - proxy_module
# - proxy_http_module
# - ssl_module
# - auth_mellon_module
# - rewrite_module
# - headers_module

# If any are missing, ensure they're loaded in /etc/httpd/conf.modules.d/
```

### Step 4: Test Apache Configuration

```bash
# Test configuration syntax
sudo apachectl configtest

# Should output: Syntax OK

# If errors, review and fix before proceeding
```

### Step 5: Restart Apache

```bash
# Restart Apache to apply changes
sudo systemctl restart httpd

# Check status
sudo systemctl status httpd

# View logs for any errors
sudo tail -f /var/log/httpd/error_log
```

## Testing and Verification

### Step 1: Test Backend Service

```bash
# Check if backend is running
curl http://localhost:3010/health

# Should return: {"status":"ok"}
```

### Step 2: Test SAML Authentication

1. **Open browser** and navigate to:
   ```
   https://panovision.sncorp.com/audit
   ```

2. **Expected flow:**
   - Redirected to IdP login page
   - Enter credentials
   - Redirected back to `/audit` with SAML assertion
   - Application loads successfully

3. **Check SAML attributes:**
   ```bash
   # View Apache access logs to see SAML attributes
   sudo tail -f /var/log/httpd/access_log
   ```

### Step 3: Test Application Functionality

1. **Test Panorama connection:**
   - Click "Test Connection" in the UI
   - Should successfully connect to Panorama

2. **Run audit:**
   - Configure audit parameters
   - Click "Generate Dry Run Report"
   - Verify results display correctly

3. **Check backend logs:**
   ```bash
   sudo journalctl -u panoruleauditor-backend -f
   ```

### Step 4: Verify User Information

The backend can access SAML user information via headers:

```bash
# Check if headers are being passed
sudo journalctl -u panoruleauditor-backend | grep "X-Remote-User"
```

## Troubleshooting

### SAML Authentication Issues

**Problem: Redirect loop to IdP**
```bash
# Check Mellon configuration
sudo cat /etc/httpd/conf.d/panoruleauditor.conf | grep -A 10 "MellonEnable"

# Verify metadata files exist
ls -la /etc/httpd/mellon/

# Check Apache error log
sudo tail -f /var/log/httpd/error_log | grep -i mellon
```

**Problem: "Invalid SAML Response"**
```bash
# Check time synchronization (critical for SAML)
timedatectl status

# Sync time if needed
sudo chronyc makestep

# Verify IdP metadata is correct
sudo cat /etc/httpd/mellon/idp_metadata.xml
```

**Problem: "Access Denied" after successful login**
```bash
# Check if user meets MellonCond requirements
# Review /etc/httpd/conf.d/panoruleauditor.conf
# Temporarily remove MellonCond lines for testing

# Check SAML attributes being received
sudo grep -i "mellon" /var/log/httpd/error_log
```

### Backend Connection Issues

**Problem: 502 Bad Gateway**
```bash
# Check backend service
sudo systemctl status panoruleauditor-backend

# Check if backend is listening
sudo netstat -tlnp | grep 3010

# Check backend logs
sudo journalctl -u panoruleauditor-backend -n 50

# Restart backend
sudo systemctl restart panoruleauditor-backend
```

**Problem: API calls fail**
```bash
# Test backend directly (from server)
curl http://localhost:3010/health

# Check proxy configuration
sudo cat /etc/httpd/conf.d/panoruleauditor.conf | grep -A 5 "ProxyPass"

# Check SELinux (may block proxy)
sudo getsebool httpd_can_network_connect
# If off, enable it:
sudo setsebool -P httpd_can_network_connect on
```

### SSL/HTTPS Issues

**Problem: SSL certificate errors**
```bash
# Verify certificate
sudo openssl x509 -in /etc/pki/tls/certs/panovision.sncorp.com.crt -text -noout

# Check certificate matches domain
sudo openssl x509 -in /etc/pki/tls/certs/panovision.sncorp.com.crt -noout -subject

# Test SSL configuration
sudo openssl s_client -connect panovision.sncorp.com:443 -servername panovision.sncorp.com
```

### File Permission Issues

**Problem: 403 Forbidden**
```bash
# Check static file permissions
ls -la /var/www/html/audit/

# Fix if needed
sudo chown -R apache:apache /var/www/html/audit
sudo chmod -R 755 /var/www/html/audit

# Check SELinux context
ls -Z /var/www/html/audit/
sudo restorecon -R /var/www/html/audit
```

### Firewall Issues

**Problem: Cannot access from external network**
```bash
# Check firewall rules
sudo firewall-cmd --list-all

# Open HTTPS if needed
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload

# Verify port is open
sudo ss -tlnp | grep :443
```

## Maintenance

### Updating the Application

```bash
# Stop backend
sudo systemctl stop panoruleauditor-backend

# Backup current installation
sudo cp -r /opt/PaloRuleAuditor /opt/PaloRuleAuditor.backup.$(date +%Y%m%d)

# Pull latest code
cd /opt/PaloRuleAuditor
sudo -u panoruleauditor git pull origin main

# Install dependencies
sudo -u panoruleauditor npm install

# Rebuild frontend
cd /opt/PaloRuleAuditor
export VITE_BASE_PATH="/audit/"
sudo -u panoruleauditor npm run build

# Rebuild backend
sudo -u panoruleauditor npm run build:server

# Deploy static files
sudo rm -rf /var/www/html/audit/*
sudo cp -r /opt/PaloRuleAuditor/dist/* /var/www/html/audit/
sudo chown -R apache:apache /var/www/html/audit

# Restart backend
sudo systemctl start panoruleauditor-backend

# Reload Apache
sudo systemctl reload httpd
```

### Monitoring

**Check service health:**
```bash
# Backend status
sudo systemctl status panoruleauditor-backend

# Apache status
sudo systemctl status httpd

# View logs
sudo journalctl -u panoruleauditor-backend -f
sudo tail -f /var/log/httpd/error_log
sudo tail -f /var/log/httpd/access_log
```

**Monitor disk usage:**
```bash
# Check application directory
du -sh /opt/PaloRuleAuditor

# Check static files
du -sh /var/www/html/audit

# Check logs
du -sh /var/log/httpd
```

### Backup and Restore

**Backup:**
```bash
# Create backup directory
sudo mkdir -p /backup/panoruleauditor

# Backup application
sudo tar -czf /backup/panoruleauditor/app-$(date +%Y%m%d).tar.gz /opt/PaloRuleAuditor

# Backup configuration
sudo cp /opt/PaloRuleAuditor/.config /backup/panoruleauditor/config-$(date +%Y%m%d)
sudo cp /etc/httpd/conf.d/panoruleauditor.conf /backup/panoruleauditor/apache-$(date +%Y%m%d).conf

# Backup SAML metadata
sudo tar -czf /backup/panoruleauditor/saml-$(date +%Y%m%d).tar.gz /etc/httpd/mellon
```

**Restore:**
```bash
# Stop services
sudo systemctl stop panoruleauditor-backend
sudo systemctl stop httpd

# Restore application
sudo tar -xzf /backup/panoruleauditor/app-YYYYMMDD.tar.gz -C /

# Restore configuration
sudo cp /backup/panoruleauditor/config-YYYYMMDD /opt/PaloRuleAuditor/.config
sudo cp /backup/panoruleauditor/apache-YYYYMMDD.conf /etc/httpd/conf.d/panoruleauditor.conf

# Restore SAML metadata
sudo tar -xzf /backup/panoruleauditor/saml-YYYYMMDD.tar.gz -C /

# Fix permissions
sudo chown -R panoruleauditor:panoruleauditor /opt/PaloRuleAuditor
sudo chown -R apache:apache /etc/httpd/mellon

# Start services
sudo systemctl start panoruleauditor-backend
sudo systemctl start httpd
```

### Security Considerations

1. **Keep certificates updated:**
   - Monitor SSL certificate expiration
   - Renew before expiry
   - Update Apache configuration if paths change

2. **Regular updates:**
   - Keep RHEL updated: `sudo dnf update`
   - Update Node.js packages: `npm audit fix`
   - Monitor security advisories

3. **Access control:**
   - Review SAML attribute requirements regularly
   - Use MellonCond to restrict access by group/role
   - Monitor access logs for suspicious activity

4. **Secrets management:**
   - Keep `/opt/PaloRuleAuditor/.config` secure (chmod 600)
   - Rotate Panorama API keys regularly
   - Protect SAML private key (`mellon.key`)

5. **Audit logging:**
   - Enable detailed Apache logging
   - Monitor backend logs for errors
   - Set up log rotation to prevent disk fill

## Additional Resources

- **mod_auth_mellon documentation**: https://github.com/latchset/mod_auth_mellon
- **Apache mod_proxy**: https://httpd.apache.org/docs/2.4/mod/mod_proxy.html
- **SAML 2.0 specification**: http://docs.oasis-open.org/security/saml/

## Support

For issues specific to:
- **PaloRuleAuditor**: Check GitHub issues or application logs
- **SAML/mod_auth_mellon**: Review Apache error logs and mod_auth_mellon documentation
- **Apache configuration**: Check Apache documentation and RHEL support
- **Network/SSL**: Contact your network/security team

## Quick Reference Commands

```bash
# Service management
sudo systemctl status panoruleauditor-backend
sudo systemctl restart panoruleauditor-backend
sudo systemctl status httpd
sudo systemctl restart httpd

# View logs
sudo journalctl -u panoruleauditor-backend -f
sudo tail -f /var/log/httpd/error_log
sudo tail -f /var/log/httpd/access_log

# Test configuration
sudo apachectl configtest
curl http://localhost:3010/health

# Check SAML metadata
ls -la /etc/httpd/mellon/
sudo cat /etc/httpd/mellon/mellon_metadata.xml

# Monitor processes
sudo ps aux | grep node
sudo ps aux | grep httpd
sudo netstat -tlnp | grep -E '3010|443'
```
