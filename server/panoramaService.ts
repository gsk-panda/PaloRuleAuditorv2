import { PanoramaRule, HAPair } from '../types.js';
import { XMLParser } from 'fast-xml-parser';

interface PanoramaRuleUseEntry {
  rulebase?: string;
  devicegroup?: string;
  rulename?: string;
  lastused?: string;
  hitcnt?: string;
  target?: string | string[] | Array<{ entry?: string }>;
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

interface PanoramaDeviceVsysEntry {
  name?: string;
  'hit-count'?: string;
  'last-hit-timestamp'?: string;
  'rule-modification-timestamp'?: string;
  'all-connected'?: string;
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

const CONFIG_PAGE_LIMIT = 2000;

export async function fetchConfigPaginated(
  panoramaUrl: string,
  apiKey: string,
  xpath: string
): Promise<{ response?: { result?: any } }> {
  const baseUrl = `${panoramaUrl}/api/?type=config&action=get&xpath=${encodeURIComponent(xpath)}&key=${apiKey}`;
  let offset = 0;
  const allEntries: any[] = [];
  let entryKey: string | null = null;

  while (true) {
    const url = offset === 0 ? baseUrl : `${baseUrl}&limit=${CONFIG_PAGE_LIMIT}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Config get failed: ${res.status} ${res.statusText} - ${errText.substring(0, 300)}`);
    }
    const xml = await res.text();
    const data = parser.parse(xml);
    const result = data.response?.result;
    if (!result) {
      if (offset === 0) return data;
      break;
    }
    const totalAttr = result['total-count'] ?? result['total_count'];
    const countAttr = result['count'];
    if (entryKey == null) {
      if (result.rules?.entry != null) entryKey = 'rules';
      else if (result['device-group']?.entry != null) entryKey = 'device-group';
      else {
        if (offset === 0) return data;
        break;
      }
    }
    const container = entryKey === 'rules' ? result.rules : result['device-group'];
    const entries = container?.entry != null
      ? (Array.isArray(container.entry) ? container.entry : [container.entry])
      : [];
    allEntries.push(...entries);
    const total = totalAttr != null ? Number(totalAttr) : null;
    const count = countAttr != null ? Number(countAttr) : entries.length;
    if (total != null && total <= allEntries.length) break;
    if (count === 0 || entries.length === 0) break;
    offset += CONFIG_PAGE_LIMIT;
  }

  if (entryKey == null || allEntries.length === 0) {
    return { response: { result: entryKey === 'rules' ? { rules: { entry: [] } } : { 'device-group': { entry: [] } } } };
  }
  const merged =
    entryKey === 'rules'
      ? { rules: { entry: allEntries } }
      : { 'device-group': { entry: allEntries } };
  return { response: { result: merged } };
}

