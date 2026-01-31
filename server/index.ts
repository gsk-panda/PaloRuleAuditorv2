console.log('Starting server...');
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
console.log('Imports loaded, importing panoramaService...');
import { auditPanoramaRules, fetchConfigPaginated } from './panoramaService.js';
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

app.use(cors());
app.use(express.json());

app.get('/api/config', async (req, res) => {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const configPath = path.join(process.cwd(), '.config');
    
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config: { PANORAMA_URL?: string; PANORAMA_API_KEY?: string } = {};
      
      configContent.split('\n').forEach(line => {
        if (line.trim() && !line.trim().startsWith('#')) {
          const match = line.match(/^([^=]+)="?([^"]+)"?$/);
          if (match) {
            const key = match[1].trim();
            const value = match[2].trim();
            if (key === 'PANORAMA_URL') {
              config.PANORAMA_URL = value;
            } else if (key === 'PANORAMA_API_KEY') {
              config.PANORAMA_API_KEY = value;
            }
          }
        }
      });
      
      res.json({
        panoramaUrl: config.PANORAMA_URL || '',
        apiKey: config.PANORAMA_API_KEY || ''
      });
    } else {
      res.json({
        panoramaUrl: '',
        apiKey: ''
      });
    }
  } catch (error) {
    console.error('Error reading config:', error);
    res.json({
      panoramaUrl: '',
      apiKey: ''
    });
  }
});

