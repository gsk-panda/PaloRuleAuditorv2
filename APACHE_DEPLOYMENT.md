# Apache Deployment (RHEL 9)

Deploy PaloRuleAuditor behind an existing Apache server so the app is served at a URL path (e.g. `https://yourserver/audit/`).

## Quick install

On a RHEL 9 server with Apache already running:

```bash
sudo chmod +x install-apache-rhel9.sh
sudo ./install-apache-rhel9.sh
```

The script will:

- Install Node.js 20 if needed
- Create user `panoruleauditor` and install the app under `/opt/PaloRuleAuditor`
- Build the frontend with base path `/audit/`
- Deploy static files to `/var/www/html/audit`
- Create systemd service `panoruleauditor-backend` (port 3010)
- Write Apache config to `/etc/httpd/conf.d/panoruleauditor.conf`
- Optionally prompt for Panorama URL and API key (or configure later in the UI)

Then reload Apache and open `https://YOUR_SERVER/audit/`:

```bash
sudo systemctl reload httpd
```

## Options

```bash
sudo ./install-apache-rhel9.sh --help
```

- `--url-path PATH`   URL path (default: `/audit`)
- `--web-root PATH`   Directory for static files (default: `/var/www/html/audit`)
- `--backend-port N`  Backend port (default: `3010`)

Example with a different path:

```bash
sudo ./install-apache-rhel9.sh --url-path /panorama-audit --web-root /var/www/html/panorama-audit
```

Then add the same config with `/panorama-audit` and the chosen web root (the script will write it based on these options).

## Adding the config to an existing Apache setup

If you prefer not to use `conf.d`, add the snippet below to your vhost or main config. The install script also writes this to `/etc/httpd/conf.d/panoruleauditor.conf`.

### 1. Enable proxy modules

RHEL 9 httpd usually has these in `/etc/httpd/conf.modules.d/`. Ensure they are loaded:

```apache
LoadModule proxy_module modules/mod_proxy.so
LoadModule proxy_http_module modules/mod_proxy_http.so
```

### 2. Include the snippet

Copy `apache-panoruleauditor.conf` into your config tree and include it, or paste the block below. Adjust paths and port if you changed them at install time.

```apache
# Proxy API to Node backend
<Location "/audit/api">
    ProxyPass http://127.0.0.1:3010/api
    ProxyPassReverse http://127.0.0.1:3010/api
    Require all granted
</Location>

# Static frontend
Alias "/audit" "/var/www/html/audit"
<Directory "/var/www/html/audit">
    Options -Indexes +FollowSymLinks
    Require all granted
    AllowOverride None
</Directory>
```

### 3. Reload Apache

```bash
sudo apachectl configtest
sudo systemctl reload httpd
```

## Panorama configuration

- During install you can enter Panorama URL and API key when prompted; they are stored in `/opt/PaloRuleAuditor/.config`.
- Or leave them blank and set them in the web UI at `https://YOUR_SERVER/audit/`.
- To change later: edit `/opt/PaloRuleAuditor/.config` and restart the backend:

  ```bash
  sudo systemctl restart panoruleauditor-backend
  ```

## Service management

| Action        | Command |
|--------------|--------|
| Start backend | `sudo systemctl start panoruleauditor-backend` |
| Stop backend  | `sudo systemctl stop panoruleauditor-backend` |
| Logs          | `journalctl -u panoruleauditor-backend -f` |
| Enable on boot | `sudo systemctl enable panoruleauditor-backend` |

## Troubleshooting

- **502 / Proxy Error**  
  Backend not running or wrong port. Check: `systemctl status panoruleauditor-backend` and that `PORT` in `/opt/PaloRuleAuditor/.env.local` matches the port in the Apache `ProxyPass` (default 3010).

- **404 for /audit/**  
  Apache is not serving the alias or the static files are missing. Check that `/var/www/html/audit` exists and contains `index.html`, and that the `Alias` and `Directory` block are loaded.

- **API calls fail**  
  Ensure `<Location "/audit/api">` is defined and that `ProxyPass`/`ProxyPassReverse` point to `http://127.0.0.1:3010/api`.

- **Backend: EPERM "operation not permitted" on dist-server/server/index.js**  
  The install script now uses a root-run wrapper (`start-backend.sh`) that fixes permissions and runs Node, avoiding EPERM from file ownership, SELinux, or other restrictions. Re-run the install to get the wrapper, or create it manually:
  ```bash
  sudo tee /opt/PaloRuleAuditor/start-backend.sh << 'EOF'
#!/bin/bash
cd /opt/PaloRuleAuditor
chown -R panoruleauditor:panoruleauditor . 2>/dev/null || true
chmod -R 755 dist-server 2>/dev/null || true
exec /usr/bin/node dist-server/server/index.js
EOF
  sudo chmod +x /opt/PaloRuleAuditor/start-backend.sh
  sudo sed -i 's|ExecStart=.*|ExecStart=/opt/PaloRuleAuditor/start-backend.sh|' /etc/systemd/system/panoruleauditor-backend.service
  sudo sed -i 's|^User=.*|User=root|' /etc/systemd/system/panoruleauditor-backend.service
  sudo systemctl daemon-reload
  sudo systemctl restart panoruleauditor-backend
  ```
