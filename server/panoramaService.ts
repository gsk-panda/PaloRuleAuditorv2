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
  // Try multiple possible locations for the name
  const attr = (vsysEntry as Record<string, unknown>)['@_name'];
  const name = vsysEntry.name ?? (typeof attr === 'string' ? attr : undefined);
  
  // Debug log to help diagnose device-vsys entry name issues
  if (name) {
    console.log(`  Found device-vsys entry name: ${name}`);
  }
  
  return name;
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
    // Use <all/> instead of <connected/> so offline/intermittent branch devices are included
    const cmd = '<show><devices><all/></devices></show>';
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
        
        // For AWS-Cloud, AWS GovCloud, and Azure GovCloud devices, also store mappings with common prefixes removed
        // This helps with matching HA pairs when the hostname doesn't exactly match the configured pair
        if (hostname.includes('AWS') || hostname.includes('Cloud') || hostname.includes('Azure') || hostname.includes('Gov')) {
          // For AWS GovCloud and Azure GovCloud, store the hostname directly with the serial
          // This ensures these devices always show their hostname instead of serial
          if (hostname.includes('GovCloud') || 
              (hostname.includes('Gov') && (hostname.includes('AWS') || hostname.includes('Azure')))) {
            // Store the hostname directly with the serial for GovCloud devices
            console.log(`  Adding direct mapping for GovCloud device: ${serial} → ${hostname}`);
            // Store both with the original serial and zero-padded serial
            hostnameMap.set(serial, hostname);
            hostnameMap.set(serial.padStart(12, '0'), hostname);
          }
          
          // Remove common prefixes that might be in the hostname but not in HA pair config
          const simplifiedName = hostname
            .replace(/^AWS[-\s]*/i, '')
            .replace(/^Cloud[-\s]*/i, '')
            .replace(/^Azure[-\s]*/i, '')
            .replace(/Gov(?:Cloud|ernment)[-\s]*/i, '')
            .trim();
          
          if (simplifiedName !== hostname) {
            console.log(`  Adding simplified mapping for cloud device: ${serial} → ${simplifiedName} (original: ${hostname})`);
            hostnameMap.set(`${serial}-simplified`, simplifiedName);
            
            // Also store the simplified mapping directly with the serial
            // This helps when the device is referenced by serial but needs to display the simplified name
            hostnameMap.set(`${serial}-direct-simplified`, simplifiedName);
            hostnameMap.set(`${serial.padStart(12, '0')}-direct-simplified`, simplifiedName);
            console.log(`  Added direct simplified mapping for cloud device: ${serial}`);
          }
        }
      }
    });
    console.log(`  Device hostname map: ${hostnameMap.size / 2} devices`);
    hostnameMap.forEach((h, s) => {
      // Don't log simplified mappings to avoid cluttering the console
      if (!s.endsWith('-simplified')) {
        console.log(`    ${s} → ${h}`);
      }
    });
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