app.post('/api/audit/preview', async (req, res) => {
  try {
    const { url, apiKey } = req.body;

    if (!url || !apiKey) {
      return res.status(400).json({ error: 'Panorama URL and API key are required' });
    }

    const apiCalls: Array<{ url: string; description: string; xmlCommand?: string }> = [];
    
    const { XMLParser } = await import('fast-xml-parser');
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      textNodeName: '_text',
      parseAttributeValue: true,
    });
    
    const panoramaDeviceName = 'localhost.localdomain';
    const deviceGroupXpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group`;
    apiCalls.push({
      url: `${url}/api/?type=config&action=get&xpath=${encodeURIComponent(deviceGroupXpath)}&key=${apiKey}`,
      description: 'Fetch device groups list (paginated)',
      xmlCommand: undefined
    });

    try {
      const dgData = await fetchConfigPaginated(url, apiKey, deviceGroupXpath);
      const deviceGroupResult = dgData.response?.result?.['device-group'];
      let deviceGroupNames: string[] = [];
      if (deviceGroupResult?.entry) {
        const entries = Array.isArray(deviceGroupResult.entry)
          ? deviceGroupResult.entry
          : [deviceGroupResult.entry];
        deviceGroupNames = entries.map((e: any) => e.name || e['@_name']).filter(Boolean);
      }

      for (const dgName of deviceGroupNames) {
        try {
          const preRulesXpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group/entry[@name='${dgName}']/pre-rulebase/security/rules`;
          apiCalls.push({
            url: `${url}/api/?type=config&action=get&xpath=${encodeURIComponent(preRulesXpath)}&key=${apiKey}`,
            description: `Fetch pre-rulebase rules for device group "${dgName}" (paginated)`,
            xmlCommand: undefined
          });
          const preConfigData = await fetchConfigPaginated(url, apiKey, preRulesXpath);
          const result = preConfigData.response?.result;
          let rules: any[] = [];
          if (result?.rules?.entry) {
            rules = Array.isArray(result.rules.entry) ? result.rules.entry : [result.rules.entry];
          } else if (result?.entry?.rules?.entry) {
            rules = Array.isArray(result.entry.rules.entry) ? result.entry.rules.entry : [result.entry.rules.entry];
          }

          if (rules.length > 0) {
            const ruleNames = rules.map(r => r.name || r['@_name'] || r['name']).filter(Boolean);
            if (ruleNames.length > 0) {
              const ruleNameEntries = ruleNames.map(name => `<entry name="${name}"/>`).join('');
              const rulebaseXml = `<pre-rulebase><entry name="security"><rules><rule-name>${ruleNameEntries}</rule-name></rules></entry></pre-rulebase>`;
              const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}">${rulebaseXml}</entry></device-group></rule-hit-count></show>`;
              const apiUrl = `${url}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
              apiCalls.push({
                url: apiUrl,
                description: `Query rule-hit-count for ${ruleNames.length} rules in pre-rulebase of device group "${dgName}" (batched)`,
                xmlCommand: xmlCmd
              });
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
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to generate preview'
    });
  }
});

const LONG_REQUEST_MS = 30 * 60 * 1000;

app.post('/api/audit', async (req, res) => {
  req.setTimeout(LONG_REQUEST_MS);
  res.setTimeout(LONG_REQUEST_MS);
  try {
    console.log('Received audit request');
    const { url, apiKey, unusedDays, haPairs } = req.body;

    if (!url || !apiKey) {
      console.log('Missing required parameters');
      return res.status(400).json({ error: 'Panorama URL and API key are required' });
    }

    console.log('Calling auditPanoramaRules...');
    const result = await auditPanoramaRules(url, apiKey, unusedDays || 90, haPairs || []);
    console.log(`Audit completed: ${result.rules.length} rules, ${result.deviceGroups.length} device groups`);
    
    res.json({ rules: result.rules, deviceGroups: result.deviceGroups });
  } catch (error) {
    console.error('Audit error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to perform audit';
    console.error('Error details:', errorMessage);
    res.status(500).json({ 
      error: errorMessage
    });
  }
});

app.post('/api/audit/disabled', async (req, res) => {
  req.setTimeout(LONG_REQUEST_MS);
  res.setTimeout(LONG_REQUEST_MS);
  try {
    console.log('Received disabled rules audit request');
    const { url, apiKey, disabledDays } = req.body;

    if (!url || !apiKey) {
      console.log('Missing required parameters');
      return res.status(400).json({ error: 'Panorama URL and API key are required' });
    }

    console.log('Calling auditDisabledRules...');
    const { auditDisabledRules } = await import('./panoramaService.js');
    const result = await auditDisabledRules(url, apiKey, disabledDays || 90);
    console.log(`Disabled rules audit completed: ${result.rules.length} rules, ${result.deviceGroups.length} device groups`);
    
    res.json({ rules: result.rules, deviceGroups: result.deviceGroups });
  } catch (error) {
    console.error('Disabled rules audit error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to perform audit';
    console.error('Error details:', errorMessage);
    res.status(500).json({ 
      error: errorMessage
    });
  }
});

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
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      textNodeName: '_text',
      parseAttributeValue: true,
    });
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '_text',
      format: false,
    });

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
          
          tagExists = entries.some((entry: any) => {
            const entryName = entry.name || entry['@_name'];
            return entryName === tag;
          });
        }
      }
      
      if (!tagExists) {
        console.log(`Tag "${tag}" does not exist, creating it...`);
        const tagElement = `<color>color1</color><comments>Auto-generated tag for disabled rules on ${new Date().toISOString().split('T')[0]}</comments>`;
        const tagXpath = `/config/shared/tag/entry[@name='${tag}']`;
        const createTagUrl = `${url}/api/?type=config&action=set&xpath=${encodeURIComponent(tagXpath)}&element=${encodeURIComponent(tagElement)}&key=${apiKey}`;
        console.log(`Creating tag with URL: ${createTagUrl}`);
        const createTagResponse = await fetch(createTagUrl);
        
        if (!createTagResponse.ok) {
          const errorText = await createTagResponse.text();
          console.error(`Tag creation failed: ${errorText}`);
          return res.status(500).json({ 
            error: `Failed to create tag "${tag}": ${errorText.substring(0, 500)}`
          });
        }
        
        const createTagResult = await createTagResponse.text();
        console.log(`Tag creation response: ${createTagResult.substring(0, 500)}`);
        if (createTagResult.includes('<response status="error"')) {
          return res.status(500).json({ 
            error: `Error creating tag "${tag}": ${createTagResult.substring(0, 500)}`
          });
        }
        
        console.log(`Successfully created tag "${tag}"`);
      } else {
        console.log(`Tag "${tag}" already exists`);
      }
    }

    const rulesToProcess = rules.filter((rule: any) => rule.action !== 'PROTECTED');
    
    if (rulesToProcess.length === 0) {
      return res.status(400).json({ error: 'No rules to process (all rules are protected)' });
    }
    
    for (const rule of rulesToProcess) {
      try {
        const xpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group/entry[@name='${rule.deviceGroup}']/pre-rulebase/security/rules/entry[@name='${rule.name}']`;
        
        if (isDeleteMode) {
          console.log(`[DELETE MODE] Processing rule "${rule.name}" in device group "${rule.deviceGroup}"`);
          const deleteUrl = `${url}/api/?type=config&action=delete&xpath=${encodeURIComponent(xpath)}&key=${apiKey}`;
          
          console.log(`Deleting rule "${rule.name}" in device group "${rule.deviceGroup}"`);
          const deleteResponse = await fetch(deleteUrl);
          
          if (!deleteResponse.ok) {
            const errorText = await deleteResponse.text();
            errors.push(`Failed to delete rule "${rule.name}": ${errorText.substring(0, 200)}`);
            continue;
          }

          const deleteResult = await deleteResponse.text();
          if (deleteResult.includes('<response status="error"')) {
            errors.push(`Error deleting rule "${rule.name}": ${deleteResult.substring(0, 200)}`);
            continue;
          }

          deletedCount++;
          console.log(`Successfully deleted rule "${rule.name}" in device group "${rule.deviceGroup}"`);
        } else {
          const isUntarget = rule.action === 'UNTARGET' && rule.targets && Array.isArray(rule.targets);
          const devicesToKeep = isUntarget
            ? (rule.targets as { name: string; hasHits: boolean }[]).filter(t => t.hasHits).map(t => t.name)
            : [];

          if (isUntarget && devicesToKeep.length > 0) {
            console.log(`[UNTARGET MODE] Processing rule "${rule.name}" in device group "${rule.deviceGroup}" - untargeting from devices with no hits`);
            const getRuleUrl = `${url}/api/?type=config&action=get&xpath=${encodeURIComponent(xpath)}&key=${apiKey}`;
            const getResponse = await fetch(getRuleUrl);
            if (!getResponse.ok) {
              errors.push(`Failed to fetch rule "${rule.name}": ${getResponse.statusText}`);
              continue;
            }
            const ruleXml = await getResponse.text();
            const ruleData = parser.parse(ruleXml);
            const ruleEntry = ruleData.response?.result?.entry;
            if (!ruleEntry) {
              errors.push(`Rule "${rule.name}" not found`);
              continue;
            }
            const escapeXmlAttr = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            const targetElement = `<target><devices>${devicesToKeep.map(d => `<entry name="${escapeXmlAttr(d)}"/>`).join('')}</devices></target>`;
            const setTargetUrl = `${url}/api/?type=config&action=set&xpath=${encodeURIComponent(xpath)}&element=${encodeURIComponent(targetElement)}&key=${apiKey}`;
            const setResponse = await fetch(setTargetUrl);
            if (!setResponse.ok) {
              const errorText = await setResponse.text();
              errors.push(`Failed to untarget rule "${rule.name}": ${errorText.substring(0, 200)}`);
              continue;
            }
            const setResult = await setResponse.text();
            if (setResult.includes('<response status="error"')) {
              errors.push(`Error untargeting rule "${rule.name}": ${setResult.substring(0, 200)}`);
              continue;
            }
            untargetedCount++;
            console.log(`Successfully untargeted rule "${rule.name}" - kept devices: ${devicesToKeep.join(', ')}`);
          } else {
            const shouldDisable = !isUntarget || devicesToKeep.length === 0;
            if (shouldDisable) {
              console.log(`[DISABLE MODE] Processing rule "${rule.name}" in device group "${rule.deviceGroup}"`);
            } else {
              console.log(`[DISABLE MODE] Processing rule "${rule.name}" - no devices to keep, disabling rule`);
            }
            const disableElement = '<disabled>yes</disabled>';
            const disableUrl = `${url}/api/?type=config&action=set&xpath=${encodeURIComponent(xpath)}&element=${encodeURIComponent(disableElement)}&key=${apiKey}`;
            const disableResponse = await fetch(disableUrl);
            if (!disableResponse.ok) {
              const errorText = await disableResponse.text();
              errors.push(`Failed to disable rule "${rule.name}": ${errorText.substring(0, 200)}`);
              continue;
            }
            const disableResult = await disableResponse.text();
            if (disableResult.includes('<response status="error"')) {
              errors.push(`Error disabling rule "${rule.name}": ${disableResult.substring(0, 200)}`);
              continue;
            }
            const getCurrentRuleUrl = `${url}/api/?type=config&action=get&xpath=${encodeURIComponent(xpath)}&key=${apiKey}`;
            const getResponse = await fetch(getCurrentRuleUrl);
            if (!getResponse.ok) {
              disabledCount++;
              continue;
            }
            const ruleXml = await getResponse.text();
            const ruleData = parser.parse(ruleXml);
            const ruleEntry = ruleData.response?.result?.entry;
            if (!ruleEntry) {
              disabledCount++;
              continue;
            }
            const existingTags: string[] = [];
            if (ruleEntry.tag?.member) {
              const members = Array.isArray(ruleEntry.tag.member) ? ruleEntry.tag.member : [ruleEntry.tag.member];
              existingTags.push(...members.map((m: any) => {
                if (typeof m === 'string') return m;
                if (m['_text']) return m['_text'];
                if (m['#text']) return m['#text'];
                return String(m);
              }).filter(Boolean));
            }
            if (!existingTags.includes(tag)) {
              existingTags.push(tag);
              const tagElement = existingTags.length === 1
                ? `<tag><member>${existingTags[0]}</member></tag>`
                : `<tag>${existingTags.map(t => `<member>${t}</member>`).join('')}</tag>`;
              const tagUrl = `${url}/api/?type=config&action=set&xpath=${encodeURIComponent(xpath)}&element=${encodeURIComponent(tagElement)}&key=${apiKey}`;
              const tagResponse = await fetch(tagUrl);
              if (!tagResponse.ok) {
                console.error(`Warning: Failed to add tag to rule "${rule.name}"`);
              } else {
                const tagResult = await tagResponse.text();
                if (tagResult.includes('<response status="error"')) {
                  console.error(`Warning: Error adding tag to rule "${rule.name}"`);
                }
              }
            }
            disabledCount++;
            console.log(`Successfully disabled rule "${rule.name}" in device group "${rule.deviceGroup}"`);
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Error processing rule "${rule.name}": ${errorMsg}`);
        console.error(`Error processing rule "${rule.name}":`, error);
      }
    }

    if (errors.length > 0) {
      console.error('Remediation errors:', errors);
    }

    const totalProcessed = isDeleteMode ? deletedCount : (disabledCount + untargetedCount);
    if (totalProcessed > 0) {
      console.log('Committing configuration changes to Panorama...');
      const commitDescription = isDeleteMode
        ? `Deleted ${deletedCount} disabled firewall rules`
        : `Disabled ${disabledCount} rules and untargeted ${untargetedCount} rules, added tag ${tag}`;
      const commitCmd = `<commit><description>${commitDescription}</description></commit>`;
      const commitUrl = `${url}/api/?type=commit&cmd=${encodeURIComponent(commitCmd)}&key=${apiKey}`;
      
      try {
        const commitResponse = await fetch(commitUrl);
        if (!commitResponse.ok) {
          const errorText = await commitResponse.text();
          console.error(`Commit failed: ${errorText}`);
          errors.push(`Failed to commit changes: ${errorText.substring(0, 200)}`);
        } else {
          const commitResult = await commitResponse.text();
          if (commitResult.includes('<response status="error"')) {
            console.error(`Commit error: ${commitResult}`);
            errors.push(`Error committing changes: ${commitResult.substring(0, 200)}`);
          } else {
            console.log('Successfully committed configuration changes');
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Commit error: ${errorMsg}`);
        errors.push(`Error committing changes: ${errorMsg}`);
      }
    }

    res.json({ 
      disabledCount: isDeleteMode ? 0 : disabledCount,
      deletedCount: isDeleteMode ? deletedCount : 0,
      untargetedCount: isDeleteMode ? 0 : untargetedCount,
      totalRules: rules.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Remediation error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to apply remediation';
    res.status(500).json({ 
      error: errorMessage
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

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
    console.error(`Port ${PORT} is already in use. Please stop the existing process or use a different port.`);
    console.error(`To find and kill the process: lsof -ti:${PORT} | xargs kill -9`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    throw err;
  }
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