function hasProtectTag(rule: any): boolean {
  if (!rule.tag) {
    return false;
  }
  
  const tag = rule.tag;
  if (tag.member) {
    const members = Array.isArray(tag.member) ? tag.member : [tag.member];
    return members.some((m: any) => {
      const memberValue = typeof m === 'string' ? m : (m._text || m);
      return memberValue === 'PROTECT';
    });
  }
  
  return false;
}

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
    const deviceGroupXpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group`;
    console.log('API Call - Device Groups (paginated):', deviceGroupXpath);
    let deviceGroupNames: string[] = [];
    try {
      const dgData = await fetchConfigPaginated(panoramaUrl, apiKey, deviceGroupXpath);
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
    const protectedRuleSet = new Set<string>();

    for (const dgName of deviceGroupNames) {
      console.log(`\n=== Processing Device Group: ${dgName} ===`);
      
      try {
        console.log(`Step 2: Fetching pre-rulebase rules for device group "${dgName}"...`);
        const preRulesXpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group/entry[@name='${dgName}']/pre-rulebase/security/rules`;
        let rules: any[] = [];
        try {
          const preConfigData = await fetchConfigPaginated(panoramaUrl, apiKey, preRulesXpath);
          const result = preConfigData.response?.result;
          if (result?.rules?.entry) {
            rules = Array.isArray(result.rules.entry) ? result.rules.entry : [result.rules.entry];
          } else if (result?.entry?.rules?.entry) {
            rules = Array.isArray(result.entry.rules.entry) ? result.entry.rules.entry : [result.entry.rules.entry];
          }
        } catch (err) {
          console.error(`  Pre-rulebase fetch failed:`, err instanceof Error ? err.message : err);
          continue;
        }
        
        rules.forEach((rule: any) => {
          const ruleName = rule.name || rule['@_name'];
          if (ruleName && hasProtectTag(rule)) {
            const protectedKey = `${dgName}:${ruleName}`;
            protectedRuleSet.add(protectedKey);
            console.log(`  Rule "${ruleName}" in device group "${dgName}" has PROTECT tag - will be protected from disable/delete`);
          }
        });
        
        rules = rules.filter((rule: any) => {
          const disabled = rule.disabled || rule['@_disabled'];
          if (disabled === 'yes') {
            const ruleName = rule.name || rule['@_name'];
            console.log(`  Skipping disabled rule: "${ruleName}"`);
            return false;
          }
          return true;
        });
        
        if (rules.length === 0) {
          console.log(`  Step 3: No enabled rules found for device group "${dgName}" - skipping`);
          continue;
        }

        console.log(`  Found ${rules.length} rules in pre-rulebase for "${dgName}"`);
        deviceGroupsSet.add(dgName);

        console.log(`\nStep 4: Querying hit counts for ${rules.length} rules (batched)...`);
        
        const ruleNames: string[] = [];
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i];
          const ruleName = rule.name || rule['@_name'] || rule['name'];
          if (ruleName) {
            ruleNames.push(ruleName);
          }
        }

        if (ruleNames.length === 0) {
          console.log(`  No valid rule names found for device group "${dgName}"`);
          continue;
        }

        try {
          const ruleNameEntries = ruleNames.map(name => `<entry name="${name}"/>`).join('');
          const rulebaseXml = `<pre-rulebase><entry name="security"><rules><rule-name>${ruleNameEntries}</rule-name></rules></entry></pre-rulebase>`;
          const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}">${rulebaseXml}</entry></device-group></rule-hit-count></show>`;
          const apiUrl = `${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
          console.log(`    Querying hit counts for ${ruleNames.length} rules in device group "${dgName}"`);
          
          const response = await fetch(apiUrl);
          if (!response.ok) {
            console.error(`    Batch query failed: ${response.status} ${response.statusText}`);
            continue;
          }

          const xmlText = await response.text();
          if (xmlText.includes('<response status="error"')) {
            console.error(`    Batch query returned error response`);
            continue;
          }

          const data: PanoramaResponse = parser.parse(xmlText);
          const ruleHitCount = data.response?.result?.['rule-hit-count'];
          if (!ruleHitCount?.['device-group']?.entry) {
            console.error(`    No hit count data in batch response`);
            continue;
          }

          const deviceGroups = Array.isArray(ruleHitCount['device-group'].entry)
            ? ruleHitCount['device-group'].entry
            : [ruleHitCount['device-group'].entry];
          
          deviceGroups.forEach((dg: PanoramaDeviceGroupEntry) => {
            const processRuleBase = (ruleBase: PanoramaRuleBaseEntry | PanoramaRuleBaseEntry[], rulebaseType: string) => {
              const ruleBaseEntries = Array.isArray(ruleBase) ? ruleBase : [ruleBase];
              ruleBaseEntries.forEach((rb: PanoramaRuleBaseEntry) => {
                if (rb.rules?.entry) {
                  const ruleEntries = Array.isArray(rb.rules.entry) ? rb.rules.entry : [rb.rules.entry];
                  ruleEntries.forEach((ruleEntry: any) => {
                    const ruleName = ruleEntry?.name || ruleEntry?.['@_name'];
                    if (!ruleName || !ruleNames.includes(ruleName)) {
                      return;
                    }

                    let totalHitCount = 0;
                    let latestLastHitTimestamp: string | undefined;
                    let latestModificationTimestamp: string | undefined;
                    let allConnected = false;
                    const targets: string[] = [];
                    
                    if (ruleEntry['device-vsys']?.entry) {
                      const deviceVsysEntries = Array.isArray(ruleEntry['device-vsys'].entry) 
                        ? ruleEntry['device-vsys'].entry 
                        : [ruleEntry['device-vsys'].entry];
                      
                      deviceVsysEntries.forEach((vsysEntry: PanoramaDeviceVsysEntry) => {
                        const hitCount = parseInt(vsysEntry['hit-count'] || '0', 10);
                        totalHitCount += hitCount;
                        
                        const lastHitTs = vsysEntry['last-hit-timestamp'];
                        const modTs = vsysEntry['rule-modification-timestamp'];
                        
                        if (lastHitTs && (!latestLastHitTimestamp || parseInt(lastHitTs) > parseInt(latestLastHitTimestamp))) {
                          latestLastHitTimestamp = lastHitTs;
                        }
                        
                        if (modTs && (!latestModificationTimestamp || parseInt(modTs) > parseInt(latestModificationTimestamp))) {
                          latestModificationTimestamp = modTs;
                        }
                        
                        if (vsysEntry['all-connected'] === 'yes') {
                          allConnected = true;
                        } else if (vsysEntry.name) {
                          const parts = vsysEntry.name.split('/');
                          const deviceId = parts.length >= 2 ? parts[1] : parts[0];
                          if (deviceId && !targets.includes(deviceId)) {
                            targets.push(deviceId);
                          }
                        }
                      });
                      
                      deviceVsysEntries.forEach((vsysEntry: PanoramaDeviceVsysEntry) => {
                        const perDeviceHitCount = parseInt(vsysEntry['hit-count'] || '0', 10);
                        const lastHitTs = vsysEntry['last-hit-timestamp'];
                        const modTs = vsysEntry['rule-modification-timestamp'];
                        let lastUsedDate: string | undefined;
                        if (lastHitTs && parseInt(lastHitTs) !== 0) {
                          lastUsedDate = new Date(parseInt(lastHitTs) * 1000).toISOString();
                        } else if (modTs) {
                          lastUsedDate = new Date(parseInt(modTs) * 1000).toISOString();
                        }
                        let deviceId: string | undefined;
                        if (vsysEntry.name) {
                          const parts = vsysEntry.name.split('/');
                          deviceId = parts.length >= 2 ? parts[1] : parts[0];
                        }
                        if (!deviceId) return;
                        const perTarget: PanoramaRuleUseEntry = {
                          devicegroup: dgName,
                          rulebase: rulebaseType,
                          rulename: ruleName,
                          lastused: lastUsedDate,
                          hitcnt: perDeviceHitCount.toString(),
                          target: [deviceId],
                          modificationTimestamp: modTs
                        };
                        entries.push(perTarget);
                      });
                      return;
                    }
                    
                    {
                      const lastHitTimestamp = ruleEntry['last-hit-timestamp'];
                      const modificationTimestamp = ruleEntry['rule-modification-timestamp'];
                      const hitCount = ruleEntry['hit-count'] || ruleEntry['hitcount'] || '0';
                      totalHitCount = parseInt(hitCount, 10);
                      latestLastHitTimestamp = lastHitTimestamp;
                      latestModificationTimestamp = modificationTimestamp;
                      if (ruleEntry['all-connected'] === 'yes') {
                        allConnected = true;
                      }
                    }
                    
                    let lastUsedDate: string | undefined;
                    let useModificationTimestamp = false;
                    
                    if (latestLastHitTimestamp && parseInt(latestLastHitTimestamp) !== 0) {
                      lastUsedDate = new Date(parseInt(latestLastHitTimestamp) * 1000).toISOString();
                    } else if (latestModificationTimestamp) {
                      lastUsedDate = new Date(parseInt(latestModificationTimestamp) * 1000).toISOString();
                      useModificationTimestamp = true;
                    }
                    
                    console.log(`    Rule "${ruleName}": Last Hit Timestamp: ${latestLastHitTimestamp}, Modification Timestamp: ${latestModificationTimestamp}, Total Hit Count: ${totalHitCount}, Last Used: ${lastUsedDate}${useModificationTimestamp ? ' (using modification timestamp)' : ''}`);
                    
                    const rule: PanoramaRuleUseEntry = {
                      devicegroup: dgName,
                      rulebase: rulebaseType,
                      rulename: ruleName,
                      lastused: lastUsedDate,
                      hitcnt: totalHitCount.toString(),
                      target: allConnected ? 'all' : (targets.length > 0 ? targets : undefined),
                      modificationTimestamp: latestModificationTimestamp
                    };
                    
                    entries.push(rule);
                  });
                }
              });
            };

            if (dg['pre-rulebase']?.entry) {
              processRuleBase(dg['pre-rulebase'].entry, 'pre-rulebase');
            }
            if (dg['rule-base']?.entry) {
              processRuleBase(dg['rule-base'].entry, 'rule-base');
            }
          });
        } catch (error) {
          console.error(`Error querying rules for device group "${dgName}":`, error);
          if (error instanceof Error) {
            console.error(`  Error details: ${error.message}`);
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
            if (typeof t === 'string' && t !== 'all') targets.push(t);
            else if (t && typeof t === 'object' && 'entry' in t && (t as { entry: string }).entry !== 'all') targets.push((t as { entry: string }).entry);
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
      let hasHAProtection = false;

      rule.targets.forEach(target => {
        if (processed.has(target.name)) return;

        const lastHit = new Date(rule.lastHitDate);
        const isUnused = !target.hasHits && lastHit < unusedThreshold;

        if (target.haPartner) {
          const partner = rule.targets.find(t => t.name === target.haPartner);
          if (partner) {
            const partnerLastHit = new Date(rule.lastHitDate);
            const partnerIsUnused = !partner.hasHits && partnerLastHit < unusedThreshold;
            
            if (target.hasHits || partner.hasHits) {
              firewallsToUntarget.delete(target.name);
              firewallsToUntarget.delete(partner.name);
              hasHAProtection = true;
            } else if (isUnused && partnerIsUnused) {
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

      const protectedKey = `${rule.deviceGroup}:${rule.name}`;
      if (protectedRuleSet.has(protectedKey)) {
        rule.action = 'PROTECTED';
      } else if (hasHAProtection && firewallsToUntarget.size === 0) {
        rule.action = 'HA-PROTECTED';
      } else if (firewallsToUntarget.size === rule.targets.length && rule.targets.length > 0) {
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

export async function auditDisabledRules(
  panoramaUrl: string,
  apiKey: string,
  disabledDays: number
): Promise<AuditResult> {
  try {
    const panoramaDeviceName = 'localhost.localdomain';

    console.log('Step 1: Fetching device groups list...');
    const deviceGroupXpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group`;
    console.log('API Call - Device Groups (paginated):', deviceGroupXpath);
    let deviceGroupNames: string[] = [];
    try {
      const dgData = await fetchConfigPaginated(panoramaUrl, apiKey, deviceGroupXpath);
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

    console.log(`\nStep 2: Processing ${deviceGroupNames.length} device groups for disabled rules...`);
    
    const disabledRules: PanoramaRule[] = [];
    const deviceGroupsSet = new Set<string>();
    const now = new Date();
    const disabledThreshold = new Date(now.getTime() - disabledDays * 24 * 60 * 60 * 1000);
    console.log(`Looking for rules disabled before ${disabledThreshold.toISOString()} (${disabledDays} days ago)`);

    for (const dgName of deviceGroupNames) {
      console.log(`\n=== Processing Device Group: ${dgName} ===`);
      
      try {
        console.log(`Fetching pre-rulebase rules for device group "${dgName}"...`);
        const preRulesXpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group/entry[@name='${dgName}']/pre-rulebase/security/rules`;
        let rules: any[] = [];
        try {
          const preConfigData = await fetchConfigPaginated(panoramaUrl, apiKey, preRulesXpath);
          const result = preConfigData.response?.result;
          if (result?.rules?.entry) {
            rules = Array.isArray(result.rules.entry) ? result.rules.entry : [result.rules.entry];
          } else if (result?.entry?.rules?.entry) {
            rules = Array.isArray(result.entry.rules.entry) ? result.entry.rules.entry : [result.entry.rules.entry];
          }
        } catch (err) {
          console.error(`  Pre-rulebase fetch failed:`, err instanceof Error ? err.message : err);
          continue;
        }
        
        const protectedRuleSet = new Set<string>();
        rules.forEach((rule: any) => {
          const ruleName = rule.name || rule['@_name'];
          if (ruleName && hasProtectTag(rule)) {
            const protectedKey = `${dgName}:${ruleName}`;
            protectedRuleSet.add(protectedKey);
            console.log(`  Rule "${ruleName}" in device group "${dgName}" has PROTECT tag - will be protected from deletion`);
          }
        });
        
        rules = rules.filter((rule: any) => {
          const disabled = rule.disabled || rule['@_disabled'];
          if (disabled === 'yes') {
            const ruleName = rule.name || rule['@_name'];
            console.log(`  Found disabled rule: "${ruleName}"`);
            return true;
          }
          return false;
        });
        
        if (rules.length === 0) {
          console.log(`  No disabled rules found for device group "${dgName}"`);
          continue;
        }

        console.log(`  Found ${rules.length} disabled rules in "${dgName}"`);
        deviceGroupsSet.add(dgName);

        console.log(`  Querying hit counts for ${rules.length} disabled rules (batched)...`);
        
        const ruleNames: string[] = [];
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i];
          const ruleName = rule.name || rule['@_name'] || rule['name'];
          if (ruleName) {
            ruleNames.push(ruleName);
          }
        }

        if (ruleNames.length === 0) {
          console.log(`  No valid rule names found for device group "${dgName}"`);
          continue;
        }

        try {
          const ruleNameEntries = ruleNames.map(name => `<entry name="${name}"/>`).join('');
          const rulebaseXml = `<pre-rulebase><entry name="security"><rules><rule-name>${ruleNameEntries}</rule-name></rules></entry></pre-rulebase>`;
          const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}">${rulebaseXml}</entry></device-group></rule-hit-count></show>`;
          const apiUrl = `${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
          console.log(`    Querying hit counts for ${ruleNames.length} disabled rules in device group "${dgName}"`);
          
          const response = await fetch(apiUrl);
          if (!response.ok) {
            console.error(`    Batch query failed: ${response.status} ${response.statusText}`);
            continue;
          }

          const xmlText = await response.text();
          if (xmlText.includes('<response status="error"')) {
            console.error(`    Batch query returned error response`);
            continue;
          }

          const data: PanoramaResponse = parser.parse(xmlText);
          const ruleHitCount = data.response?.result?.['rule-hit-count'];
          
          const ruleDataMap = new Map<string, { modificationTimestamp?: string; hitCount: number }>();
          
          if (ruleHitCount?.['device-group']?.entry) {
            const deviceGroups = Array.isArray(ruleHitCount['device-group'].entry)
              ? ruleHitCount['device-group'].entry
              : [ruleHitCount['device-group'].entry];
            
            deviceGroups.forEach((dg: PanoramaDeviceGroupEntry) => {
              const processRuleBase = (ruleBase: PanoramaRuleBaseEntry | PanoramaRuleBaseEntry[]) => {
                const ruleBaseEntries = Array.isArray(ruleBase) ? ruleBase : [ruleBase];
                ruleBaseEntries.forEach((rb: PanoramaRuleBaseEntry) => {
                  if (rb.rules?.entry) {
                    const ruleEntries = Array.isArray(rb.rules.entry) ? rb.rules.entry : [rb.rules.entry];
                    ruleEntries.forEach((ruleEntry: any) => {
                      const ruleName = ruleEntry?.name || ruleEntry?.['@_name'];
                      if (!ruleName || !ruleNames.includes(ruleName)) {
                        return;
                      }

                      let modificationTimestamp: string | undefined;
                      let hitCount = 0;
                      
                      if (ruleEntry['device-vsys']?.entry) {
                        const deviceVsysEntries = Array.isArray(ruleEntry['device-vsys'].entry) 
                          ? ruleEntry['device-vsys'].entry 
                          : [ruleEntry['device-vsys'].entry];
                        
                        deviceVsysEntries.forEach((vsysEntry: PanoramaDeviceVsysEntry) => {
                          const ts = vsysEntry['rule-modification-timestamp'];
                          if (ts && (!modificationTimestamp || parseInt(ts) > parseInt(modificationTimestamp || '0'))) {
                            modificationTimestamp = ts;
                          }
                          const hitCountStr = vsysEntry['hit-count'] || '0';
                          hitCount += parseInt(hitCountStr, 10);
                        });
                      } else {
                        const ts = ruleEntry['rule-modification-timestamp'];
                        if (ts && (!modificationTimestamp || parseInt(ts) > parseInt(modificationTimestamp || '0'))) {
                          modificationTimestamp = ts;
                        }
                        const hitCountStr = ruleEntry['hit-count'] || '0';
                        hitCount += parseInt(hitCountStr, 10);
                      }
                      
                      ruleDataMap.set(ruleName, { modificationTimestamp, hitCount });
                    });
                  }
                });
              };

              if (dg['pre-rulebase']?.entry) {
                processRuleBase(dg['pre-rulebase'].entry);
              }
              if (dg['rule-base']?.entry) {
                processRuleBase(dg['rule-base'].entry);
              }
            });
          }
          
          for (const ruleName of ruleNames) {
            const ruleData = ruleDataMap.get(ruleName);
            const modificationTimestamp = ruleData?.modificationTimestamp;
            const hitCount = ruleData?.hitCount || 0;
            
            let disabledDate: Date | null = null;
            if (modificationTimestamp) {
              disabledDate = new Date(parseInt(modificationTimestamp) * 1000);
            }
            
            const protectedKey = `${dgName}:${ruleName}`;
            const isProtected = protectedRuleSet.has(protectedKey);
            
            if (isProtected) {
              console.log(`    Rule "${ruleName}" has PROTECT tag - marking as protected (disabled on ${disabledDate ? disabledDate.toISOString() : 'unknown date'}, hit count: ${hitCount})`);
              
              const panoramaRule: PanoramaRule = {
                id: `disabled-rule-${disabledRules.length}`,
                name: ruleName,
                deviceGroup: dgName,
                totalHits: hitCount,
                lastHitDate: disabledDate ? disabledDate.toISOString() : new Date(0).toISOString(),
                targets: [],
                action: 'PROTECTED',
                isShared: false,
              };
              
              disabledRules.push(panoramaRule);
            } else if (!disabledDate || disabledDate < disabledThreshold) {
              console.log(`    Rule "${ruleName}" disabled on ${disabledDate ? disabledDate.toISOString() : 'unknown date'} - older than ${disabledDays} days (hit count: ${hitCount})`);
              
              const panoramaRule: PanoramaRule = {
                id: `disabled-rule-${disabledRules.length}`,
                name: ruleName,
                deviceGroup: dgName,
                totalHits: hitCount,
                lastHitDate: disabledDate ? disabledDate.toISOString() : new Date(0).toISOString(),
                targets: [],
                action: 'DISABLE',
                isShared: false,
              };
              
              disabledRules.push(panoramaRule);
            } else {
              console.log(`    Rule "${ruleName}" disabled on ${disabledDate.toISOString()} - within ${disabledDays} days threshold`);
            }
          }
        } catch (error) {
          console.error(`Error querying disabled rules for device group "${dgName}":`, error);
          if (error instanceof Error) {
            console.error(`  Error details: ${error.message}`);
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

    const deviceGroups = Array.from(deviceGroupsSet).sort();
    console.log(`\nFound ${disabledRules.length} rules disabled for more than ${disabledDays} days across ${deviceGroups.length} device groups`);
    
    return {
      rules: disabledRules,
      deviceGroups: deviceGroups
    };
  } catch (error) {
    console.error('Panorama API error:', error);
    throw error;
  }
}