/** Extracts the date from a disabled-YYYYMMDD tag, returns ISO string or undefined. */
function extractDisabledTagDate(rule: any): string | undefined {
  if (!rule.tag) return undefined;
  const members = rule.tag.member
    ? (Array.isArray(rule.tag.member) ? rule.tag.member : [rule.tag.member])
    : [];
  for (const m of members) {
    const val = String(typeof m === 'string' ? m : (m._text ?? m));
    const match = val.match(/^disabled-(\d{4})(\d{2})(\d{2})$/i);
    if (match) {
      return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`).toISOString();
    }
  }
  return undefined;
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

export interface RuleStatistics {
  totalRules: number;
  activeRules?: number;
  disabledRules?: number;
  permanentlyDisabledRules?: number;
  temporarilyDisabledRules?: number;
}

export interface AuditResult {
  rules: PanoramaRule[];
  deviceGroups: string[];
  rulesProcessed: number;
  statistics?: RuleStatistics;
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

    // Extend haMap with serial-keyed entries so that per-target lookups work correctly.
    // Users configure HA pairs by hostname (e.g. "Corp" ↔ "Corp-2"), but target.name is
    // the device serial extracted from device-vsys entry names (e.g. "001234567890").
    // Without this, haMap.get(serial) always returns undefined and haPartner is never set,
    // so the HA-PROTECTED branch in action determination never fires.
    const hostnameToSerial = new Map<string, string>();
    const serialToHostnames = new Map<string, string[]>();
    
    // First, build a map of all hostnames to serials and serials to hostnames
    hostnameMap.forEach((hostname, serial) => {
      // Skip the simplified mappings as they're just for lookup
      if (serial.endsWith('-simplified')) return;
      
      // Normalize to lowercase so HA pair lookups are case-insensitive
      // (hostnameMap may have "CORP" while user typed "corp" in the HA pairs config)
      const key = hostname.toLowerCase();
      const existing = hostnameToSerial.get(key);
      // Prefer the longest (zero-padded) serial to match device-vsys entry name format
      if (!existing || serial.length > existing.length) {
        hostnameToSerial.set(key, serial);
      }
      
      // Also build a reverse mapping of serial to all its possible hostnames
      if (!serialToHostnames.has(serial)) {
        serialToHostnames.set(serial, []);
      }
      serialToHostnames.get(serial)!.push(hostname);
    });
    
    // For AWS-Cloud devices, add simplified hostname mappings
    hostnameMap.forEach((hostname, serial) => {
      if (serial.endsWith('-simplified')) {
        const actualSerial = serial.replace(/-simplified$/, '');
        const simplifiedName = hostname.toLowerCase();
        hostnameToSerial.set(simplifiedName, actualSerial);
      }
    });
    
    // Now map HA pairs using the enhanced hostname mapping
    haPairs.forEach(pair => {
      // Try direct lookup first
      let serial1 = hostnameToSerial.get(pair.fw1.toLowerCase());
      let serial2 = hostnameToSerial.get(pair.fw2.toLowerCase());
      
      // If direct lookup fails, try partial matching for cloud devices (AWS, Azure, GovCloud)
      if (!serial1 || !serial2) {
        console.log(`  Attempting partial matching for HA pair "${pair.fw1}" ↔ "${pair.fw2}"`);
        
        // For each serial, check if any of its hostnames contain the HA pair name
        serialToHostnames.forEach((hostnames, serial) => {
          hostnames.forEach(hostname => {
            const lowerHostname = hostname.toLowerCase();
            const fw1Lower = pair.fw1.toLowerCase();
            const fw2Lower = pair.fw2.toLowerCase();
            
            // Check for exact match first
            if (!serial1 && lowerHostname === fw1Lower) {
              serial1 = serial;
              console.log(`  Found exact match for ${pair.fw1}: ${hostname} (${serial})`);
            }
            
            if (!serial2 && lowerHostname === fw2Lower) {
              serial2 = serial;
              console.log(`  Found exact match for ${pair.fw2}: ${hostname} (${serial})`);
            }
            
            // If still no match, try partial matching
            if (!serial1) {
              // Try to match with various cloud naming patterns
              const isMatch = lowerHostname.includes(fw1Lower) || 
                             // Handle cases where "AWS-" or "Cloud-" might be in the hostname but not in the HA pair name
                             (fw1Lower.includes('aws') && lowerHostname.includes('aws')) ||
                             (fw1Lower.includes('azure') && lowerHostname.includes('azure')) ||
                             (fw1Lower.includes('gov') && lowerHostname.includes('gov')) ||
                             (fw1Lower.includes('cloud') && lowerHostname.includes('cloud'));
                             
              if (isMatch) {
                serial1 = serial;
                console.log(`  Found partial match for ${pair.fw1}: ${hostname} (${serial})`);
              }
            }
            
            if (!serial2) {
              // Try to match with various cloud naming patterns
              const isMatch = lowerHostname.includes(fw2Lower) || 
                             // Handle cases where "AWS-" or "Cloud-" might be in the hostname but not in the HA pair name
                             (fw2Lower.includes('aws') && lowerHostname.includes('aws')) ||
                             (fw2Lower.includes('azure') && lowerHostname.includes('azure')) ||
                             (fw2Lower.includes('gov') && lowerHostname.includes('gov')) ||
                             (fw2Lower.includes('cloud') && lowerHostname.includes('cloud'));
                             
              if (isMatch) {
                serial2 = serial;
                console.log(`  Found partial match for ${pair.fw2}: ${hostname} (${serial})`);
              }
            }
          });
        });
      }
      
      if (serial1 && serial2) {
        haMap.set(serial1, serial2);
        haMap.set(serial2, serial1);
        console.log(`  HA pair (serial-mapped): ${pair.fw1} (${serial1}) ↔ ${pair.fw2} (${serial2})`);
      } else {
        console.warn(`  HA pair "${pair.fw1}" ↔ "${pair.fw2}": could not resolve serials (${serial1 ?? 'unknown'} / ${serial2 ?? 'unknown'}) — check that both devices appear in connected-device list`);
      }
    });

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

        // Only audit allow rules — deny/drop rules don't need usage-based cleanup
        rules = rules.filter((rule: any) => {
          const action = rule.action;
          const actionStr = typeof action === 'string' ? action.toLowerCase() : (action?._text ?? '').toLowerCase();
          if (actionStr && actionStr !== 'allow') {
            const ruleName = rule.name || rule['@_name'];
            console.log(`  Skipping non-allow rule ("${actionStr}"): "${ruleName}"`);
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

            // Process chunk: if we encounter duplicate nodes, collect them all before retrying
            let success = false;
            while (!success && chunk.length > 0) {
              const ruleNameEntries = chunk.map(name => `<entry name="${name}"/>`).join('');
              const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}"><pre-rulebase><entry name="security"><rules><rule-name>${ruleNameEntries}</rule-name></rules></entry></pre-rulebase></entry></device-group></rule-hit-count></show>`;
              const apiUrl = `${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
              const response = await fetch(apiUrl);
              
              if (!response.ok) {
                console.error(`    Chunk ${chunkNum} failed: ${response.status} ${response.statusText}`);
                break;
              }
              
              const xmlText = await response.text();

              if (xmlText.includes('<response status="error"')) {
                const msgMatch = xmlText.match(/<msg[^>]*>([\s\S]*?)<\/msg>/);
                const msg = msgMatch ? msgMatch[1].trim() : xmlText.substring(0, 500);

                // Check for "duplicate node" — extract the conflicting rule name
                const dupMatch = msg.match(/rule-name\s*->\s*(.+?)\s+is a duplicate node/);
                if (dupMatch) {
                  const dupRule = dupMatch[1].trim();
                  
                  // Add to skipped duplicates set and remove from current chunk
                  skippedDuplicates.add(dupRule);
                  chunk = chunk.filter(n => n !== dupRule);
                  
                  // Instead of logging for every conflict, just count them
                  // We'll log a summary at the end
                  continue; // Try again with the filtered chunk
                } else {
                  // Some other error occurred
                  console.error(`    Chunk ${chunkNum} error: ${msg.substring(0, 300)}`);
                  break;
                }
              } else {
                // Success - no more conflicts in this chunk
                success = true;
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
            console.warn(`    ${skippedDuplicates.size} rule(s) with naming conflicts — querying each individually`);
            // Log the first few rules as examples, but not all of them to avoid log spam
            const exampleRules = [...skippedDuplicates].slice(0, 3);
            if (exampleRules.length > 0) {
              console.warn(`    Examples: ${exampleRules.join(', ')}${skippedDuplicates.size > 3 ? ` and ${skippedDuplicates.size - 3} more...` : ''}`);
            }
            
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
                // Don't log success for every individual rule to reduce log spam
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
                    let latestCreationTimestamp: string | undefined;
                    let allConnected = false;
                    const targets: string[] = [];
                    
                    // Process target information
                    if (ruleEntry.target) {
                      // Check if the rule targets all devices in the group via negate=no
                      if (ruleEntry.target.negate === 'no') {
                        allConnected = true;
                        console.log(`  Rule ${ruleName} targets all devices in the group via negate=no`);
                      }
                      
                      // Check for specific device targets
                      if (ruleEntry.target.devices?.entry) {
                        const deviceEntries = Array.isArray(ruleEntry.target.devices.entry) 
                          ? ruleEntry.target.devices.entry 
                          : [ruleEntry.target.devices.entry];
                        
                        console.log(`  Found ${deviceEntries.length} device targets for rule ${ruleName}`);
                        
                        deviceEntries.forEach((device: any) => {
                          const deviceName = device.name;
                          if (deviceName && !targets.includes(deviceName)) {
                            targets.push(deviceName);
                            console.log(`  Adding direct device target ${deviceName} for rule ${ruleName}`);
                          }
                        });
                      }
                    }
                    
                    // Process device-vsys entries if present
                    if (ruleEntry['device-vsys']?.entry) {
                      const deviceVsysEntries = Array.isArray(ruleEntry['device-vsys'].entry) 
                        ? ruleEntry['device-vsys'].entry 
                        : [ruleEntry['device-vsys'].entry];
                      
                      console.log(`  Found ${deviceVsysEntries.length} device-vsys entries for rule ${ruleName}`);
                      
                      // First pass: check if any entry has all-connected=yes and collect timestamps
                      deviceVsysEntries.forEach((vsysEntry: PanoramaDeviceVsysEntry) => {
                        if (vsysEntry['all-connected'] === 'yes') {
                          allConnected = true;
                          console.log(`  Rule ${ruleName} targets all devices via all-connected=yes`);
                        }
                        
                        const hitCount = parseHitCount(vsysEntry['hit-count']);
                        totalHitCount += hitCount;
                        
                        const lastHitTs = parseTs(vsysEntry['last-hit-timestamp']);
                        const modTs = parseTs(vsysEntry['rule-modification-timestamp']);
                        const creationTs = parseTs(vsysEntry['rule-creation-timestamp']);
                        
                        if (lastHitTs !== undefined && lastHitTs > 0 && (!latestLastHitTimestamp || lastHitTs > parseInt(latestLastHitTimestamp || '0'))) {
                          latestLastHitTimestamp = String(lastHitTs);
                        }
                        
                        if (modTs !== undefined && (!latestModificationTimestamp || modTs > parseInt(latestModificationTimestamp || '0'))) {
                          latestModificationTimestamp = String(modTs);
                        }
                        
                        if (creationTs !== undefined && (!latestCreationTimestamp || creationTs > parseInt(latestCreationTimestamp || '0'))) {
                          latestCreationTimestamp = String(creationTs);
                        }
                      });
                      
                      // Second pass: collect targets if not targeting all devices
                      if (!allConnected) {
                        deviceVsysEntries.forEach((vsysEntry: PanoramaDeviceVsysEntry) => {
                          const entryName = getVsysEntryName(vsysEntry);
                          if (entryName) {
                            console.log(`  Processing device-vsys entry: ${entryName}`);
                            
                            // Handle different formats of device-vsys entry names
                            // Format 1: "vsys1/DEVICEID"
                            // Format 2: "DEVICEID/vsys1"
                            // Format 3: "DEVICEID"
                            const parts = entryName.split('/');
                            
                            let deviceId;
                            if (parts.length >= 2) {
                              // Check which part is likely the device ID (not vsys)
                              if (parts[0].toLowerCase().startsWith('vsys')) {
                                deviceId = parts[1]; // Format 1
                              } else if (parts[1].toLowerCase().startsWith('vsys')) {
                                deviceId = parts[0]; // Format 2
                              } else {
                                // If neither part starts with 'vsys', use the second part as a fallback
                                deviceId = parts[1];
                              }
                            } else {
                              deviceId = parts[0]; // Format 3
                            }
                            
                            if (deviceId) {
                              // Try with both regular and zero-padded serial
                              const paddedDeviceId = deviceId.padStart(12, '0');
                              
                              if (!targets.includes(deviceId) && !targets.includes(paddedDeviceId)) {
                                targets.push(deviceId);
                                console.log(`  Adding target ${deviceId} from device-vsys entry ${entryName}`);
                              }
                            } else {
                              console.log(`  WARNING: Could not extract device ID from device-vsys entry: ${entryName}`);
                            }
                          }
                        });
                      }
                      
                      // If targeting all devices or no specific targets found, use 'all'
                      if (allConnected || targets.length === 0) {
                        targets.length = 0; // Clear any partial targets
                        targets.push('all');
                      }
                      
                      // Only process per-device entries for the UI if we have specific targets
                      // This prevents showing devices that aren't actually targeted
                      if (!allConnected && targets.length > 0) {
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
                          if (!entryName) return;
                          
                          console.log(`  Processing per-device entry for UI: ${entryName}`);
                          
                          // Handle different formats of device-vsys entry names
                          // Format 1: "vsys1/DEVICEID"
                          // Format 2: "DEVICEID/vsys1"
                          // Format 3: "DEVICEID"
                          const parts = entryName.split('/');
                          
                          let deviceId;
                          if (parts.length >= 2) {
                            // Check which part is likely the device ID (not vsys)
                            if (parts[0].toLowerCase().startsWith('vsys')) {
                              deviceId = parts[1]; // Format 1
                            } else if (parts[1].toLowerCase().startsWith('vsys')) {
                              deviceId = parts[0]; // Format 2
                            } else {
                              // If neither part starts with 'vsys', use the second part as a fallback
                              deviceId = parts[1];
                            }
                          } else {
                            deviceId = parts[0]; // Format 3
                          }
                          
                          // Try with both regular and zero-padded serial
                          const paddedDeviceId = deviceId ? deviceId.padStart(12, '0') : '';
                          
                          // Only include devices that are actually in our targets list
                          // This ensures we don't show devices that aren't actually targeted
                          // Check both regular and padded device IDs
                          if (!deviceId || (!targets.includes(deviceId) && !targets.includes(paddedDeviceId))) {
                            console.log(`  Skipping device ${deviceId} as it's not in targets list: ${targets.join(', ')}`);
                            return;
                          }
                          
                          console.log(`  Including device ${deviceId} in UI entries`);
                          
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
      
      // Track if this rule is actually targeting 'any' device (not specific targets)
      let isAnyTarget = false;
      const targets: string[] = [];
      
      if (entry.target) {
        if (typeof entry.target === 'string') {
          if (entry.target === 'all' || entry.target === 'any') {
            isAnyTarget = true;
          } else {
            targets.push(entry.target);
          }
        } else if (Array.isArray(entry.target)) {
          // Check if any entry is 'all' or 'any'
          for (const t of entry.target) {
            if ((typeof t === 'string' && (t === 'all' || t === 'any')) ||
                (t && typeof t === 'object' && 'entry' in t && 
                 ((t as { entry: string }).entry === 'all' || (t as { entry: string }).entry === 'any'))) {
              isAnyTarget = true;
              break;
            }
          }
          
          // Only collect specific targets if not targeting 'any'
          if (!isAnyTarget) {
            entry.target.forEach(t => {
              if (typeof t === 'string' && t !== 'all' && t !== 'any') {
                targets.push(t);
              } else if (t && typeof t === 'object' && 'entry' in t && 
                       (t as { entry: string }).entry !== 'all' && 
                       (t as { entry: string }).entry !== 'any') {
                targets.push((t as { entry: string }).entry);
              }
            });
          }
        }
      }
      
      // If targeting 'any' or no specific targets found, mark as 'all'
      if (isAnyTarget || targets.length === 0) {
        targets.length = 0; // Clear any partial targets
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
          // Try to get the display name using various mappings
          let displayName = hostnameMap.get(targetName);
          
          // If no direct match, try with zero-padded serial
          if (!displayName) {
            const paddedTargetName = targetName.padStart(12, '0');
            displayName = hostnameMap.get(paddedTargetName);
          }
          
          // If still no match, try with direct simplified mapping
          if (!displayName) {
            displayName = hostnameMap.get(`${targetName}-direct-simplified`);
          }
          
          // If still no match, try with padded direct simplified mapping
          if (!displayName) {
            const paddedTargetName = targetName.padStart(12, '0');
            displayName = hostnameMap.get(`${paddedTargetName}-direct-simplified`);
          }
          
          // If still no match, try with simplified mapping
          if (!displayName) {
            displayName = hostnameMap.get(`${targetName}-simplified`);
          }
          
          // Log the hostname resolution for debugging
          if (displayName) {
            console.log(`  Resolved target ${targetName} to hostname ${displayName}`);
          } else {
            console.log(`  WARNING: Could not resolve hostname for target ${targetName}`);
          }
          
          rule.targets.push({
            name: targetName,
            displayName: displayName || undefined,
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
      
      // Check if this rule is targeting 'any' device (indicated by a single 'all' target)
      const isAnyTargetRule = rule.targets.length === 1 && rule.targets[0].name === 'all';
      
      // For 'any' target rules, we should only recommend DISABLE, not UNTARGET
      // since there are no specific targets to untarget
      if (!isAnyTargetRule) {
        rule.targets.forEach(target => {
          if (processed.has(target.name)) return;
          if (target.name === 'all') return; // Skip 'all' targets for untarget analysis

          // Use per-target lastHitDate for accurate comparison; fall back to rule aggregate.
          // isUnused = true means this target's last hit was before the threshold window.
          const targetLastHit = target.lastHitDate
            ? new Date(target.lastHitDate)
            : new Date(rule.lastHitDate);
          
          // Consider a target used if it has hits AND the last hit date is within the threshold
          // This ensures targets with recent hits are not marked for untargeting
          const isUnused = targetLastHit < unusedThreshold && target.hitCount === 0;

          if (target.haPartner) {
            const partner = rule.targets.find(t => t.name === target.haPartner);
            if (partner) {
              const partnerLastHit = partner.lastHitDate
                ? new Date(partner.lastHitDate)
                : new Date(rule.lastHitDate);
              const partnerIsUnused = partnerLastHit < unusedThreshold && partner.hitCount === 0;

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
      }
      
      // For 'any' target rules, determine if the rule is unused overall
      // based on the aggregate hit data
      let isRuleUnused = false;
      if (isAnyTargetRule) {
        const ruleLastHit = new Date(rule.lastHitDate);
        // For 'any' target rules, consider unused only if no hits AND last hit date is old
        isRuleUnused = ruleLastHit < unusedThreshold && rule.totalHits === 0;
      }

      const protectedKey = `${rule.deviceGroup}:${rule.name}`;
      if (protectedRuleSet.has(protectedKey)) {
        rule.action = 'PROTECTED';
      } else if (hasHAProtection && firewallsToUntarget.size === 0) {
        rule.action = 'HA-PROTECTED';
      } else if (isAnyTargetRule && isRuleUnused) {
        // Only use DISABLE for 'any' target rules that are unused
        rule.action = 'DISABLE';
      } else if (!isAnyTargetRule && firewallsToUntarget.size > 0) {
        // For rules with specific targets, always use UNTARGET if any targets are unused
        // This ensures we don't recommend disabling rules that could be partially kept
        rule.action = 'UNTARGET';
      } else {
        rule.action = 'KEEP';
      }

      // First, ensure we only have targets that are actually configured in Panorama
      // This is critical to avoid showing untarget recommendations for firewalls not actually targeted
      const actualTargets = new Set<string>();
      if (rule.target === 'all') {
        actualTargets.add('all');
      } else if (Array.isArray(rule.target)) {
        rule.target.forEach(t => actualTargets.add(t));
      } else if (rule.target) {
        actualTargets.add(rule.target);
      }
      
      console.log(`Rule "${rule.name}" in "${rule.deviceGroup}" has actual targets: ${Array.from(actualTargets).join(', ')}`);
      
      // Filter targets to only include those actually configured in Panorama
      rule.targets = rule.targets.filter(target => 
        target.name === 'all' || actualTargets.has(target.name)
      );
      
      console.log(`After filtering for actual targets: ${rule.targets.length} targets remain`);
      
      // Mark individual targets that will be removed so the UI can highlight them in red
      rule.targets.forEach(target => {
        if (rule.action === 'DISABLE') {
          target.toBeRemoved = true; // whole rule disabled → all targets marked
        } else if (rule.action === 'UNTARGET') {
          // Only mark devices that are actually targeted AND need to be untargeted
          // Skip the 'all' target as it's not a real device
          target.toBeRemoved = target.name !== 'all' && firewallsToUntarget.has(target.name);
        } else {
          // Ensure no targets are marked for removal for other actions
          target.toBeRemoved = false;
        }
      });
      
      // For UNTARGET actions, we need to ensure we only show devices that are actually targeted
      // in Panorama AND need to be untargeted (unused)
      if (rule.action === 'UNTARGET') {
        // Debug log to help diagnose untargeting issues
        console.log(`Rule "${rule.name}" in "${rule.deviceGroup}" has ${rule.targets.length} targets before filtering:`);
        rule.targets.forEach(t => {
          console.log(`  Target: ${t.name}, Display: ${t.displayName || 'none'}, ToBeRemoved: ${t.toBeRemoved}`);
        });
        console.log(`  FirewallsToUntarget: ${Array.from(firewallsToUntarget).join(', ')}`);
        
        // Only keep targets that are actually targeted in Panorama AND marked for removal
        // This ensures we don't show devices that aren't actually targeted
        rule.targets = rule.targets.filter(target => 
          target.name !== 'all' && target.toBeRemoved === true
        );
        
        console.log(`  After filtering: ${rule.targets.length} targets remain`);
      }
    });

    // Calculate rule statistics
    let totalRules = processedRules.length;
    let disabledRules = 0;
    let activeRules = 0;
    
    processedRules.forEach(rule => {
      if (rule.disabled) {
        disabledRules++;
      } else {
        activeRules++;
      }
    });
    
    console.log(`\nRule Statistics:`);
    console.log(`Total Rules: ${totalRules}`);
    console.log(`Active Rules: ${activeRules}`);
    console.log(`Disabled Rules: ${disabledRules}`);
    
    console.log(`Returning ${processedRules.length} unused rules and ${deviceGroups.length} device groups (${rulesProcessed} rules processed):`, deviceGroups);
    
    return {
      rules: processedRules,
      deviceGroups: deviceGroups,
      rulesProcessed,
      statistics: {
        totalRules,
        activeRules,
        disabledRules
      }
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

        // Extract disabled-YYYYMMDD tag dates from the config rules
        const disabledTagDateMap = new Map<string, string>();
        rules.forEach((rule: any) => {
          const ruleName = rule.name || rule['@_name'];
          const tagDate = extractDisabledTagDate(rule);
          if (ruleName && tagDate) {
            disabledTagDateMap.set(ruleName, tagDate);
            console.log(`  Rule "${ruleName}" has disabled tag date: ${new Date(tagDate).toLocaleDateString()}`);
          }
        });

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
                disabledDate: disabledTagDateMap.get(ruleName),
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
                disabledDate: disabledTagDateMap.get(ruleName),
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
    // Calculate rule statistics
    let totalRules = disabledRules.length;
    let permanentlyDisabledRules = 0;
    let temporarilyDisabledRules = 0;
    
    disabledRules.forEach(rule => {
      // Check if the rule has been disabled for a very long time (>90 days)
      // which suggests it's permanently disabled rather than temporarily
      const disabledDate = rule.disabledDate ? new Date(rule.disabledDate) : null;
      const now = new Date();
      const daysDiff = disabledDate ? Math.floor((now.getTime() - disabledDate.getTime()) / (1000 * 60 * 60 * 24)) : 0;
      
      if (daysDiff > 90) {
        permanentlyDisabledRules++;
      } else {
        temporarilyDisabledRules++;
      }
    });
    
    console.log(`\nDisabled Rule Statistics:`);
    console.log(`Total Disabled Rules: ${totalRules}`);
    console.log(`Permanently Disabled Rules (>90 days): ${permanentlyDisabledRules}`);
    console.log(`Temporarily Disabled Rules: ${temporarilyDisabledRules}`);
    
    console.log(`\nFound ${disabledRules.length} rules disabled for more than ${disabledDays} days across ${deviceGroups.length} device groups (${rulesProcessed} rules processed)`);
    onProgress?.(`Found ${disabledRules.length} rules disabled for more than ${disabledDays} days`);
    
    return {
      rules: disabledRules,
      deviceGroups: deviceGroups,
      rulesProcessed,
      statistics: {
        totalRules,
        permanentlyDisabledRules,
        temporarilyDisabledRules
      }
    };
  } catch (error) {
    console.error('Panorama API error:', error);
    throw error;
  }
}
