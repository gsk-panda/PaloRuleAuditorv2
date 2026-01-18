# Updating an Existing Deployment

This guide explains how to update an existing PaloRuleAuditor installation with the latest changes from the repository.

## Prerequisites

- Existing installation at `/opt/PaloRuleAuditor`
- Service name: `panoruleauditor`
- Application user: `panoruleauditor`
- Root/sudo access

## Update Process

### Method 1: Using Git Pull (Recommended)

If the installation was cloned from git, you can update directly:

```bash
# 1. Stop the service
sudo systemctl stop panoruleauditor

# 2. Navigate to application directory
cd /opt/PaloRuleAuditor

# 3. Backup current installation (optional but recommended)
sudo -u panoruleauditor cp -r /opt/PaloRuleAuditor /opt/PaloRuleAuditor.backup.$(date +%Y%m%d_%H%M%S)

# 4. Pull latest changes
sudo -u panoruleauditor git pull origin main

# 5. Install any new dependencies
sudo -u panoruleauditor npm install

# 6. Rebuild application (if needed)
sudo -u panoruleauditor npm run build

# 7. Start the service
sudo systemctl start panoruleauditor

# 8. Check service status
sudo systemctl status panoruleauditor

# 9. View logs to verify it's running correctly
sudo journalctl -u panoruleauditor -f
```

### Method 2: Fresh Clone (If Git Pull Fails)

If the installation wasn't set up with git or pull fails:

```bash
# 1. Stop the service
sudo systemctl stop panoruleauditor

# 2. Backup current installation
sudo cp -r /opt/PaloRuleAuditor /opt/PaloRuleAuditor.backup.$(date +%Y%m%d_%H%M%S)

# 3. Clone fresh copy to temporary location
sudo -u panoruleauditor git clone https://github.com/gsk-panda/PaloRuleAuditorv2.git /tmp/PaloRuleAuditor_update

# 4. Copy new files (preserving .env.local)
sudo -u panoruleauditor cp /opt/PaloRuleAuditor/.env.local /tmp/PaloRuleAuditor_update/.env.local 2>/dev/null || true
sudo rm -rf /opt/PaloRuleAuditor/*
sudo -u panoruleauditor cp -r /tmp/PaloRuleAuditor_update/* /opt/PaloRuleAuditor/
sudo rm -rf /tmp/PaloRuleAuditor_update

# 5. Restore ownership
sudo chown -R panoruleauditor:panoruleauditor /opt/PaloRuleAuditor

# 6. Install dependencies
cd /opt/PaloRuleAuditor
sudo -u panoruleauditor npm install

# 7. Rebuild application
sudo -u panoruleauditor npm run build

# 8. Start the service
sudo systemctl start panoruleauditor

# 9. Check status
sudo systemctl status panoruleauditor
```

### Method 3: Using the Install Script (Full Reinstall)

If you want a clean reinstall:

```bash
# 1. Stop the service
sudo systemctl stop panoruleauditor

# 2. Backup configuration
sudo cp /opt/PaloRuleAuditor/.env.local /root/panoruleauditor.env.backup 2>/dev/null || true

# 3. Run install script (it will remove old installation)
sudo bash install-rhel9.sh

# 4. Restore configuration
sudo cp /root/panoruleauditor.env.backup /opt/PaloRuleAuditor/.env.local 2>/dev/null || true
sudo chown panoruleauditor:panoruleauditor /opt/PaloRuleAuditor/.env.local
sudo chmod 600 /opt/PaloRuleAuditor/.env.local

# 5. Start the service
sudo systemctl start panoruleauditor
```

## Verification Steps

After updating, verify the installation:

```bash
# 1. Check service is running
sudo systemctl status panoruleauditor

# 2. Check logs for errors
sudo journalctl -u panoruleauditor -n 50

# 3. Test the application
curl http://localhost:3000

# 4. Verify version/features
# Check the application UI to confirm new features are available
```

## Troubleshooting

### Service Won't Start

```bash
# Check logs for errors
sudo journalctl -u panoruleauditor -n 100

# Common issues:
# - Missing dependencies: Run `npm install` again
# - Port already in use: Check if another process is using port 3000
# - Permission issues: Verify ownership with `ls -la /opt/PaloRuleAuditor`
```

### Git Pull Conflicts

If you have local modifications that conflict:

```bash
# Option 1: Discard local changes (if you don't need them)
cd /opt/PaloRuleAuditor
sudo -u panoruleauditor git reset --hard origin/main
sudo -u panoruleauditor git pull

# Option 2: Stash local changes
cd /opt/PaloRuleAuditor
sudo -u panoruleauditor git stash
sudo -u panoruleauditor git pull
sudo -u panoruleauditor git stash pop  # Apply your changes back
```

### Missing Dependencies

```bash
cd /opt/PaloRuleAuditor
sudo -u panoruleauditor rm -rf node_modules package-lock.json
sudo -u panoruleauditor npm install
```

### Build Errors

```bash
cd /opt/PaloRuleAuditor
sudo -u panoruleauditor npm run build

# If build fails, check:
# - Node.js version: `node --version` (should be 20+)
# - npm version: `npm --version`
# - Disk space: `df -h`
```

## What Changed in This Update

This update includes:

- **Performance Optimization**: Batched API calls for rule hit counts
  - All rules in a device group are now queried in a single API call
  - Reduces API calls by ~90% for typical deployments
  - Significantly faster audit execution

- **Code Improvements**:
  - Refactored `auditPanoramaRules()` to batch queries
  - Refactored `auditDisabledRules()` to batch queries
  - Updated preview endpoint to show batched structure

- **Documentation Updates**:
  - Updated README.md with performance metrics
  - Updated TECHNICAL_DOCUMENTATION.md with API call counts
  - Added performance comparison data

## Rollback Procedure

If you need to rollback to the previous version:

```bash
# 1. Stop the service
sudo systemctl stop panoruleauditor

# 2. Restore from backup
sudo rm -rf /opt/PaloRuleAuditor
sudo cp -r /opt/PaloRuleAuditor.backup.* /opt/PaloRuleAuditor
sudo chown -R panoruleauditor:panoruleauditor /opt/PaloRuleAuditor

# 3. Start the service
sudo systemctl start panoruleauditor
```

## Automated Update Script

You can create a simple update script:

```bash
#!/bin/bash
# Save as: /usr/local/bin/update-panoruleauditor.sh

set -e

echo "Stopping panoruleauditor service..."
sudo systemctl stop panoruleauditor

echo "Backing up current installation..."
sudo -u panoruleauditor cp -r /opt/PaloRuleAuditor /opt/PaloRuleAuditor.backup.$(date +%Y%m%d_%H%M%S)

echo "Updating from git..."
cd /opt/PaloRuleAuditor
sudo -u panoruleauditor git pull origin main

echo "Installing dependencies..."
sudo -u panoruleauditor npm install

echo "Rebuilding application..."
sudo -u panoruleauditor npm run build

echo "Starting service..."
sudo systemctl start panoruleauditor

echo "Checking status..."
sleep 2
sudo systemctl status panoruleauditor --no-pager

echo "Update complete!"
```

Make it executable:
```bash
sudo chmod +x /usr/local/bin/update-panoruleauditor.sh
```

Then run updates with:
```bash
sudo /usr/local/bin/update-panoruleauditor.sh
```
