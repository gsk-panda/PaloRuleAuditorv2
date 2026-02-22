// Disable TLS certificate verification for on-prem Panorama with self-signed certificates.
// This is intentional — this tool only ever connects to internal Panorama instances.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

console.log('Starting server...');
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
console.log('Imports loaded, importing panoramaService...');
import { auditPanoramaRules, fetchConfigPaginated, fetchDeviceGroupNames } from './panoramaService.js';
import { testSshConnection } from './panoramaSsh.js';
console.log('panoramaService imported successfully');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  if (error instanceof Error) {
    console.error('Error stack:', error.stack);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

const app = express();
const PORT = Number(process.env.PORT) || 3010;

function readConfigFile(): Record<string, string> {
  const cfg: Record<string, string> = {};
  const configPath = path.join(process.cwd(), '.config');
  if (!fs.existsSync(configPath)) return cfg;
  const content = fs.readFileSync(configPath, 'utf-8');
  content.split('\n').forEach((line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const m = trimmed.match(/^([^=]+)="?([^"]*)"?$/);
    if (m) cfg[m[1].trim()] = m[2].trim();
  });
  return cfg;
}

function getSshConfig(panoramaHost: string): import('./panoramaSsh.js').PanoramaSshConfig | null {
  const fileCfg = readConfigFile();
  const cfg: { user?: string; key?: string; password?: string; passphrase?: string; host?: string; port?: number } = {
    user: process.env.PANORAMA_SSH_USER || fileCfg['PANORAMA_SSH_USER'],
    key: process.env.PANORAMA_SSH_PRIVATE_KEY || fileCfg['PANORAMA_SSH_PRIVATE_KEY'],
    password: process.env.PANORAMA_SSH_PASSWORD || fileCfg['PANORAMA_SSH_PASSWORD'],
    passphrase: process.env.PANORAMA_SSH_KEY_PASSPHRASE || fileCfg['PANORAMA_SSH_KEY_PASSPHRASE'],
    host: process.env.PANORAMA_SSH_HOST || fileCfg['PANORAMA_SSH_HOST'] || panoramaHost,
    port: process.env.PANORAMA_SSH_PORT
      ? parseInt(process.env.PANORAMA_SSH_PORT, 10)
      : fileCfg['PANORAMA_SSH_PORT']
      ? parseInt(fileCfg['PANORAMA_SSH_PORT'], 10)
      : undefined,
  };

  const keyPath = process.env.PANORAMA_SSH_PRIVATE_KEY_PATH || fileCfg['PANORAMA_SSH_PRIVATE_KEY_PATH'];
  if (keyPath && !cfg.key) {
    try {
      cfg.key = fs.readFileSync(keyPath, 'utf-8');
    } catch (e) {
      console.error('SSH: Failed to read private key from path:', keyPath, e instanceof Error ? e.message : e);
    }
  }

  if (!cfg.user || (!cfg.key && !cfg.password)) return null;
  return {
    host: cfg.host || panoramaHost,
    port: cfg.port ?? 22,
    username: cfg.user,
    privateKey: cfg.key || undefined,
    password: cfg.password || undefined,
    passphrase: cfg.passphrase || undefined,
  };
}

app.use(cors());
app.use(express.json());

// ── Config endpoint ──────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  try {
    const fileCfg = readConfigFile();
    res.json({
      panoramaUrl: fileCfg['PANORAMA_URL'] || '',
      apiKey: fileCfg['PANORAMA_API_KEY'] || '',
    });
  } catch (error) {
    console.error('Error reading config:', error);
    res.json({ panoramaUrl: '', apiKey: '' });
  }
});

// ── Panorama API connectivity test ───────────────────────────────────────────
app.post('/api/test/panorama', async (req, res) => {
  try {
    const { url, apiKey } = req.body;
    if (!url || !apiKey) {
      return res.status(400).json({ ok: false, message: 'URL and API key are required' });
    }
    const testUrl = `${url}/api/?type=op&cmd=${encodeURIComponent('<show><system><info></info></system></show>')}&key=${apiKey}`;
    const response = await fetch(testUrl);
    const text = await response.text();
    if (!response.ok) {
      return res.json({ ok: false, message: `HTTP ${response.status}: ${response.statusText}` });
    }
    if (text.includes('status="success"')) {
      // Extract hostname for a friendly message
      const hostnameMatch = text.match(/<hostname>(.*?)<\/hostname>/);
      const hostname = hostnameMatch ? hostnameMatch[1] : 'Panorama';
      return res.json({ ok: true, message: `Connected to ${hostname}` });
    } else if (text.includes('Invalid credentials') || text.includes('status="error"')) {
      const msgMatch = text.match(/<msg>(.*?)<\/msg>/);
      return res.json({ ok: false, message: msgMatch ? msgMatch[1] : 'Invalid API key or credentials' });
    } else {
      return res.json({ ok: false, message: 'Unexpected response from Panorama' });
    }
  } catch (error) {
    console.error('Panorama test error:', error);
    res.json({ ok: false, message: error instanceof Error ? error.message : 'Connection failed' });
  }
});

