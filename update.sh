#!/bin/bash

set -e

APP_DIR="/opt/PaloRuleAuditor"
REPO_URL="https://github.com/gsk-panda/PaloRuleAuditorv2.git"

if [[ ! -d "$APP_DIR" ]]; then
    echo "Error: Application directory $APP_DIR does not exist"
    exit 1
fi

cd "$APP_DIR"

if [[ -d ".git" ]]; then
    echo "Updating from git repository..."
    git pull
else
    echo "Initializing git repository and updating..."
    git init
    git remote add origin "$REPO_URL" 2>/dev/null || git remote set-url origin "$REPO_URL"
    git fetch origin
    git reset --hard origin/main
fi

echo "Installing/updating npm dependencies..."
npm install

echo "Update complete!"
echo "Restart the service with: sudo systemctl restart panoruleauditor"
