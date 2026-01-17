import { PanoramaRule, HAPair } from '../types.js';
import { XMLParser } from 'fast-xml-parser';

interface PanoramaRuleUseEntry {
  rulebase?: string;
  devicegroup?: string;
  rulename?: string;
  lastused?: string;
  hitcnt?: string;
  target?: string | Array<{ entry?: string }>;
  modificationTimestamp?: string;
}

interface PanoramaResponse {
  response?: {
    result?: {
      'rule-hit-count'?: {
        'device-group'?: {
          entry?: PanoramaDeviceGroupEntry | PanoramaDeviceGroupEntry[];
        };
      };
      'rule-use'?: {
        entry?: PanoramaRuleUseEntry | PanoramaRuleUseEntry[];
      };
      'panorama-rule-use'?: {
        entry?: PanoramaRuleUseEntry | PanoramaRuleUseEntry[];
      };
    };
  };
}

interface PanoramaDeviceGroupEntry {
  name?: string;
  'pre-rulebase'?: {
    entry?: PanoramaRuleBaseEntry | PanoramaRuleBaseEntry[];
  };
  'post-rulebase'?: {
    entry?: PanoramaRuleBaseEntry | PanoramaRuleBaseEntry[];
  };
  'rule-base'?: {
    entry?: PanoramaRuleBaseEntry | PanoramaRuleBaseEntry[];
  };
}

interface PanoramaRuleBaseEntry {
  name?: string;
  rules?: {
    entry?: PanoramaRuleUseEntry | PanoramaRuleUseEntry[];
  };
}

interface PanoramaRuleHitCountEntry {
  name?: string;
  'rule-state'?: string;
  'all-connected'?: string;
  'rule-creation-timestamp'?: string;
  'rule-modification-timestamp'?: string;
  'last-hit-timestamp'?: string;
  'hit-count'?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '_text',
  parseAttributeValue: true,
});

export interface AuditResult {
  rules: PanoramaRule[];
  deviceGroups: string[];
}

