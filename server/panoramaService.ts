import { PanoramaRule, HAPair } from '../types.js';
import { XMLParser } from 'fast-xml-parser';

interface PanoramaRuleUseEntry {
  rulebase?: string;
  devicegroup?: string;
  rulename?: string;
  lastused?: string;
  hitcnt?: string;
  target?: string | Array<{ entry?: string }>;
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
  const haMap = new Map<string, string>();
  haPairs.forEach(pair => {
    haMap.set(pair.fw1, pair.fw2);
    haMap.set(pair.fw2, pair.fw1);
  });

  console.log('Fetching device groups list...');
  const deviceGroupsUrl = `${panoramaUrl}/api/?type=config&action=get&xpath=/config/devices/entry/device-group&key=${apiKey}`;
  console.log('API Call 1 - Device Groups:', deviceGroupsUrl);
  
  let deviceGroupNames: string[] = [];
  try {
    const dgResponse = await fetch(deviceGroupsUrl);
    console.log(`Device Groups API Response Status: ${dgResponse.status} ${dgResponse.statusText}`);
    if (dgResponse.ok) {
      const dgXml = await dgResponse.text();
      console.log(`Device Groups API Response length: ${dgXml.length} chars`);
      console.log(`Device Groups API Response (first 500 chars): ${dgXml.substring(0, 500)}`);
      const dgData = parser.parse(dgXml);
      console.log('Parsed device groups data structure:', JSON.stringify(dgData.response?.result, null, 2));
      
      const deviceGroupResult = dgData.response?.result?.['device-group'];
      if (deviceGroupResult?.entry) {
        const entries = Array.isArray(deviceGroupResult.entry) 
          ? deviceGroupResult.entry 
          : [deviceGroupResult.entry];
        deviceGroupNames = entries.map((e: any) => e.name || e['@_name']).filter(Boolean);
        console.log(`Found ${deviceGroupNames.length} device groups:`, deviceGroupNames);
      } else if (dgData.response?.result?.entry) {
        const entries = Array.isArray(dgData.response.result.entry) 
          ? dgData.response.result.entry 
          : [dgData.response.result.entry];
        deviceGroupNames = entries.map((e: any) => e.name || e['@_name']).filter(Boolean);
        console.log(`Found ${deviceGroupNames.length} device groups (fallback path):`, deviceGroupNames);
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

  try {

    let entries: PanoramaRuleUseEntry[] = [];
    const deviceGroupsSet = new Set<string>();

    if (deviceGroupNames.length > 0) {
      console.log(`Querying rules and hit counts for ${deviceGroupNames.length} device groups...`);
      for (const dgName of deviceGroupNames) {
        deviceGroupsSet.add(dgName);
        try {
          console.log(`\n=== Processing Device Group: ${dgName} ===`);
          
          interface RuleInfo {
            name: string;
            rulebase: 'pre-rulebase' | 'post-rulebase';
          }
          
          const rulesToQuery: RuleInfo[] = [];
          
          try {
            console.log(`Fetching full rule list for device group "${dgName}"...`);
            
            const preConfigUrl = `${panoramaUrl}/api/?type=config&action=get&xpath=/config/devices/entry/device-group/entry[@name='${dgName}']/pre-rulebase/security/rules&key=${apiKey}`;
            console.log(`  Pre-rulebase config URL: ${preConfigUrl}`);
            const preConfigResponse = await fetch(preConfigUrl);
            console.log(`  Pre-rulebase response status: ${preConfigResponse.status} ${preConfigResponse.statusText}`);
            if (preConfigResponse.ok) {
              const preConfigXml = await preConfigResponse.text();
              console.log(`  Pre-rulebase XML length: ${preConfigXml.length} chars`);
              const preConfigData = parser.parse(preConfigXml);
              console.log(`  Pre-rulebase parsed structure:`, JSON.stringify(preConfigData.response?.result, null, 2));
              if (preConfigData.response?.result?.entry?.rules?.entry) {
                const rules = Array.isArray(preConfigData.response.result.entry.rules.entry)
                  ? preConfigData.response.result.entry.rules.entry
                  : [preConfigData.response.result.entry.rules.entry];
                const preRules = rules.map((r: any) => ({
                  name: r.name || r['@_name'],
                  rulebase: 'pre-rulebase' as const
                })).filter((r: RuleInfo) => r.name);
                rulesToQuery.push(...preRules);
                console.log(`Found ${preRules.length} rules in pre-rulebase for "${dgName}":`, preRules.map(r => r.name));
              } else {
                console.log(`  No rules found in pre-rulebase structure`);
              }
            } else {
              const errorText = await preConfigResponse.text();
              console.error(`  Pre-rulebase fetch failed: ${errorText.substring(0, 500)}`);
            }
            
            const postConfigUrl = `${panoramaUrl}/api/?type=config&action=get&xpath=/config/devices/entry/device-group/entry[@name='${dgName}']/post-rulebase/security/rules&key=${apiKey}`;
            console.log(`  Post-rulebase config URL: ${postConfigUrl}`);
            const postConfigResponse = await fetch(postConfigUrl);
            console.log(`  Post-rulebase response status: ${postConfigResponse.status} ${postConfigResponse.statusText}`);
            if (postConfigResponse.ok) {
              const postConfigXml = await postConfigResponse.text();
              console.log(`  Post-rulebase XML length: ${postConfigXml.length} chars`);
              const postConfigData = parser.parse(postConfigXml);
              console.log(`  Post-rulebase parsed structure:`, JSON.stringify(postConfigData.response?.result, null, 2));
              if (postConfigData.response?.result?.entry?.rules?.entry) {
                const rules = Array.isArray(postConfigData.response.result.entry.rules.entry)
                  ? postConfigData.response.result.entry.rules.entry
                  : [postConfigData.response.result.entry.rules.entry];
                const postRules = rules.map((r: any) => ({
                  name: r.name || r['@_name'],
                  rulebase: 'post-rulebase' as const
                })).filter((r: RuleInfo) => r.name);
                rulesToQuery.push(...postRules);
                console.log(`Found ${postRules.length} rules in post-rulebase for "${dgName}":`, postRules.map(r => r.name));
              } else {
                console.log(`  No rules found in post-rulebase structure`);
              }
            } else {
              const errorText = await postConfigResponse.text();
              console.error(`  Post-rulebase fetch failed: ${errorText.substring(0, 500)}`);
            }
            
            console.log(`Total rules to query: ${rulesToQuery.length} (${rulesToQuery.filter(r => r.rulebase === 'pre-rulebase').length} pre, ${rulesToQuery.filter(r => r.rulebase === 'post-rulebase').length} post)`);
            if (rulesToQuery.length === 0) {
              console.warn(`WARNING: No rules found for device group "${dgName}" - will fall back to all-rules query`);
            }
          } catch (error) {
            console.error(`Could not fetch rule list for ${dgName}:`, error);
            if (error instanceof Error) {
              console.error(`  Error message: ${error.message}`);
              console.error(`  Error stack: ${error.stack}`);
            }
          }

          if (rulesToQuery.length > 0) {
            console.log(`\n=== Starting individual rule queries for ${rulesToQuery.length} rules ===`);
            for (let i = 0; i < rulesToQuery.length; i++) {
              const ruleInfo = rulesToQuery[i];
              console.log(`\n[${i + 1}/${rulesToQuery.length}] Processing rule: "${ruleInfo.name}" (${ruleInfo.rulebase})`);
              try {
                const rulebaseXml = ruleInfo.rulebase === 'pre-rulebase' 
                  ? `<pre-rulebase><entry name="security"><rules><rule-name><entry name="${ruleInfo.name}"/></rule-name></rules></entry></pre-rulebase>`
                  : `<post-rulebase><entry name="security"><rules><rule-name><entry name="${ruleInfo.name}"/></rule-name></rules></entry></post-rulebase>`;
                
                const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}">${rulebaseXml}</entry></device-group></rule-hit-count></show>`;
                const apiUrl = `${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
                console.log(`  Querying rule "${ruleInfo.name}" in ${ruleInfo.rulebase} of device group "${dgName}"...`);
                console.log(`    XML Command: ${xmlCmd}`);
                
                const response = await fetch(apiUrl);
                if (response.ok) {
                  const xmlText = await response.text();
                  if (!xmlText.includes('<response status="error"')) {
                    const data: PanoramaResponse = parser.parse(xmlText);
                    const ruleHitCount = data.response?.result?.['rule-hit-count'];
                    if (ruleHitCount?.['device-group']?.entry) {
                      const deviceGroups = Array.isArray(ruleHitCount['device-group'].entry)
                        ? ruleHitCount['device-group'].entry
                        : [ruleHitCount['device-group'].entry];
                      
                      deviceGroups.forEach((dg: PanoramaDeviceGroupEntry) => {
                        const rulebases: PanoramaRuleBaseEntry[] = [];
                        if (dg['pre-rulebase']?.entry) {
                          const preEntries = Array.isArray(dg['pre-rulebase'].entry) ? dg['pre-rulebase'].entry : [dg['pre-rulebase'].entry];
                          rulebases.push(...preEntries);
                        }
                        if (dg['post-rulebase']?.entry) {
                          const postEntries = Array.isArray(dg['post-rulebase'].entry) ? dg['post-rulebase'].entry : [dg['post-rulebase'].entry];
                          rulebases.push(...postEntries);
                        }
                        if (dg['rule-base']?.entry) {
                          const ruleBaseEntries = Array.isArray(dg['rule-base'].entry) ? dg['rule-base'].entry : [dg['rule-base'].entry];
                          rulebases.push(...ruleBaseEntries);
                        }
                        
                        rulebases.forEach((rb: PanoramaRuleBaseEntry) => {
                          if (rb.rules?.entry) {
                            const ruleEntries = Array.isArray(rb.rules.entry) ? rb.rules.entry : [rb.rules.entry];
                            ruleEntries.forEach((ruleEntry: any) => {
                              if (ruleEntry && dg.name && (ruleEntry.name === ruleInfo.name || ruleEntry['@_name'] === ruleInfo.name)) {
                                const modTimestamp = ruleEntry['rule-modification-timestamp'];
                                const lastUsedDate = modTimestamp 
                                  ? new Date(parseInt(modTimestamp) * 1000).toISOString()
                                  : undefined;
                                
                                console.log(`    Rule "${ruleInfo.name}" response:`, JSON.stringify(ruleEntry, null, 2));
                                
                                const rule: PanoramaRuleUseEntry = {
                                  devicegroup: dg.name,
                                  rulebase: rb.name || 'security',
                                  rulename: ruleInfo.name,
                                  lastused: lastUsedDate,
                                  hitcnt: '0',
                                  target: ruleEntry['all-connected'] === 'yes' ? 'all' : undefined
                                };
                                
                                console.log(`    Rule "${ruleInfo.name}": Mod Timestamp: ${modTimestamp}, Last Modified: ${lastUsedDate}, Full entry:`, JSON.stringify(ruleEntry, null, 2));
                                entries.push(rule);
                              }
                            });
                          }
                        });
                      });
                    }
                  } else {
                    console.error(`    Rule "${ruleInfo.name}" returned error response`);
                  }
                } else {
                  console.error(`    Rule "${ruleInfo.name}" query failed: ${response.status} ${response.statusText}`);
                }
              } catch (error) {
                console.error(`Error querying rule "${ruleInfo.name}":`, error);
                if (error instanceof Error) {
                  console.error(`  Error details: ${error.message}`);
                }
              }
            }
            console.log(`\n=== Completed individual rule queries. Total entries collected: ${entries.length} ===`);
          } else {
            console.log(`No rules found to query individually for device group "${dgName}"`);
          }
          
          if (rulesToQuery.length === 0) {
            console.log(`Falling back to all-rules query for device group "${dgName}"...`);
            const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}"><pre-rulebase><entry name="security"><rules><all/></rules></entry></pre-rulebase><post-rulebase><entry name="security"><rules><all/></rules></entry></post-rulebase></entry></device-group></rule-hit-count></show>`;
            const apiUrl = `${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
            console.log(`API Call - Device Group "${dgName}" (all rules fallback):`, apiUrl);
            console.log(`  XML Command:`, xmlCmd);
          
            const response = await fetch(apiUrl, {
              method: 'GET',
              headers: {
                'Accept': 'application/xml',
              },
            });

            if (!response.ok) {
              console.log(`Failed to get rules for device group ${dgName}: ${response.status}`);
              continue;
            }

            const xmlText = await response.text();
            console.log(`Device Group "${dgName}" API Response length: ${xmlText.length} chars`);
            console.log(`Device Group "${dgName}" API Response (first 2000 chars): ${xmlText.substring(0, 2000)}`);
            
            if (xmlText.includes('<response status="error"')) {
              console.error(`Device Group "${dgName}" API returned an error response`);
              console.error(`Full error response: ${xmlText}`);
              continue;
            }
            
            const data: PanoramaResponse = parser.parse(xmlText);
            console.log(`Device Group "${dgName}" Parsed structure:`, JSON.stringify(data.response?.result, null, 2));
            
            const ruleHitCount = data.response?.result?.['rule-hit-count'];
            console.log(`Device Group "${dgName}" ruleHitCount structure:`, JSON.stringify(ruleHitCount, null, 2));
            
            if (!ruleHitCount) {
              console.log(`Device Group "${dgName}" - No rule-hit-count data in response`);
              continue;
            }
            
            if (ruleHitCount?.['device-group']?.entry) {
              const deviceGroups = Array.isArray(ruleHitCount['device-group'].entry)
                ? ruleHitCount['device-group'].entry
                : [ruleHitCount['device-group'].entry];
              
              deviceGroups.forEach((dg: PanoramaDeviceGroupEntry) => {
                const rulebases: PanoramaRuleBaseEntry[] = [];
                
                if (dg['pre-rulebase']?.entry) {
                  const preEntries = Array.isArray(dg['pre-rulebase'].entry) ? dg['pre-rulebase'].entry : [dg['pre-rulebase'].entry];
                  rulebases.push(...preEntries);
                }
                
                if (dg['post-rulebase']?.entry) {
                  const postEntries = Array.isArray(dg['post-rulebase'].entry) ? dg['post-rulebase'].entry : [dg['post-rulebase'].entry];
                  rulebases.push(...postEntries);
                }
                
                if (dg['rule-base']?.entry) {
                  const ruleBaseEntries = Array.isArray(dg['rule-base'].entry) ? dg['rule-base'].entry : [dg['rule-base'].entry];
                  rulebases.push(...ruleBaseEntries);
                }
                
                rulebases.forEach((rb: PanoramaRuleBaseEntry) => {
                  if (rb.rules?.entry) {
                    const ruleEntries = Array.isArray(rb.rules.entry) ? rb.rules.entry : [rb.rules.entry];
                    console.log(`Device Group "${dg.name}" - Found ${ruleEntries.length} rules in rulebase "${rb.name || 'security'}"`);
                    ruleEntries.forEach((ruleEntry: any) => {
                      if (ruleEntry && dg.name) {
                        const ruleName = ruleEntry.name || ruleEntry['@_name'];
                        if (!ruleName) {
                          console.log(`Skipping rule entry without name in device group ${dg.name}`);
                          return;
                        }
                        
                        const modTimestamp = ruleEntry['rule-modification-timestamp'];
                        const lastUsedDate = modTimestamp 
                          ? new Date(parseInt(modTimestamp) * 1000).toISOString()
                          : undefined;
                        
                        const rule: PanoramaRuleUseEntry = {
                          devicegroup: dg.name,
                          rulebase: rb.name || 'security',
                          rulename: ruleName,
                          lastused: lastUsedDate,
                          hitcnt: '0',
                          target: ruleEntry['all-connected'] === 'yes' ? 'all' : undefined
                        };
                        
                        console.log(`  Rule: "${ruleName}" - State: ${ruleEntry['rule-state']}, Mod Timestamp: ${modTimestamp}, Last Modified: ${lastUsedDate} (Note: No actual hit count data available)`);
                        entries.push(rule);
                      }
                    });
                  } else {
                    console.log(`Device Group "${dg.name}" - No rules found in rulebase "${rb.name || 'security'}"`);
                  }
                });
              });
            }
          }
        } catch (error) {
          console.error(`Error querying device group ${dgName}:`, error);
        }
      }
    } else {
      console.log('Trying alternative API command...');
      const xmlCmd = '<show><rule-hit-count></rule-hit-count></show>';
      const apiUrl = `${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
      console.log('API Call - Alternative:', apiUrl);
      console.log('  XML Command:', xmlCmd);
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/xml',
        },
      });

      if (!response.ok) {
        throw new Error(`Panorama API error: ${response.status} ${response.statusText}`);
      }

      const xmlText = await response.text();
      console.log('Panorama API Response length:', xmlText.length);
      console.log('Panorama API Response (first 2000 chars):', xmlText.substring(0, 2000));
      
      let data: PanoramaResponse;
      try {
        data = parser.parse(xmlText);
        console.log('Parsed data structure:', Object.keys(data.response?.result || {}));
      } catch (parseError) {
        console.error('XML Parse error:', parseError);
        console.error('XML text that failed to parse:', xmlText.substring(0, 500));
        throw new Error(`Failed to parse Panorama API response: ${parseError instanceof Error ? parseError.message : 'Unknown parse error'}`);
      }

      const ruleHitCount = data.response?.result?.['rule-hit-count'];
      const ruleUseData = data.response?.result?.['rule-use'] || data.response?.result?.['panorama-rule-use'];
      
      if (ruleHitCount?.['device-group']?.entry) {
        const deviceGroups = Array.isArray(ruleHitCount['device-group'].entry)
          ? ruleHitCount['device-group'].entry
          : [ruleHitCount['device-group'].entry];
        
        deviceGroups.forEach((dg: PanoramaDeviceGroupEntry) => {
          if (dg.name) {
            deviceGroupsSet.add(dg.name);
          }
          
          const rulebases: PanoramaRuleBaseEntry[] = [];
          
          if (dg['pre-rulebase']?.entry) {
            const preEntries = Array.isArray(dg['pre-rulebase'].entry) ? dg['pre-rulebase'].entry : [dg['pre-rulebase'].entry];
            rulebases.push(...preEntries);
          }
          
          if (dg['post-rulebase']?.entry) {
            const postEntries = Array.isArray(dg['post-rulebase'].entry) ? dg['post-rulebase'].entry : [dg['post-rulebase'].entry];
            rulebases.push(...postEntries);
          }
          
          if (dg['rule-base']?.entry) {
            const ruleBaseEntries = Array.isArray(dg['rule-base'].entry) ? dg['rule-base'].entry : [dg['rule-base'].entry];
            rulebases.push(...ruleBaseEntries);
          }
          
          rulebases.forEach((rb: PanoramaRuleBaseEntry) => {
            if (rb.rules?.entry) {
              const ruleEntries = Array.isArray(rb.rules.entry) ? rb.rules.entry : [rb.rules.entry];
              ruleEntries.forEach((ruleEntry: any) => {
                if (ruleEntry && dg.name) {
                  const rule: PanoramaRuleUseEntry = {
                    devicegroup: dg.name,
                    rulebase: rb.name || 'security',
                    rulename: ruleEntry.name || ruleEntry['@_name'],
                    lastused: ruleEntry['rule-modification-timestamp'] 
                      ? new Date(parseInt(ruleEntry['rule-modification-timestamp']) * 1000).toISOString()
                      : undefined,
                    hitcnt: '0',
                    target: ruleEntry['all-connected'] === 'yes' ? 'all' : undefined
                  };
                  entries.push(rule);
                }
              });
            }
          });
        });
      } else if (ruleUseData?.entry) {
        entries = Array.isArray(ruleUseData.entry)
          ? ruleUseData.entry
          : [ruleUseData.entry];
      }
    }
    
    const deviceGroups = Array.from(deviceGroupsSet).sort();
    console.log(`Collected ${deviceGroups.length} device groups:`, deviceGroups);
    
    if (entries.length === 0) {
      console.log('No entries found in response');
      return { rules: [], deviceGroups: deviceGroups };
    }
    
    console.log(`Found ${entries.length} rule entries to process`);
    if (entries.length > 0) {
      console.log(`Sample entries (first 3):`, entries.slice(0, 3).map(e => ({
        name: e.rulename,
        deviceGroup: e.devicegroup,
        lastModified: e.lastused,
        note: 'No actual hit count data available from API'
      })));
    }

    const rules: PanoramaRule[] = [];
    const ruleMap = new Map<string, PanoramaRule>();

    entries.forEach((entry, index) => {
      console.log(`Entry ${index}:`, JSON.stringify(entry, null, 2));
      if (entry.devicegroup) {
        deviceGroupsSet.add(entry.devicegroup);
        console.log(`Added device group: ${entry.devicegroup}`);
      }
      if (!entry.rulename || !entry.devicegroup) {
        console.log(`Skipping entry ${index}: missing rulename or devicegroup`);
        return;
      }

      const ruleKey = `${entry.devicegroup}:${entry.rulename}`;
      const isShared = entry.devicegroup === 'Shared';
      const hitCount = 0;
      
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

    const now = new Date();
    const unusedThreshold = new Date(now.getTime() - unusedDays * 24 * 60 * 60 * 1000);

    processedRules.forEach(rule => {
      if (rule.isShared) {
        rule.action = 'IGNORE';
        return;
      }

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

    const finalDeviceGroups = Array.from(deviceGroupsSet).sort();
    console.log(`Returning ${processedRules.length} rules and ${finalDeviceGroups.length} device groups:`, finalDeviceGroups);
    
    return {
      rules: processedRules,
      deviceGroups: finalDeviceGroups
    };
  } catch (error) {
    console.error('Panorama API error:', error);
    throw error;
  }
}