// ── SSH connectivity test ────────────────────────────────────────────────────
app.post('/api/ssh/test', async (req, res) => {
  try {
    const { url } = req.body;
    let panoramaHost = url || '';
    if (panoramaHost) {
      try {
        panoramaHost = new URL(panoramaHost.startsWith('http') ? panoramaHost : `https://${panoramaHost}`).hostname;
      } catch (_) {}
    }
    const sshConfig = getSshConfig(panoramaHost || 'panorama');
    if (!sshConfig) {
      return res.status(400).json({
        ok: false,
        message: 'SSH not configured. Set PANORAMA_SSH_USER and PANORAMA_SSH_PRIVATE_KEY (or PATH) or PANORAMA_SSH_PASSWORD in .config or env.',
      });
    }
    const result = await testSshConnection(sshConfig);
    return res.json(result);
  } catch (error) {
    console.error('SSH test error:', error);
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : 'SSH test failed' });
  }
});

// ── Audit preview ────────────────────────────────────────────────────────────
app.post('/api/audit/preview', async (req, res) => {
  try {
    const { url, apiKey } = req.body;
    if (!url || !apiKey) {
      return res.status(400).json({ error: 'Panorama URL and API key are required' });
    }

    const apiCalls: Array<{ url: string; description: string; xmlCommand?: string }> = [];

    const panoramaDeviceName = 'localhost.localdomain';
    const dgXpath = `/config/devices/entry[@name='localhost.localdomain']/device-group`;
    apiCalls.push({ url: `${url}/api/?type=config&action=get&xpath=${encodeURIComponent(dgXpath)}&key=${apiKey}`, description: 'Fetch device groups list (config API, depth-aware XML parse)' });

    try {
      const deviceGroupNames = await fetchDeviceGroupNames(url, apiKey, panoramaDeviceName);
      for (const dgName of deviceGroupNames) {
        try {
          const preRulesXpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group/entry[@name='${dgName}']/pre-rulebase/security/rules`;
          apiCalls.push({ url: `${url}/api/?type=config&action=get&xpath=${encodeURIComponent(preRulesXpath)}&key=${apiKey}`, description: `Fetch pre-rulebase rules for device group "${dgName}" (paginated)` });
          const preConfigData = await fetchConfigPaginated(url, apiKey, preRulesXpath);
          const result = preConfigData.response?.result;
          let rules: any[] = [];
          if (result?.rules?.entry) rules = Array.isArray(result.rules.entry) ? result.rules.entry : [result.rules.entry];
          else if (result?.entry?.rules?.entry) rules = Array.isArray(result.entry.rules.entry) ? result.entry.rules.entry : [result.entry.rules.entry];
          if (rules.length > 0) {
            const ruleNames = rules.map((r: any) => r.name || r['@_name'] || r['name']).filter(Boolean);
            if (ruleNames.length > 0) {
              const ruleNameEntries = ruleNames.map((name: string) => `<entry name="${name}"/>`).join('');
              const rulebaseXml = `<pre-rulebase><entry name="security"><rules><rule-name>${ruleNameEntries}</rule-name></rules></entry></pre-rulebase>`;
              const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}">${rulebaseXml}</entry></device-group></rule-hit-count></show>`;
              apiCalls.push({ url: `${url}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`, description: `Query rule-hit-count for ${ruleNames.length} rules in pre-rulebase of device group "${dgName}" (batched)`, xmlCommand: xmlCmd });
            }
          }
        } catch (error) {
          console.error(`Error generating preview for device group ${dgName}:`, error);
        }
      }
    } catch (error) {
      console.error('Error generating preview:', error);
    }
    res.json({ apiCalls });
  } catch (error) {
    console.error('Preview error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate preview' });
  }
});

const LONG_REQUEST_MS = 60 * 60 * 1000;