export async function auditPanoramaRules(
  panoramaUrl: string,
  apiKey: string,
  unusedDays: number,
  haPairs: HAPair[]
): Promise<AuditResult> {
  try {
    const haMap = new Map<string, string>();
    haPairs.forEach(pair => {
      haMap.set(pair.fw1, pair.fw2);
      haMap.set(pair.fw2, pair.fw1);
    });

    const panoramaDeviceName = 'localhost.localdomain';

    console.log('Step 1: Fetching device groups list...');
    const deviceGroupsUrl = `${panoramaUrl}/api/?type=config&action=get&xpath=/config/devices/entry[@name='${panoramaDeviceName}']/device-group&key=${apiKey}`;
    console.log('API Call - Device Groups:', deviceGroupsUrl);
    
    let deviceGroupNames: string[] = [];
    try {
      const dgResponse = await fetch(deviceGroupsUrl);
      console.log(`Device Groups API Response Status: ${dgResponse.status} ${dgResponse.statusText}`);
      if (dgResponse.ok) {
        const dgXml = await dgResponse.text();
        console.log(`Device Groups API Response length: ${dgXml.length} chars`);
        const dgData = parser.parse(dgXml);
        console.log('Parsed device groups data structure:', JSON.stringify(dgData.response?.result, null, 2));
        
        const deviceGroupResult = dgData.response?.result?.['device-group'];
        if (deviceGroupResult?.entry) {
          const entries = Array.isArray(deviceGroupResult.entry) 
            ? deviceGroupResult.entry 
            : [deviceGroupResult.entry];
          deviceGroupNames = entries.map((e: any) => e.name || e['@_name']).filter(Boolean);
          console.log(`Found ${deviceGroupNames.length} device groups:`, deviceGroupNames);
        } else {
          console.log('Device Groups API response structure:', JSON.stringify(dgData.response, null, 2));
        }
      } else {
        const errorText = await dgResponse.text();
        console.error(`Device Groups API error: ${dgResponse.status} ${dgResponse.statusText}`);
        console.error(`Error response: ${errorText.substring(0, 500)}`);
      }
    } catch (error) {
      console.error('Could not fetch device groups list:', error);
      if (error instanceof Error) {
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
      }
    }

    if (deviceGroupNames.length === 0) {
      console.log('No device groups found, skipping audit');
      return { rules: [], deviceGroups: [] };
    }

    console.log(`\nStep 2: Processing ${deviceGroupNames.length} device groups...`);
    
    let entries: PanoramaRuleUseEntry[] = [];
    const deviceGroupsSet = new Set<string>();

    for (const dgName of deviceGroupNames) {
      console.log(`\n=== Processing Device Group: ${dgName} ===`);
      
      try {
        console.log(`Step 2: Fetching pre-rulebase rules for device group "${dgName}"...`);
        const preConfigUrl = `${panoramaUrl}/api/?type=config&action=get&xpath=/config/devices/entry[@name='${panoramaDeviceName}']/device-group/entry[@name='${dgName}']/pre-rulebase/security/rules&key=${apiKey}`;
        console.log(`  Pre-rulebase config URL: ${preConfigUrl}`);
        const preConfigResponse = await fetch(preConfigUrl);
        console.log(`  Pre-rulebase response status: ${preConfigResponse.status} ${preConfigResponse.statusText}`);
        
        if (!preConfigResponse.ok) {
          const errorText = await preConfigResponse.text();
          console.error(`  Pre-rulebase fetch failed: ${errorText.substring(0, 500)}`);
          continue;
        }

        const preConfigXml = await preConfigResponse.text();
        const preConfigData = parser.parse(preConfigXml);
        console.log(`  Pre-rulebase parsed structure:`, JSON.stringify(preConfigData.response?.result, null, 2));
        
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
        
        if (rules.length === 0) {
          console.log(`  Step 3: No rules found for device group "${dgName}" - skipping`);
          continue;
        }

        console.log(`  Found ${rules.length} rules in pre-rulebase for "${dgName}"`);
        deviceGroupsSet.add(dgName);

        console.log(`\nStep 4: Querying hit counts for ${rules.length} rules...`);
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i];
          const ruleName = rule.name || rule['@_name'] || rule['name'];
          if (!ruleName) {
            console.log(`  Skipping rule without name at index ${i}`);
            continue;
          }

          console.log(`\n[${i + 1}/${rules.length}] Processing rule: "${ruleName}"`);
          try {
            const rulebaseXml = `<pre-rulebase><entry name="security"><rules><rule-name><entry name="${ruleName}"/></rule-name></rules></entry></pre-rulebase>`;
            const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}">${rulebaseXml}</entry></device-group></rule-hit-count></show>`;
            const apiUrl = `${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
            console.log(`    XML Command: ${xmlCmd}`);
            
            const response = await fetch(apiUrl);
            if (!response.ok) {
              console.error(`    Rule "${ruleName}" query failed: ${response.status} ${response.statusText}`);
              continue;
            }

            const xmlText = await response.text();
            if (xmlText.includes('<response status="error"')) {
              console.error(`    Rule "${ruleName}" returned error response`);
              continue;
            }

            const data: PanoramaResponse = parser.parse(xmlText);
            const ruleHitCount = data.response?.result?.['rule-hit-count'];
            if (!ruleHitCount?.['device-group']?.entry) {
              console.error(`    Rule "${ruleName}" - no hit count data in response`);
              continue;
            }

            const deviceGroups = Array.isArray(ruleHitCount['device-group'].entry)
              ? ruleHitCount['device-group'].entry
              : [ruleHitCount['device-group'].entry];
            
            deviceGroups.forEach((dg: PanoramaDeviceGroupEntry) => {
              if (dg['pre-rulebase']?.entry) {
                const preEntries = Array.isArray(dg['pre-rulebase'].entry) 
                  ? dg['pre-rulebase'].entry 
                  : [dg['pre-rulebase'].entry];
                
                preEntries.forEach((rb: PanoramaRuleBaseEntry) => {
                  if (rb.rules?.entry) {
                    const ruleEntries = Array.isArray(rb.rules.entry) ? rb.rules.entry : [rb.rules.entry];
                    ruleEntries.forEach((ruleEntry: any) => {
                      if (ruleEntry && (ruleEntry.name === ruleName || ruleEntry['@_name'] === ruleName)) {
                        const lastHitTimestamp = ruleEntry['last-hit-timestamp'];
                        const modificationTimestamp = ruleEntry['rule-modification-timestamp'];
                        const hitCount = ruleEntry['hit-count'] || ruleEntry['hitcount'] || '0';
                        
                        let lastUsedDate: string | undefined;
                        let useModificationTimestamp = false;
                        
                        if (lastHitTimestamp && parseInt(lastHitTimestamp) !== 0) {
                          lastUsedDate = new Date(parseInt(lastHitTimestamp) * 1000).toISOString();
                        } else if (modificationTimestamp) {
                          lastUsedDate = new Date(parseInt(modificationTimestamp) * 1000).toISOString();
                          useModificationTimestamp = true;
                        }
                        
                        console.log(`    Rule "${ruleName}": Last Hit Timestamp: ${lastHitTimestamp}, Modification Timestamp: ${modificationTimestamp}, Hit Count: ${hitCount}, Last Used: ${lastUsedDate}${useModificationTimestamp ? ' (using modification timestamp)' : ''}`);
                        
                        const rule: PanoramaRuleUseEntry = {
                          devicegroup: dgName,
                          rulebase: 'pre-rulebase',
                          rulename: ruleName,
                          lastused: lastUsedDate,
                          hitcnt: hitCount,
                          target: ruleEntry['all-connected'] === 'yes' ? 'all' : undefined,
                          modificationTimestamp: modificationTimestamp
                        };
                        
                        entries.push(rule);
                      }
                    });
                  }
                });
              }
            });
          } catch (error) {
            console.error(`Error querying rule "${ruleName}":`, error);
            if (error instanceof Error) {
              console.error(`  Error details: ${error.message}`);
            }
          }
        }
      } catch (error) {
        console.error(`Error processing device group ${dgName}:`, error);
        if (error instanceof Error) {
          console.error(`  Error message: ${error.message}`);
          console.error(`  Error stack: ${error.stack}`);
        }
      }
    }

    console.log(`\nStep 5: Filtering rules by unused days (${unusedDays} days)...`);
    const deviceGroups = Array.from(deviceGroupsSet).sort();
    console.log(`Collected ${deviceGroups.length} device groups:`, deviceGroups);
    console.log(`Found ${entries.length} rule entries before filtering`);

    if (entries.length === 0) {
      console.log('No entries found');
      return { rules: [], deviceGroups: deviceGroups };
    }

    const now = new Date();
    const unusedThreshold = new Date(now.getTime() - unusedDays * 24 * 60 * 60 * 1000);
    console.log(`Filtering rules that haven't been hit since ${unusedThreshold.toISOString()} (${unusedDays} days ago)`);

    const filteredEntries = entries.filter(entry => {
      if (!entry.lastused) {
        return true;
      }
      const lastUsedDate = new Date(entry.lastused);
      return lastUsedDate < unusedThreshold;
    });

    console.log(`Filtered ${entries.length} entries down to ${filteredEntries.length} unused rules`);

    if (filteredEntries.length === 0) {
      console.log('No unused rules found');
      return { rules: [], deviceGroups: deviceGroups };
    }

    const rules: PanoramaRule[] = [];
    const ruleMap = new Map<string, PanoramaRule>();

    filteredEntries.forEach((entry, index) => {
      console.log(`Entry ${index}:`, JSON.stringify(entry, null, 2));
      
      if (!entry.rulename || !entry.devicegroup) {
        console.log(`Skipping entry ${index}: missing rulename or devicegroup`);
        return;
      }

      const ruleKey = `${entry.devicegroup}:${entry.rulename}`;
      const isShared = false;
      const hitCount = parseInt(entry.hitcnt || '0', 10);
      
      let lastUsed: Date | null = null;
      if (entry.lastused) {
        lastUsed = new Date(entry.lastused);
      } else {
        lastUsed = new Date(0);
      }
      
      const targets: string[] = [];
      if (entry.target) {
        if (typeof entry.target === 'string') {
          if (entry.target !== 'all') {
            targets.push(entry.target);
          }
        } else if (Array.isArray(entry.target)) {
          entry.target.forEach(t => {
            if (t.entry && t.entry !== 'all') targets.push(t.entry);
          });
        }
      }
      
      if (entry.target === 'all' || (targets.length === 0 && entry.target === 'all')) {
        targets.push('all');
      }

      if (!ruleMap.has(ruleKey)) {
        const rule: PanoramaRule = {
          id: `rule-${index}`,
          name: entry.rulename,
          deviceGroup: entry.devicegroup,
          totalHits: hitCount,
          lastHitDate: lastUsed.toISOString(),
          targets: [],
          action: 'KEEP',
          isShared,
        };
        ruleMap.set(ruleKey, rule);
      }

      const rule = ruleMap.get(ruleKey)!;
      
      if (targets.length === 0) {
        targets.push('all');
      }
      
      targets.forEach(targetName => {
        const existingTarget = rule.targets.find(t => t.name === targetName);
        if (existingTarget) {
          existingTarget.hitCount += hitCount;
          existingTarget.hasHits = existingTarget.hitCount > 0;
        } else {
          rule.targets.push({
            name: targetName,
            hasHits: false,
            hitCount: 0,
            haPartner: haMap.get(targetName) || undefined,
          });
        }
      });

      rule.totalHits = Math.max(rule.totalHits, hitCount);
      if (lastUsed && (!rule.lastHitDate || new Date(rule.lastHitDate) < lastUsed)) {
        rule.lastHitDate = lastUsed.toISOString();
      }
    });

    const processedRules = Array.from(ruleMap.values());

    processedRules.forEach(rule => {
      const firewallsToUntarget = new Set<string>();
      const processed = new Set<string>();

      rule.targets.forEach(target => {
        if (processed.has(target.name)) return;

        const lastHit = new Date(rule.lastHitDate);
        const isUnused = !target.hasHits && lastHit < unusedThreshold;

        if (target.haPartner) {
          const partner = rule.targets.find(t => t.name === target.haPartner);
          if (partner) {
            const partnerLastHit = new Date(rule.lastHitDate);
            const partnerIsUnused = !partner.hasHits && partnerLastHit < unusedThreshold;
            
            if (isUnused && partnerIsUnused) {
              firewallsToUntarget.add(target.name);
              firewallsToUntarget.add(partner.name);
            }
            processed.add(target.name);
            processed.add(partner.name);
          } else {
            if (isUnused) firewallsToUntarget.add(target.name);
            processed.add(target.name);
          }
        } else {
          if (isUnused) firewallsToUntarget.add(target.name);
          processed.add(target.name);
        }
      });

      if (firewallsToUntarget.size === rule.targets.length && rule.targets.length > 0) {
        rule.action = 'DISABLE';
      } else if (firewallsToUntarget.size > 0) {
        rule.action = 'UNTARGET';
      } else {
        rule.action = 'KEEP';
      }
    });

    console.log(`Returning ${processedRules.length} unused rules and ${deviceGroups.length} device groups:`, deviceGroups);
    
    return {
      rules: processedRules,
      deviceGroups: deviceGroups
    };
  } catch (error) {
    console.error('Panorama API error:', error);
    throw error;
  }
}
