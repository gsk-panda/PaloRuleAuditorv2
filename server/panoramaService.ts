import { PanoramaRule, HAPair } from '../types.js';
import { XMLParser } from 'fast-xml-parser';
import { getHitCountsViaSsh, type PanoramaSshConfig } from './panoramaSsh.js';

interface PanoramaRuleUseEntry {
  rulebase?: string;
  devicegroup?: string;
  rulename?: string;
  lastused?: string;
  hitcnt?: string;
  target?: string | string[] | Array<{ entry?: string }>;
  modificationTimestamp?: string;
  creationTimestamp?: string;
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

function getVsysEntryName(vsysEntry: PanoramaDeviceVsysEntry): string | undefined {
  const attr = (vsysEntry as Record<string, unknown>)['@_name'];
  return vsysEntry.name ?? (typeof attr === 'string' ? attr : undefined);
}

function parseTs(val: unknown): number | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  const n = parseInt(String(val), 10);
  return isNaN(n) ? undefined : n;
}

function parseHitCount(val: unknown): number {
  const n = parseInt(String(val ?? 0), 10);
  return isNaN(n) ? 0 : n;
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
// Batch size for rule-hit-count API queries. Larger = fewer round-trips.
// Panorama handles up to ~500 rule names per op command safely; 50 is conservative.
const RULE_HIT_COUNT_CHUNK_SIZE = 50;

/**
 * Depth-aware XML parser that extracts the `name` attribute of all top-level
 * `<entry>` elements inside a block of XML text.  This avoids relying on
 * fast-xml-parser, which struggles to array-ify entries when the surrounding
 * container has deeply-nested, heterogeneous child content.
 */
function extractTopLevelEntryNames(xml: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < xml.length) {
    const tagStart = xml.indexOf('<', i);
    if (tagStart === -1) break;
    const tagEnd = xml.indexOf('>', tagStart);
    if (tagEnd === -1) break;
    const rawTag = xml.substring(tagStart + 1, tagEnd).trim();
    // Skip XML comments
    if (rawTag.startsWith('!--')) { i = tagEnd + 1; continue; }
    const isSelfClosing = rawTag.endsWith('/');
    const isClosing = rawTag.startsWith('/');
    if (isClosing) {
      depth--;
    } else if (!isSelfClosing) {
      if (depth === 0 && rawTag.startsWith('entry')) {
        const m = rawTag.match(/name="([^"]+)"/);
        if (m) names.push(m[1]);
      }
      depth++;
    }
    i = tagEnd + 1;
  }
  return names;
}

/**
 * Fetch all device group names from Panorama config.
 *
 * Uses `action=get` on the device-group XPath and parses the raw XML with a
 * depth-aware character parser — this correctly returns ALL device groups
 * (including those with no connected firewalls) regardless of how complex
 * their nested content is.
 *
 * The `show devicegroups` op command only returns groups with currently
 * connected/managed devices, so it is NOT used here.
 */
