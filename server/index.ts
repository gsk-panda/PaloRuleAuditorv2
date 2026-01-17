console.log('Starting server...');
import express from 'express';
import cors from 'cors';
console.log('Imports loaded, importing panoramaService...');
import { auditPanoramaRules } from './panoramaService.js';
console.log('panoramaService imported successfully');

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
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

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
    
    const deviceGroupsUrl = `${url}/api/?type=config&action=get&xpath=/config/devices/entry[@name='${panoramaDeviceName}']/device-group&key=${apiKey}`;
    apiCalls.push({
      url: deviceGroupsUrl,
      description: 'Fetch device groups list',
      xmlCommand: undefined
    });

    try {
      const dgResponse = await fetch(deviceGroupsUrl);
      if (dgResponse.ok) {
        const dgXml = await dgResponse.text();
        const dgData = parser.parse(dgXml);
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
            const preConfigUrl = `${url}/api/?type=config&action=get&xpath=/config/devices/entry[@name='${panoramaDeviceName}']/device-group/entry[@name='${dgName}']/pre-rulebase/security/rules&key=${apiKey}`;
            apiCalls.push({
              url: preConfigUrl,
              description: `Fetch pre-rulebase rules for device group "${dgName}"`,
              xmlCommand: undefined
            });
            const preConfigResponse = await fetch(preConfigUrl);
            if (preConfigResponse.ok) {
              const preConfigXml = await preConfigResponse.text();
              const preConfigData = parser.parse(preConfigXml);
              
              let rules: any[] = [];
              if (preConfigData.response?.result?.rules?.entry) {
                rules = Array.isArray(preConfigData.response.result.rules.entry)
                  ? preConfigData.response.result.rules.entry
                  : [preConfigData.response.result.rules.entry];
              } else if (preConfigData.response?.result?.entry?.rules?.entry) {
                rules = Array.isArray(preConfigData.response.result.entry.rules.entry)
                  ? preConfigData.response.result.entry.rules.entry
                  : [preConfigData.response.result.entry.rules.entry];
              }
              
              for (const rule of rules) {
                const ruleName = rule.name || rule['@_name'] || rule['name'];
                if (ruleName) {
                  const rulebaseXml = `<pre-rulebase><entry name="security"><rules><rule-name><entry name="${ruleName}"/></rule-name></rules></entry></pre-rulebase>`;
                  const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}">${rulebaseXml}</entry></device-group></rule-hit-count></show>`;
                  const apiUrl = `${url}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
                  apiCalls.push({
                    url: apiUrl,
                    description: `Query rule-hit-count for rule "${ruleName}" in pre-rulebase of device group "${dgName}"`,
                    xmlCommand: xmlCmd
                  });
                }
              }
            }
          } catch (error) {
            console.error(`Error generating preview for device group ${dgName}:`, error);
          }
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

app.post('/api/audit', async (req, res) => {
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

app.post('/api/remediate', async (req, res) => {
  try {
    console.log('Received remediation request');
    const { url, apiKey, rules, tag } = req.body;

    if (!url || !apiKey || !rules || !Array.isArray(rules) || !tag) {
      return res.status(400).json({ error: 'Panorama URL, API key, rules array, and tag are required' });
    }

    const panoramaDeviceName = 'localhost.localdomain';
    let disabledCount = 0;
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

    for (const rule of rules) {
      try {
        const xpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group/entry[@name='${rule.deviceGroup}']/pre-rulebase/security/rules/entry[@name='${rule.name}']`;
        
        const disableElement = '<disabled>yes</disabled>';
        const disableUrl = `${url}/api/?type=config&action=set&xpath=${encodeURIComponent(xpath)}&element=${encodeURIComponent(disableElement)}&key=${apiKey}`;
        
        console.log(`Disabling rule "${rule.name}" in device group "${rule.deviceGroup}"`);
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
          console.log(`Warning: Could not fetch rule "${rule.name}" to add tag, but rule was disabled`);
          disabledCount++;
          continue;
        }

        const ruleXml = await getResponse.text();
        const ruleData = parser.parse(ruleXml);
        const ruleEntry = ruleData.response?.result?.entry;
        
        if (!ruleEntry) {
          console.log(`Warning: Rule "${rule.name}" not found in response, but rule was disabled`);
          disabledCount++;
          continue;
        }

        const existingTags: string[] = [];
        if (ruleEntry.tag?.member) {
          const members = Array.isArray(ruleEntry.tag.member) 
            ? ruleEntry.tag.member 
            : [ruleEntry.tag.member];
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
          
          console.log(`Adding tag to rule "${rule.name}"`);
          const tagResponse = await fetch(tagUrl);
          
          if (!tagResponse.ok) {
            const errorText = await tagResponse.text();
            console.error(`Warning: Failed to add tag to rule "${rule.name}": ${errorText.substring(0, 200)}`);
          } else {
            const tagResult = await tagResponse.text();
            if (tagResult.includes('<response status="error"')) {
              console.error(`Warning: Error adding tag to rule "${rule.name}": ${tagResult.substring(0, 200)}`);
            }
          }
        }

        disabledCount++;
        console.log(`Successfully disabled rule "${rule.name}" in device group "${rule.deviceGroup}"`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Error processing rule "${rule.name}": ${errorMsg}`);
        console.error(`Error processing rule "${rule.name}":`, error);
      }
    }

    if (errors.length > 0) {
      console.error('Remediation errors:', errors);
    }

    res.json({ 
      disabledCount,
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