// ── Unused rules audit ───────────────────────────────────────────────────────
app.post('/api/audit', async (req, res) => {
  req.setTimeout(LONG_REQUEST_MS);
  res.setTimeout(LONG_REQUEST_MS);
  console.log('Received audit request');
  const { url, apiKey, unusedDays, haPairs } = req.body;
  if (!url || !apiKey) {
    console.log('Missing required parameters');
    return res.status(400).json({ error: 'Panorama URL and API key are required' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  let responseEnded = false;
  const writeLine = (obj: object) => {
    if (responseEnded || res.writableEnded) return;
    try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  };
  const finish = () => {
    if (responseEnded) return;
    responseEnded = true;
    try { if (!res.writableEnded) res.end(); } catch (_) {}
  };
  res.on('close', finish);

  try {
    let panoramaHost = url;
    try { panoramaHost = new URL(url.startsWith('http') ? url : `https://${url}`).hostname; } catch (_) {}
    const sshConfig = getSshConfig(panoramaHost);
    console.log('Calling auditPanoramaRules...', sshConfig ? '(SSH enabled)' : '(API only)');
    const result = await auditPanoramaRules(url, apiKey, unusedDays || 90, haPairs || [], (msg) => writeLine({ progress: msg }), sshConfig);
    console.log(`Audit completed: ${result.rules.length} rules, ${result.deviceGroups.length} device groups`);
    writeLine({ result: { rules: result.rules, deviceGroups: result.deviceGroups, rulesProcessed: result.rulesProcessed } });
  } catch (error) {
    console.error('Audit error:', error);
    writeLine({ error: error instanceof Error ? error.message : 'Failed to perform audit' });
  } finally {
    finish();
  }
});

// ── Disabled rules audit ─────────────────────────────────────────────────────
app.post('/api/audit/disabled', async (req, res) => {
  req.setTimeout(LONG_REQUEST_MS);
  res.setTimeout(LONG_REQUEST_MS);
  console.log('Received disabled rules audit request');
  const { url, apiKey, disabledDays } = req.body;
  if (!url || !apiKey) {
    return res.status(400).json({ error: 'Panorama URL and API key are required' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  let responseEnded = false;
  const writeLine = (obj: object) => {
    if (responseEnded || res.writableEnded) return;
    try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  };
  const finish = () => {
    if (responseEnded) return;
    responseEnded = true;
    try { if (!res.writableEnded) res.end(); } catch (_) {}
  };
  res.on('close', finish);

  try {
    console.log('Calling auditDisabledRules...');
    const { auditDisabledRules } = await import('./panoramaService.js');
    const result = await auditDisabledRules(url, apiKey, disabledDays || 90, (msg) => writeLine({ progress: msg }));
    console.log(`Disabled rules audit completed: ${result.rules.length} rules, ${result.deviceGroups.length} device groups`);
    writeLine({ result: { rules: result.rules, deviceGroups: result.deviceGroups, rulesProcessed: result.rulesProcessed } });
  } catch (error) {
    console.error('Disabled rules audit error:', error);
    writeLine({ error: error instanceof Error ? error.message : 'Failed to perform audit' });
  } finally {
    finish();
  }
});

// ── Remediation ──────────────────────────────────────────────────────────────
app.post('/api/remediate', async (req, res) => {
  req.setTimeout(LONG_REQUEST_MS);
  res.setTimeout(LONG_REQUEST_MS);
  try {
    console.log('Received remediation request');
    const { url, apiKey, rules, tag, auditMode } = req.body;
    console.log('Remediation request - auditMode:', auditMode, 'type:', typeof auditMode);

    if (!url || !apiKey || !rules || !Array.isArray(rules)) {
      return res.status(400).json({ error: 'Panorama URL, API key, and rules array are required' });
    }
    if (auditMode !== 'disabled' && !tag) {
      return res.status(400).json({ error: 'Tag is required for unused rules remediation' });
    }

    const panoramaDeviceName = 'localhost.localdomain';
    const isDeleteMode = String(auditMode) === 'disabled';
    console.log(`Remediation mode: ${isDeleteMode ? 'DELETE' : 'DISABLE/UNTARGET'}, auditMode value: "${auditMode}"`);

    let disabledCount = 0;
    let deletedCount = 0;
    let untargetedCount = 0;
    const errors: string[] = [];

    const { XMLParser, XMLBuilder } = await import('fast-xml-parser');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', textNodeName: '_text', parseAttributeValue: true });
    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '_text', format: false });

    // Create tag if needed (disable mode only)
    if (!isDeleteMode) {
      const checkTagUrl = `${url}/api/?type=config&action=get&xpath=/config/shared/tag&key=${apiKey}`;
      const tagCheckResponse = await fetch(checkTagUrl);
      let tagExists = false;
      if (tagCheckResponse.ok) {
        const tagCheckXml = await tagCheckResponse.text();
        const tagCheckData = parser.parse(tagCheckXml);
        if (tagCheckData.response?.status === 'success' && tagCheckData.response?.result?.tag?.entry) {
          const entries = Array.isArray(tagCheckData.response.result.tag.entry)
            ? tagCheckData.response.result.tag.entry
            : [tagCheckData.response.result.tag.entry];
          tagExists = entries.some((entry: any) => (entry.name || entry['@_name']) === tag);
        }
      }
      if (!tagExists) {
        console.log(`Tag "${tag}" does not exist, creating it...`);
        const tagElement = `<color>color1</color><comments>Auto-generated by Panorama Rule Auditor on ${new Date().toISOString().split('T')[0]}</comments>`;
        const tagXpath = `/config/shared/tag/entry[@name='${tag}']`;
        const createTagUrl = `${url}/api/?type=config&action=set&xpath=${encodeURIComponent(tagXpath)}&element=${encodeURIComponent(tagElement)}&key=${apiKey}`;
        const createTagResponse = await fetch(createTagUrl);
        if (!createTagResponse.ok) {
          const errorText = await createTagResponse.text();
          return res.status(500).json({ error: `Failed to create tag "${tag}": ${errorText.substring(0, 500)}` });
        }
        const createTagResult = await createTagResponse.text();
        if (createTagResult.includes('<response status="error"')) {
          return res.status(500).json({ error: `Error creating tag "${tag}": ${createTagResult.substring(0, 500)}` });
        }
        console.log(`Successfully created tag "${tag}"`);
      } else {
        console.log(`Tag "${tag}" already exists`);
      }
    }

    // Filter: only process rules that actually need remediation
    const REMEDIABLE_ACTIONS = ['DISABLE', 'UNTARGET'];
    const rulesToProcess = rules.filter((rule: any) => {
      if (rule.action === 'PROTECTED' || rule.action === 'HA-PROTECTED' || rule.action === 'IGNORE' || rule.action === 'KEEP') {
        console.log(`Skipping rule "${rule.name}" with action "${rule.action}"`);
        return false;
      }
      return true;
    });

    if (rulesToProcess.length === 0) {
      return res.status(400).json({ error: 'No actionable rules to process' });
    }

    for (const rule of rulesToProcess) {
      try {
        const xpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group/entry[@name='${rule.deviceGroup}']/pre-rulebase/security/rules/entry[@name='${rule.name}']`;

        if (isDeleteMode) {
          console.log(`[DELETE MODE] Deleting rule "${rule.name}" in device group "${rule.deviceGroup}"`);
          const deleteUrl = `${url}/api/?type=config&action=delete&xpath=${encodeURIComponent(xpath)}&key=${apiKey}`;
          const deleteResponse = await fetch(deleteUrl);
          if (!deleteResponse.ok) {
            errors.push(`Failed to delete rule "${rule.name}": ${(await deleteResponse.text()).substring(0, 200)}`);
            continue;
          }
          const deleteResult = await deleteResponse.text();
          if (deleteResult.includes('<response status="error"')) {
            errors.push(`Error deleting rule "${rule.name}": ${deleteResult.substring(0, 200)}`);
            continue;
          }
          deletedCount++;
          console.log(`Successfully deleted rule "${rule.name}"`);
        } else {
          const isUntarget = rule.action === 'UNTARGET' && rule.targets && Array.isArray(rule.targets);
          const devicesToKeep = isUntarget
            ? (rule.targets as { name: string; hasHits: boolean }[]).filter(t => t.hasHits).map(t => t.name)
            : [];

          if (isUntarget && devicesToKeep.length > 0) {
            console.log(`[UNTARGET MODE] Untargeting rule "${rule.name}" - keeping: ${devicesToKeep.join(', ')}`);
            const getRuleUrl = `${url}/api/?type=config&action=get&xpath=${encodeURIComponent(xpath)}&key=${apiKey}`;
            const getResponse = await fetch(getRuleUrl);
            if (!getResponse.ok) { errors.push(`Failed to fetch rule "${rule.name}": ${getResponse.statusText}`); continue; }
            const ruleData = parser.parse(await getResponse.text());
            if (!ruleData.response?.result?.entry) { errors.push(`Rule "${rule.name}" not found`); continue; }
            const escapeXmlAttr = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            const targetElement = `<target><devices>${devicesToKeep.map(d => `<entry name="${escapeXmlAttr(d)}"/>`).join('')}</devices></target>`;
            const setResponse = await fetch(`${url}/api/?type=config&action=set&xpath=${encodeURIComponent(xpath)}&element=${encodeURIComponent(targetElement)}&key=${apiKey}`);
            if (!setResponse.ok || (await setResponse.text()).includes('<response status="error"')) {
              errors.push(`Failed to untarget rule "${rule.name}"`);
              continue;
            }
            untargetedCount++;
            console.log(`Successfully untargeted rule "${rule.name}"`);
          } else {
            console.log(`[DISABLE MODE] Disabling rule "${rule.name}" in device group "${rule.deviceGroup}"`);
            const disableElement = '<disabled>yes</disabled>';
            const disableResponse = await fetch(`${url}/api/?type=config&action=set&xpath=${encodeURIComponent(xpath)}&element=${encodeURIComponent(disableElement)}&key=${apiKey}`);
            if (!disableResponse.ok || (await disableResponse.text()).includes('<response status="error"')) {
              errors.push(`Failed to disable rule "${rule.name}"`);
              continue;
            }
            // Apply tag
            const getCurrentRuleUrl = `${url}/api/?type=config&action=get&xpath=${encodeURIComponent(xpath)}&key=${apiKey}`;
            const getResponse = await fetch(getCurrentRuleUrl);
            if (getResponse.ok) {
              const ruleData = parser.parse(await getResponse.text());
              const ruleEntry = ruleData.response?.result?.entry;
              if (ruleEntry) {
                const existingTags: string[] = [];
                if (ruleEntry.tag?.member) {
                  const members = Array.isArray(ruleEntry.tag.member) ? ruleEntry.tag.member : [ruleEntry.tag.member];
                  existingTags.push(...members.map((m: any) => (typeof m === 'string' ? m : m['_text'] || m['#text'] || String(m))).filter(Boolean));
                }
                if (!existingTags.includes(tag)) {
                  existingTags.push(tag);
                  const tagElement = `<tag>${existingTags.map(t => `<member>${t}</member>`).join('')}</tag>`;
                  await fetch(`${url}/api/?type=config&action=set&xpath=${encodeURIComponent(xpath)}&element=${encodeURIComponent(tagElement)}&key=${apiKey}`);
                }
              }
            }
            disabledCount++;
            console.log(`Successfully disabled rule "${rule.name}"`);
          }
        }
      } catch (error) {
        errors.push(`Error processing rule "${rule.name}": ${error instanceof Error ? error.message : 'Unknown error'}`);
        console.error(`Error processing rule "${rule.name}":`, error);
      }
    }

    const totalProcessed = isDeleteMode ? deletedCount : (disabledCount + untargetedCount);
    if (totalProcessed > 0) {
      console.log('Committing configuration changes to Panorama...');
      const commitDescription = isDeleteMode
        ? `Deleted ${deletedCount} disabled firewall rules`
        : `Disabled ${disabledCount} rules, untargeted ${untargetedCount} rules, tagged with ${tag}`;
      const commitCmd = `<commit><description>${commitDescription}</description></commit>`;
      try {
        const commitResponse = await fetch(`${url}/api/?type=commit&cmd=${encodeURIComponent(commitCmd)}&key=${apiKey}`);
        const commitResult = await commitResponse.text();
        if (!commitResponse.ok || commitResult.includes('<response status="error"')) {
          errors.push(`Failed to commit changes: ${commitResult.substring(0, 200)}`);
        } else {
          console.log('Successfully committed configuration changes');
        }
      } catch (error) {
        errors.push(`Error committing changes: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    res.json({
      disabledCount: isDeleteMode ? 0 : disabledCount,
      deletedCount: isDeleteMode ? deletedCount : 0,
      untargetedCount: isDeleteMode ? 0 : untargetedCount,
      totalRules: rules.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Remediation error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to apply remediation' });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── Static frontend ──────────────────────────────────────────────────────────
const publicPath = path.join(process.cwd(), 'public');
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(publicPath, 'index.html'));
    }
  });
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`API server running on port ${PORT}`);
}).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    throw err;
  }
});

process.on('SIGTERM', () => { server.close(() => { console.log('HTTP server closed'); }); });
process.on('SIGINT', () => { server.close(() => { console.log('HTTP server closed'); process.exit(0); }); });