/** Fetches a map of device serial → hostname from Panorama's connected device list. */
async function fetchDeviceHostnameMap(panoramaUrl: string, apiKey: string): Promise<Map<string, string>> {
  const hostnameMap = new Map<string, string>();
  try {
    const cmd = '<show><devices><connected/></devices></show>';
    const url = `${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(cmd)}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return hostnameMap;
    const data = parser.parse(await res.text());
    const deviceEntries = data.response?.result?.devices?.entry;
    if (!deviceEntries) return hostnameMap;
    const entries = Array.isArray(deviceEntries) ? deviceEntries : [deviceEntries];
    entries.forEach((entry: any) => {
      const serial: string = String(entry.serial || entry['@_name'] || entry.name || '');
      const hostname: string = String(entry.hostname || '');
      if (serial && hostname) {
        // Store both the raw value (parser may strip leading zeros) and zero-padded to 12 digits,
        // since device-vsys entry names in hit-count responses use the zero-padded serial.
        hostnameMap.set(serial, hostname);
        hostnameMap.set(serial.padStart(12, '0'), hostname);
      }
    });
    console.log(`  Device hostname map: ${hostnameMap.size / 2} devices`);
    hostnameMap.forEach((h, s) => console.log(`    ${s} → ${h}`));
  } catch (err) {
    console.warn('  fetchDeviceHostnameMap failed:', err instanceof Error ? err.message : String(err));
  }
  return hostnameMap;
}

export async function fetchDeviceGroupNames(
  panoramaUrl: string,
  apiKey: string,
  panoramaDeviceName: string = 'localhost.localdomain'
): Promise<string[]> {
  const xpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group`;
  const apiUrl = `${panoramaUrl}/api/?type=config&action=get&xpath=${encodeURIComponent(xpath)}&key=${apiKey}`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`Device group fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();

  if (!xml.includes('status="success"')) {
    const errMatch = xml.match(/<msg>([\s\S]*?)<\/msg>/);
    throw new Error(`Panorama API error: ${errMatch ? errMatch[1].trim() : xml.substring(0, 200)}`);
  }

  // Locate the <device-group>...</device-group> block in the raw XML response.
  const dgStart = xml.indexOf('<device-group>');
  const dgEnd = xml.lastIndexOf('</device-group>');
  if (dgStart === -1 || dgEnd === -1) {
    console.warn('fetchDeviceGroupNames: no <device-group> section found in response');
    return [];
  }
  const dgContent = xml.substring(dgStart + '<device-group>'.length, dgEnd);
  const names = extractTopLevelEntryNames(dgContent);
  console.log(`fetchDeviceGroupNames: ${names.length} device groups:`, names);
  return names;
}

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
  rulesProcessed: number;
}

export async function auditPanoramaRules(
  panoramaUrl: string,
  apiKey: string,
  unusedDays: number,
  haPairs: HAPair[],
  onProgress?: (message: string) => void,
  sshConfig?: PanoramaSshConfig | null
): Promise<AuditResult> {
  try {
    const haMap = new Map<string, string>();
    haPairs.forEach(pair => {
      haMap.set(pair.fw1, pair.fw2);
      haMap.set(pair.fw2, pair.fw1);
    });

    const panoramaDeviceName = 'localhost.localdomain';

    // Fetch serial → hostname map for display names
    const hostnameMap = await fetchDeviceHostnameMap(panoramaUrl, apiKey);

    onProgress?.('Fetching device groups...');
    console.log('Step 1: Fetching device groups list...');
    let deviceGroupNames: string[] = [];
    try {
      deviceGroupNames = await fetchDeviceGroupNames(panoramaUrl, apiKey, panoramaDeviceName);
      console.log(`Found ${deviceGroupNames.length} device groups:`, deviceGroupNames);
    } catch (error) {
      console.error('Could not fetch device groups list:', error);
    }

    if (deviceGroupNames.length === 0) {
      console.log('No device groups found, skipping audit');
      return { rules: [], deviceGroups: [], rulesProcessed: 0 };
    }

    console.log(`\nStep 2: Processing ${deviceGroupNames.length} device groups...`);
    
    let entries: PanoramaRuleUseEntry[] = [];
    const deviceGroupsSet = new Set<string>();
    let rulesProcessed = 0;
    const protectedRuleSet = new Set<string>();

    for (const dgName of deviceGroupNames) {
      onProgress?.(`Processing device group: ${dgName}`);
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
        rulesProcessed += rules.length;

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

        const uniqueRuleNames = [...new Set(ruleNames)];
        if (uniqueRuleNames.length < ruleNames.length) {
          console.log(`    Deduplicating rule names for hit-count request: ${ruleNames.length} -> ${uniqueRuleNames.length}`);
        }

        if (sshConfig) {
          try {
            const sshEntries = await getHitCountsViaSsh(sshConfig, dgName, onProgress);
            console.log(`  SSH returned ${sshEntries.length} entries for "${dgName}"`);
            if (sshEntries.length > 0) {
              entries.push(...sshEntries);
              deviceGroupsSet.add(dgName);
              continue;
            }
            console.log(`  SSH returned 0 entries for "${dgName}", falling back to API`);
            onProgress?.(`SSH returned no data for ${dgName}, using API.`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  SSH hit counts failed for "${dgName}":`, msg);
            onProgress?.(`SSH failed for ${dgName}: ${msg}. Falling back to API.`);
          }
        }

        try {
          // Query hit counts in chunks using the <rule-name> container format.
          // Panorama returns per-device-vsys hit counts (real firewall data) with this form.
          // If a chunk fails with "duplicate node" (rule exists in both shared and device-group
          // pre-rulebase), we strip that rule from the batch and retry automatically.
          console.log(`    Querying hit counts for ${uniqueRuleNames.length} rules in device group "${dgName}" (in chunks of ${RULE_HIT_COUNT_CHUNK_SIZE})`);
          const allChunkRuleEntries: any[] = [];
          const skippedDuplicates = new Set<string>();

          for (let i = 0; i < uniqueRuleNames.length; i += RULE_HIT_COUNT_CHUNK_SIZE) {
            if ((i + 1) % 25 === 0 || i + 1 === uniqueRuleNames.length) {
              onProgress?.(`Processing device group: ${dgName} (${i + 1}/${uniqueRuleNames.length} rules)`);
            }
            let chunk = uniqueRuleNames.slice(i, i + RULE_HIT_COUNT_CHUNK_SIZE);
            const chunkNum = Math.floor(i / RULE_HIT_COUNT_CHUNK_SIZE) + 1;

            // Retry loop: strip duplicate-node rules and retry until the chunk succeeds or is empty
            const maxAttempts = chunk.length; // capture before chunk shrinks during retries
            for (let attempt = 0; attempt <= maxAttempts; attempt++) {
              if (chunk.length === 0) break;

              const ruleNameEntries = chunk.map(name => `<entry name="${name}"/>`).join('');
              const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}"><pre-rulebase><entry name="security"><rules><rule-name>${ruleNameEntries}</rule-name></rules></entry></pre-rulebase></entry></device-group></rule-hit-count></show>`;
              const apiUrl = `${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
              const response = await fetch(apiUrl);
              if (!response.ok) {
                console.error(`    Chunk ${chunkNum} (attempt ${attempt + 1}) failed: ${response.status} ${response.statusText}`);
                break;
              }
              const xmlText = await response.text();

              if (xmlText.includes('<response status="error"')) {
                const msgMatch = xmlText.match(/<msg[^>]*>([\s\S]*?)<\/msg>/);
                const msg = msgMatch ? msgMatch[1].trim() : xmlText.substring(0, 500);

                // Check for "duplicate node" — extract the conflicting rule name and retry without it
                const dupMatch = msg.match(/rule-name\s*->\s*(.+?)\s+is a duplicate node/);
                if (dupMatch) {
                  const dupRule = dupMatch[1].trim();
                  console.warn(`    Chunk ${chunkNum}: rule "${dupRule}" has a naming conflict (shared/DG rulebase duplicate) — skipping it and retrying`);
                  skippedDuplicates.add(dupRule);
                  chunk = chunk.filter(n => n !== dupRule);
                  continue; // retry with smaller chunk
                }

                console.error(`    Chunk ${chunkNum} (attempt ${attempt + 1}) error: ${msg.substring(0, 300)}`);
                break;
              }

              // Success — collect rule entries from the response
              const data: PanoramaResponse = parser.parse(xmlText);
              const ruleHitCount = data.response?.result?.['rule-hit-count'];
              if (ruleHitCount?.['device-group']?.entry) {
                const chunkDgs = Array.isArray(ruleHitCount['device-group'].entry)
                  ? ruleHitCount['device-group'].entry
                  : [ruleHitCount['device-group'].entry];
                chunkDgs.forEach((dg: PanoramaDeviceGroupEntry) => {
                  const collectRuleEntries = (ruleBase: PanoramaRuleBaseEntry | PanoramaRuleBaseEntry[] | undefined) => {
                    if (!ruleBase) return;
                    const bases = Array.isArray(ruleBase) ? ruleBase : [ruleBase];
                    bases.forEach((rb: PanoramaRuleBaseEntry) => {
                      if (rb.rules?.entry) {
                        const ents = Array.isArray(rb.rules.entry) ? rb.rules.entry : [rb.rules.entry];
                        allChunkRuleEntries.push(...ents);
                      }
                    });
                  };
                  collectRuleEntries(dg['pre-rulebase']?.entry);
                  collectRuleEntries(dg['rule-base']?.entry);
                });
              }
              break; // chunk done
            }
          }

          if (skippedDuplicates.size > 0) {
            // Panorama rejects multiple <entry> elements inside <rule-name> for some device groups —
            // it works fine when each rule is queried individually. Query each one-at-a-time.
            console.warn(`    ${skippedDuplicates.size} rule(s) failed in batch — querying each individually: ${[...skippedDuplicates].join(', ')}`);
            for (const dupRule of skippedDuplicates) {
              const escapedName = dupRule.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
              const singleXmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}"><pre-rulebase><entry name="security"><rules><rule-name><entry name="${escapedName}"/></rule-name></rules></entry></pre-rulebase></entry></device-group></rule-hit-count></show>`;
              const singleApiUrl = `${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(singleXmlCmd)}&key=${apiKey}`;
              try {
                const singleResp = await fetch(singleApiUrl);
                if (!singleResp.ok) {
                  console.error(`    Individual query for "${dupRule}": HTTP ${singleResp.status}`);
                  continue;
                }
                const singleXml = await singleResp.text();
                if (singleXml.includes('<response status="error"')) {
                  const m = singleXml.match(/<msg[^>]*>([\s\S]*?)<\/msg>/);
                  console.error(`    Individual query for "${dupRule}" error: ${m ? m[1].trim().substring(0, 200) : 'unknown'}`);
                  continue;
                }
                const singleData: PanoramaResponse = parser.parse(singleXml);
                const rhc = singleData.response?.result?.['rule-hit-count'];
                if (rhc?.['device-group']?.entry) {
                  const dgEs = Array.isArray(rhc['device-group'].entry) ? rhc['device-group'].entry : [rhc['device-group'].entry];
                  dgEs.forEach((dge: PanoramaDeviceGroupEntry) => {
                    const collect = (rb: PanoramaRuleBaseEntry | PanoramaRuleBaseEntry[] | undefined) => {
                      if (!rb) return;
                      (Array.isArray(rb) ? rb : [rb]).forEach((b: PanoramaRuleBaseEntry) => {
                        if (b.rules?.entry) {
                          const ents = Array.isArray(b.rules.entry) ? b.rules.entry : [b.rules.entry];
                          allChunkRuleEntries.push(...ents);
                        }
                      });
                    };
                    collect(dge['pre-rulebase']?.entry);
                    collect(dge['rule-base']?.entry);
                  });
                }
                console.log(`    Individual query for "${dupRule}": OK`);
              } catch (singleErr) {
                console.error(`    Individual query for "${dupRule}" exception:`, singleErr instanceof Error ? singleErr.message : String(singleErr));
              }
            }
          }
          if (allChunkRuleEntries.length === 0) {
            console.error(`    No hit count data for device group "${dgName}" (all chunks failed or empty)`);
            continue;
          }
          console.log(`    API returned ${allChunkRuleEntries.length} rule entries for "${dgName}"`);
          const merged: PanoramaDeviceGroupEntry = {
            'pre-rulebase': {
              entry: { name: 'security', rules: { entry: allChunkRuleEntries } }
            }
          };
          const deviceGroups = [merged];

          deviceGroups.forEach((dg: PanoramaDeviceGroupEntry) => {
            const processRuleBase = (ruleBase: PanoramaRuleBaseEntry | PanoramaRuleBaseEntry[], rulebaseType: string) => {
              const ruleBaseEntries = Array.isArray(ruleBase) ? ruleBase : [ruleBase];
              ruleBaseEntries.forEach((rb: PanoramaRuleBaseEntry) => {
                if (rb.rules?.entry) {
                  const ruleEntries = Array.isArray(rb.rules.entry) ? rb.rules.entry : [rb.rules.entry];
                  ruleEntries.forEach((ruleEntry: any) => {
                    const ruleName = ruleEntry?.name || ruleEntry?.['@_name'];
                    if (!ruleName || !uniqueRuleNames.includes(ruleName)) {
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
                        const hitCount = parseHitCount(vsysEntry['hit-count']);
                        totalHitCount += hitCount;
                        
                        const lastHitTs = parseTs(vsysEntry['last-hit-timestamp']);
                        const modTs = parseTs(vsysEntry['rule-modification-timestamp']);
                        
                        if (lastHitTs !== undefined && lastHitTs > 0 && (!latestLastHitTimestamp || lastHitTs > parseInt(latestLastHitTimestamp || '0'))) {
                          latestLastHitTimestamp = String(lastHitTs);
                        }
                        
                        if (modTs !== undefined && (!latestModificationTimestamp || modTs > parseInt(latestModificationTimestamp || '0'))) {
                          latestModificationTimestamp = String(modTs);
                        }
                        
                        if (vsysEntry['all-connected'] === 'yes') {
                          allConnected = true;
                        } else {
                          const entryName = getVsysEntryName(vsysEntry);
                          if (entryName) {
                            const parts = entryName.split('/');
                            const deviceId = parts.length >= 2 ? parts[1] : parts[0];
                            if (deviceId && !targets.includes(deviceId)) {
                              targets.push(deviceId);
                            }
                          }
                        }
                      });
                      
                      deviceVsysEntries.forEach((vsysEntry: PanoramaDeviceVsysEntry) => {
                        const perDeviceHitCount = parseHitCount(vsysEntry['hit-count']);
                        const lastHitTs = parseTs(vsysEntry['last-hit-timestamp']);
                        const modTs = parseTs(vsysEntry['rule-modification-timestamp']);
                        const creationTs = parseTs(vsysEntry['rule-creation-timestamp']);
                        let lastUsedDate: string | undefined;
                        if (perDeviceHitCount > 0 && lastHitTs !== undefined && lastHitTs > 0) {
                          lastUsedDate = new Date(lastHitTs * 1000).toISOString();
                        } else if (creationTs !== undefined) {
                          lastUsedDate = new Date(creationTs * 1000).toISOString();
                        }
                        const entryName = getVsysEntryName(vsysEntry);
                        let deviceId: string | undefined;
                        if (entryName) {
                          const parts = entryName.split('/');
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
                          modificationTimestamp: modTs !== undefined ? String(modTs) : undefined,
                          creationTimestamp: creationTs !== undefined ? String(creationTs) : undefined
                        };
                        entries.push(perTarget);
                      });
                      return;
                    }
                    
                    let latestCreationTimestamp: string | undefined;
                    {
                      const lastHitTs = parseTs(ruleEntry['last-hit-timestamp']);
                      const modTs = parseTs(ruleEntry['rule-modification-timestamp']);
                      const creationTs = parseTs(ruleEntry['rule-creation-timestamp']);
                      totalHitCount = parseHitCount(ruleEntry['hit-count'] || ruleEntry['hitcount']);
                      if (lastHitTs !== undefined && lastHitTs > 0) latestLastHitTimestamp = String(lastHitTs);
                      if (modTs !== undefined) latestModificationTimestamp = String(modTs);
                      if (creationTs !== undefined) latestCreationTimestamp = String(creationTs);
                      if (ruleEntry['all-connected'] === 'yes') allConnected = true;
                    }

                    let lastUsedDate: string | undefined;
                    let usedTimestampLabel = '';
                    const lht = parseTs(latestLastHitTimestamp);
                    const lct = parseTs(latestCreationTimestamp);
                    if (lht !== undefined && lht > 0) {
                      lastUsedDate = new Date(lht * 1000).toISOString();
                    } else if (lct !== undefined) {
                      lastUsedDate = new Date(lct * 1000).toISOString();
                      usedTimestampLabel = ' (using creation timestamp)';
                    }

                    console.log(`    Rule "${ruleName}": Last Hit Timestamp: ${latestLastHitTimestamp}, Creation Timestamp: ${latestCreationTimestamp}, Total Hit Count: ${totalHitCount}, Last Used: ${lastUsedDate}${usedTimestampLabel}`);
                    
                    const rule: PanoramaRuleUseEntry = {
                      devicegroup: dgName,
                      rulebase: rulebaseType,
                      rulename: ruleName,
                      lastused: lastUsedDate,
                      hitcnt: totalHitCount.toString(),
                      target: allConnected ? 'all' : (targets.length > 0 ? targets : undefined),
                      modificationTimestamp: latestModificationTimestamp,
                      creationTimestamp: latestCreationTimestamp
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
      console.log('No entries found - check that hit count API/SSH returns data and device-vsys entries have name attribute');
      return { rules: [], deviceGroups: deviceGroups, rulesProcessed };
    }

    const now = new Date();
    const unusedThreshold = new Date(now.getTime() - unusedDays * 24 * 60 * 60 * 1000);
    console.log(`Filtering rules that haven't been hit since ${unusedThreshold.toISOString()} (${unusedDays} days ago)`);

    // Determine which rules qualify for audit: a rule qualifies if AT LEAST ONE of its
    // per-target entries has a lastused date older than the threshold (or no lastused at all).
    // IMPORTANT: once a rule qualifies, ALL of its per-target entries must be included in the
    // ruleMap — including entries for active targets (e.g. Corp with recent hits). Without this,
    // active targets get silently dropped before the ruleMap is built, causing rules targeted to
    // "Any" to show only the inactive device and incorrectly receive a DISABLE action instead of
    // HA-PROTECTED / UNTARGET.
    const entriesByRule = new Map<string, PanoramaRuleUseEntry[]>();
    entries.forEach(entry => {
      if (!entry.rulename || !entry.devicegroup) return;
      const ruleKey = `${entry.devicegroup}:${entry.rulename}`;
      if (!entriesByRule.has(ruleKey)) entriesByRule.set(ruleKey, []);
      entriesByRule.get(ruleKey)!.push(entry);
    });

    const qualifyingRuleKeys = new Set<string>();
    entriesByRule.forEach((ruleEntries, ruleKey) => {
      const hasUnusedTarget = ruleEntries.some(entry => {
        if (!entry.lastused) return true;
        return new Date(entry.lastused) < unusedThreshold;
      });
      if (hasUnusedTarget) qualifyingRuleKeys.add(ruleKey);
    });

    // Include ALL entries for qualifying rules (not just the unused-target ones)
    const filteredEntries = entries.filter(entry => {
      if (!entry.rulename || !entry.devicegroup) return false;
      const ruleKey = `${entry.devicegroup}:${entry.rulename}`;
      return qualifyingRuleKeys.has(ruleKey);
    });

    console.log(`Filtered ${entries.length} entries down to ${filteredEntries.length} entries (${qualifyingRuleKeys.size} qualifying rules with at least one unused target)`);

    if (filteredEntries.length === 0) {
      const sampleLastUsed = entries.slice(0, 5).map((e) => ({ rulename: e.rulename, lastused: e.lastused, hitcnt: e.hitcnt }));
      console.log('No unused rules found - all entries may have lastused after threshold. Sample:', JSON.stringify(sampleLastUsed));
      return { rules: [], deviceGroups: deviceGroups, rulesProcessed };
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
      
      const entryHitCount = parseInt(entry.hitcnt || '0', 10);
      targets.forEach(targetName => {
        const existingTarget = rule.targets.find(t => t.name === targetName);
        if (existingTarget) {
          existingTarget.hitCount += entryHitCount;
          existingTarget.hasHits = existingTarget.hitCount > 0;
          // Keep the latest per-target last hit date
          if (entry.lastused && (!existingTarget.lastHitDate || new Date(entry.lastused) > new Date(existingTarget.lastHitDate))) {
            existingTarget.lastHitDate = entry.lastused;
          }
        } else {
          rule.targets.push({
            name: targetName,
            displayName: hostnameMap.get(targetName) || undefined,
            hasHits: entryHitCount > 0,
            hitCount: entryHitCount,
            haPartner: haMap.get(targetName) || undefined,
            lastHitDate: entry.lastused,
          });
        }
      });

      rule.totalHits = Math.max(rule.totalHits, hitCount);
      if (lastUsed && (!rule.lastHitDate || new Date(rule.lastHitDate) < lastUsed)) {
        rule.lastHitDate = lastUsed.toISOString();
      }
      // Store the earliest creation timestamp seen across all entries for this rule
      if (entry.creationTimestamp) {
        const creationDate = new Date(parseInt(entry.creationTimestamp) * 1000).toISOString();
        if (!rule.createdDate || creationDate < rule.createdDate) {
          rule.createdDate = creationDate;
        }
      }
    });

    const processedRules = Array.from(ruleMap.values());

    processedRules.forEach(rule => {
      const firewallsToUntarget = new Set<string>();
      const processed = new Set<string>();
      let hasHAProtection = false;

      rule.targets.forEach(target => {
        if (processed.has(target.name)) return;

        // Use per-target lastHitDate for accurate comparison; fall back to rule aggregate.
        // isUnused = true means this target's last hit was before the threshold window.
        const targetLastHit = target.lastHitDate
          ? new Date(target.lastHitDate)
          : new Date(rule.lastHitDate);
        const isUnused = targetLastHit < unusedThreshold;

        if (target.haPartner) {
          const partner = rule.targets.find(t => t.name === target.haPartner);
          if (partner) {
            const partnerLastHit = partner.lastHitDate
              ? new Date(partner.lastHitDate)
              : new Date(rule.lastHitDate);
            const partnerIsUnused = partnerLastHit < unusedThreshold;

            if (!isUnused || !partnerIsUnused) {
              // At least one of the HA pair has been hit recently → HA-protected
              firewallsToUntarget.delete(target.name);
              firewallsToUntarget.delete(partner.name);
              hasHAProtection = true;
            } else {
              // Both sides of the HA pair are unused within the threshold
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

    console.log(`Returning ${processedRules.length} unused rules and ${deviceGroups.length} device groups (${rulesProcessed} rules processed):`, deviceGroups);
    
    return {
      rules: processedRules,
      deviceGroups: deviceGroups,
      rulesProcessed
    };
  } catch (error) {
    console.error('Panorama API error:', error);
    throw error;
  }
}

export async function auditDisabledRules(
  panoramaUrl: string,
  apiKey: string,
  disabledDays: number,
  onProgress?: (message: string) => void
): Promise<AuditResult> {
  try {
    const panoramaDeviceName = 'localhost.localdomain';

    onProgress?.('Fetching device groups...');
    console.log('Step 1: Fetching device groups list...');
    let deviceGroupNames: string[] = [];
    try {
      deviceGroupNames = await fetchDeviceGroupNames(panoramaUrl, apiKey, panoramaDeviceName);
      console.log(`Found ${deviceGroupNames.length} device groups:`, deviceGroupNames);
    } catch (error) {
      console.error('Could not fetch device groups list:', error);
    }

    if (deviceGroupNames.length === 0) {
      console.log('No device groups found, skipping audit');
      return { rules: [], deviceGroups: [], rulesProcessed: 0 };
    }

    console.log(`\nStep 2: Processing ${deviceGroupNames.length} device groups for disabled rules...`);
    
    const disabledRules: PanoramaRule[] = [];
    const deviceGroupsSet = new Set<string>();
    let rulesProcessed = 0;
    const now = new Date();
    const disabledThreshold = new Date(now.getTime() - disabledDays * 24 * 60 * 60 * 1000);
    console.log(`Looking for rules disabled before ${disabledThreshold.toISOString()} (${disabledDays} days ago)`);

    for (const dgName of deviceGroupNames) {
      onProgress?.(`Processing device group: ${dgName}`);
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
        rulesProcessed += rules.length;

        console.log(`  Querying hit counts for ${rules.length} disabled rules (chunked)...`);
        
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

        const uniqueRuleNames = [...new Set(ruleNames)];
        if (uniqueRuleNames.length < ruleNames.length) {
          console.log(`    Deduplicating rule names for hit-count request: ${ruleNames.length} -> ${uniqueRuleNames.length}`);
        }

        const ruleDataMap = new Map<string, { modificationTimestamp?: string; hitCount: number }>();

        try {
          console.log(`    Querying hit counts for ${uniqueRuleNames.length} disabled rules in device group "${dgName}" (in chunks of ${RULE_HIT_COUNT_CHUNK_SIZE})`);
          for (let i = 0; i < uniqueRuleNames.length; i += RULE_HIT_COUNT_CHUNK_SIZE) {
            if ((i + 1) % 25 === 0 || i + 1 === uniqueRuleNames.length) {
              onProgress?.(`Processing device group: ${dgName} (${i + 1}/${uniqueRuleNames.length} rules)`);
            }
            const chunk = uniqueRuleNames.slice(i, i + RULE_HIT_COUNT_CHUNK_SIZE);
            // Entries go directly under <rules> — no <rule-name> wrapper
            const ruleEntryXml = chunk.map(name => `<entry name="${name}"/>`).join('');
            const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}"><pre-rulebase><entry name="security"><rules>${ruleEntryXml}</rules></entry></pre-rulebase></entry></device-group></rule-hit-count></show>`;
            const apiUrl = `${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
            const response = await fetch(apiUrl);
            if (!response.ok) {
              console.error(`    Chunk ${Math.floor(i / RULE_HIT_COUNT_CHUNK_SIZE) + 1} failed: ${response.status} ${response.statusText}`);
              continue;
            }
            const xmlText = await response.text();
            if (xmlText.includes('<response status="error"')) {
              const msgMatch = xmlText.match(/<msg[^>]*>([\s\S]*?)<\/msg>/);
              const msg = msgMatch ? msgMatch[1].trim().substring(0, 300) : xmlText.substring(0, 300);
              console.error(`    Chunk ${Math.floor(i / RULE_HIT_COUNT_CHUNK_SIZE) + 1} error: ${msg}`);
              continue;
            }
            const data: PanoramaResponse = parser.parse(xmlText);
            const ruleHitCount = data.response?.result?.['rule-hit-count'];
            if (!ruleHitCount?.['device-group']?.entry) continue;
            const deviceGroups = Array.isArray(ruleHitCount['device-group'].entry)
              ? ruleHitCount['device-group'].entry
              : [ruleHitCount['device-group'].entry];
            deviceGroups.forEach((dg: PanoramaDeviceGroupEntry) => {
              const processRuleBase = (ruleBase: PanoramaRuleBaseEntry | PanoramaRuleBaseEntry[] | undefined) => {
                if (!ruleBase) return;
                const ruleBaseEntries = Array.isArray(ruleBase) ? ruleBase : [ruleBase];
                ruleBaseEntries.forEach((rb: PanoramaRuleBaseEntry) => {
                  if (rb.rules?.entry) {
                    const ruleEntries = Array.isArray(rb.rules.entry) ? rb.rules.entry : [rb.rules.entry];
                    ruleEntries.forEach((ruleEntry: any) => {
                      const ruleName = ruleEntry?.name || ruleEntry?.['@_name'];
                      if (!ruleName || !uniqueRuleNames.includes(ruleName)) return;
                      let modificationTimestamp: string | undefined;
                      let hitCount = 0;
                      if (ruleEntry['device-vsys']?.entry) {
                        const deviceVsysEntries = Array.isArray(ruleEntry['device-vsys'].entry)
                          ? ruleEntry['device-vsys'].entry
                          : [ruleEntry['device-vsys'].entry];
                        deviceVsysEntries.forEach((vsysEntry: PanoramaDeviceVsysEntry) => {
                          const ts = parseTs(vsysEntry['rule-modification-timestamp']);
                          if (ts !== undefined && (!modificationTimestamp || ts > parseInt(modificationTimestamp || '0'))) {
                            modificationTimestamp = String(ts);
                          }
                          hitCount += parseHitCount(vsysEntry['hit-count']);
                        });
                      } else {
                        const ts = parseTs(ruleEntry['rule-modification-timestamp']);
                        if (ts !== undefined && (!modificationTimestamp || ts > parseInt(modificationTimestamp || '0'))) {
                          modificationTimestamp = String(ts);
                        }
                        hitCount += parseHitCount(ruleEntry['hit-count']);
                      }
                      ruleDataMap.set(ruleName, { modificationTimestamp, hitCount });
                    });
                  }
                });
              };
              processRuleBase(dg['pre-rulebase']?.entry);
              processRuleBase(dg['rule-base']?.entry);
            }); // deviceGroups.forEach
          } // for chunk loop

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

    const deviceGroups = [...new Set(disabledRules.map((r) => r.deviceGroup))].sort();
    console.log(`\nFound ${disabledRules.length} rules disabled for more than ${disabledDays} days across ${deviceGroups.length} device groups (${rulesProcessed} rules processed)`);
    onProgress?.(`Found ${disabledRules.length} rules disabled for more than ${disabledDays} days`);
    
    return {
      rules: disabledRules,
      deviceGroups: deviceGroups,
      rulesProcessed
    };
  } catch (error) {
    console.error('Panorama API error:', error);
    throw error;
  }
}
