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
