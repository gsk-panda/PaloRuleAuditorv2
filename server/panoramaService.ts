import { PanoramaRule, HAPair } from '../types.js';
import { XMLParser } from 'fast-xml-parser';
import { getHitCountsViaSsh, type PanoramaSshConfig } from './panoramaSsh.js';
import { logger } from './debug-logger';

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
 * depth-aware character parser â€” this correctly returns ALL device groups
 * (including those with no connected firewalls) regardless of how complex
 * their nested content is.
 *
 * The `show devicegroups` op command only returns groups with currently
 * connected/managed devices, so it is NOT used here.
 */
/** Fetches a map of device serial â†’ hostname from Panorama's connected device list. */
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
            console.log(`  Adding direct mapping for GovCloud device: ${serial} â†’ ${hostname}`);
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
            console.log(`  Adding simplified mapping for cloud device: ${serial} â†’ ${simplifiedName} (original: ${hostname})`);
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
        console.log(`    ${s} â†’ ${h}`);
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

/** Extracts the OLDEST date from disabled-YYYYMMDD tags, returns ISO string or undefined. */
function extractDisabledTagDate(rule: any): string | undefined {
  const ruleName = rule.name || rule['@_name'];
  if (!rule.tag) {
    console.log(`    [extractDisabledTagDate] Rule "${ruleName}" has no tag field`);
    return undefined;
  }
  const members = rule.tag.member
    ? (Array.isArray(rule.tag.member) ? rule.tag.member : [rule.tag.member])
    : [];
  
  console.log(`    [extractDisabledTagDate] Rule "${ruleName}" has ${members.length} tags:`, members.map((m: any) => String(typeof m === 'string' ? m : (m._text ?? m))));
  
  let oldestDate: Date | undefined;
  let oldestDateStr: string | undefined;
  const disabledTags: string[] = [];
  
  for (const m of members) {
    const val = String(typeof m === 'string' ? m : (m._text ?? m));
    const match = val.match(/^disabled-(\d{4})(\d{2})(\d{2})$/i);
    if (match) {
      disabledTags.push(val);
      const dateStr = `${match[1]}-${match[2]}-${match[3]}T00:00:00Z`;
      const date = new Date(dateStr);
      
      if (!oldestDate || date < oldestDate) {
        oldestDate = date;
        oldestDateStr = date.toISOString();
      }
    }
  }
  
  if (disabledTags.length > 0) {
    console.log(`    [extractDisabledTagDate] Rule "${ruleName}" has ${disabledTags.length} disabled tags: ${disabledTags.join(', ')} -> using oldest: ${oldestDate?.toLocaleDateString()}`);
  } else {
    console.log(`    [extractDisabledTagDate] Rule "${ruleName}" has NO disabled-YYYYMMDD tags`);
  }
  
  return oldestDateStr;
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

    // Fetch serial â†’ hostname map for display names
    const hostnameMap = await fetchDeviceHostnameMap(panoramaUrl, apiKey);

    // Extend haMap with serial-keyed entries so that per-target lookups work correctly.
    // Users configure HA pairs by hostname (e.g. "Corp" â†” "Corp-2"), but target.name is
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
        console.log(`  Attempting partial matching for HA pair "${pair.fw1}" â†” "${pair.fw2}"`);
        
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
        console.log(`  HA pair (serial-mapped): ${pair.fw1} (${serial1}) â†” ${pair.fw2} (${serial2})`);
      } else {
        console.warn(`  HA pair "${pair.fw1}" â†” "${pair.fw2}": could not resolve serials (${serial1 ?? 'unknown'} / ${serial2 ?? 'unknown'}) â€” check that both devices appear in connected-device list`);
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

        // Only audit allow rules â€” deny/drop rules don't need usage-based cleanup
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

                // Check for "duplicate node" â€” extract the conflicting rule name
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

              // Success â€” collect rule entries from the response
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
            // Panorama rejects multiple <entry> elements inside <rule-name> for some device groups â€”
            // it works fine when each rule is queried individually. Query each one-at-a-time.
            console.warn(`    ${skippedDuplicates.size} rule(s) with naming conflicts â€” querying each individually`);
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
                      
                      if (ruleName === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
                        logger.debug('RuleProcessing', `Found ${deviceVsysEntries.length} device-vsys entries for rule ${ruleName}`);
                      }
                      console.log(`  Found ${deviceVsysEntries.length} device-vsys entries for rule ${ruleName}`);
                      
                      // First pass: check if any entry has all-connected=yes
                      deviceVsysEntries.forEach((vsysEntry: PanoramaDeviceVsysEntry) => {
                        if (vsysEntry['all-connected'] === 'yes') {
                          allConnected = true;
                          if (ruleName === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
                            logger.debug('RuleProcessing', `Rule ${ruleName} targets all devices via all-connected=yes`);
                          }
                          console.log(`  Rule ${ruleName} targets all devices via all-connected=yes`);
                        }
                      });
                      
                      // Second pass: collect targets from device-vsys entries if not targeting all devices
                      // These will be filtered later against configured targets from Panorama
                      if (!allConnected) {
                        deviceVsysEntries.forEach((vsysEntry: PanoramaDeviceVsysEntry) => {
                          const entryName = getVsysEntryName(vsysEntry);
                          if (entryName) {
                            if (ruleName === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
                              logger.debug('RuleProcessing', `Processing device-vsys entry: ${entryName}`);
                            }
                            console.log(`  Processing device-vsys entry: ${entryName}`);
                            
                            // Handle different formats of device-vsys entry names
                            const parts = entryName.split('/');
                            
                            let deviceId;
                            if (parts.length >= 2) {
                              if (parts[0].toLowerCase().startsWith('vsys')) {
                                deviceId = parts[1];
                              } else if (parts[1].toLowerCase().startsWith('vsys')) {
                                deviceId = parts[0];
                              } else {
                                deviceId = parts[1];
                              }
                            } else {
                              deviceId = parts[0];
                            }
                            
                            if (deviceId) {
                              const paddedDeviceId = deviceId.padStart(12, '0');
                              
                              if (!targets.includes(deviceId) && !targets.includes(paddedDeviceId)) {
                                targets.push(deviceId);
                                if (ruleName === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
                                  logger.debug('RuleProcessing', `Adding target ${deviceId} from device-vsys entry ${entryName}`);
                                }
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
                        targets.length = 0;
                        targets.push('all');
                      }
                      
                      // Third pass: collect timestamps and hit counts ONLY from targeted devices
                      if (ruleName === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
                        logger.debug('RuleProcessing', `Third pass for rule "${ruleName}": targets list = [${targets.join(', ')}], allConnected = ${allConnected}`);
                      }
                      
                      deviceVsysEntries.forEach((vsysEntry: PanoramaDeviceVsysEntry) => {
                        // Check if this device is actually targeted by the rule
                        const entryName = getVsysEntryName(vsysEntry);
                        let isTargeted = allConnected; // If all-connected, all devices are targeted
                        
                        if (ruleName === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
                          logger.debug('RuleProcessing', `Third pass - examining vsysEntry: ${entryName}, allConnected=${allConnected}`);
                        }
                        
                        if (!allConnected && entryName) {
                          // Extract device ID from entry name
                          const parts = entryName.split('/');
                          let deviceId;
                          if (parts.length >= 2) {
                            if (parts[0].toLowerCase().startsWith('vsys')) {
                              deviceId = parts[1];
                            } else if (parts[1].toLowerCase().startsWith('vsys')) {
                              deviceId = parts[0];
                            } else {
                              deviceId = parts[1];
                            }
                          } else {
                            deviceId = parts[0];
                          }
                          
                          // Check if this device is in the targets list
                          if (deviceId) {
                            const paddedDeviceId = deviceId.padStart(12, '0');
                            isTargeted = targets.includes(deviceId) || targets.includes(paddedDeviceId);
                            
                            if (ruleName === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
                              logger.debug('RuleProcessing', `Checking device ${deviceId} (padded: ${paddedDeviceId}): isTargeted = ${isTargeted}`);
                            }
                          }
                        }
                        
                        // Only collect timestamps and hit counts from targeted devices
                        if (isTargeted) {
                          const hitCount = parseHitCount(vsysEntry['hit-count']);
                          totalHitCount += hitCount;
                          
                          const lastHitTs = parseTs(vsysEntry['last-hit-timestamp']);
                          const modTs = parseTs(vsysEntry['rule-modification-timestamp']);
                          const creationTs = parseTs(vsysEntry['rule-creation-timestamp']);
                          
                          if (ruleName === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
                            logger.debug('RuleProcessing', `Including device ${entryName}: lastHitTs=${lastHitTs}, lastHitDate=${lastHitTs ? new Date(lastHitTs * 1000).toISOString() : 'none'}, hitCount=${hitCount}, modTs=${modTs}, creationTs=${creationTs}`);
                            logger.debug('RuleProcessing', `  Raw values from API: last-hit-timestamp='${vsysEntry['last-hit-timestamp']}', hit-count='${vsysEntry['hit-count']}'`);
                          }
                          
                          if (lastHitTs !== undefined && lastHitTs > 0 && (!latestLastHitTimestamp || lastHitTs > parseInt(latestLastHitTimestamp || '0'))) {
                            if (ruleName === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
                              logger.debug('RuleProcessing', `  Updating latestLastHitTimestamp from ${latestLastHitTimestamp} to ${lastHitTs} (${new Date(lastHitTs * 1000).toISOString()})`);
                            }
                            latestLastHitTimestamp = String(lastHitTs);
                          }
                          
                          if (modTs !== undefined && (!latestModificationTimestamp || modTs > parseInt(latestModificationTimestamp || '0'))) {
                            latestModificationTimestamp = String(modTs);
                          }
                          
                          if (creationTs !== undefined && (!latestCreationTimestamp || creationTs > parseInt(latestCreationTimestamp || '0'))) {
                            latestCreationTimestamp = String(creationTs);
                          }
                        } else if (ruleName === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
                          logger.debug('RuleProcessing', `Skipping device ${entryName}: not targeted`);
                        }
                      });
                      
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
                            // Debug logging for date discrepancies
                            if (ruleName === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
                              logger.debug('RuleProcessing', `Rule "${ruleName}": raw last-hit-timestamp=${vsysEntry['last-hit-timestamp']}, parsed=${lastHitTs}, converted=${lastUsedDate}, hitCount=${perDeviceHitCount}`);
                            }
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
                    }
                    
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

                    if (ruleName === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
                      logger.debug('RuleProcessing', `FINAL for rule "${ruleName}": latestLastHitTimestamp=${latestLastHitTimestamp}, lastUsedDate=${lastUsedDate}, totalHitCount=${totalHitCount}`);
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
            }

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
    // ruleMap â€” including entries for active targets (e.g. Corp with recent hits). Without this,
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

    // Step: Fetch actual rule configurations from Panorama to get the real configured targets
    console.log(`\nStep: Fetching actual rule configurations from Panorama for target validation...`);
    const ruleConfigMap = new Map<string, Set<string>>(); // Map of "devicegroup:rulename" -> Set of configured device names
    
    for (const dgName of deviceGroupNames) {
      try {
        const preRulesXpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group/entry[@name='${dgName}']/pre-rulebase/security/rules`;
        const preConfigData = await fetchConfigPaginated(panoramaUrl, apiKey, preRulesXpath);
        const result = preConfigData.response?.result;
        let rules: any[] = [];
        
        if (result?.rules?.entry) {
          rules = Array.isArray(result.rules.entry) ? result.rules.entry : [result.rules.entry];
        } else if (result?.entry?.rules?.entry) {
          rules = Array.isArray(result.entry.rules.entry) ? result.entry.rules.entry : [result.entry.rules.entry];
        }
        
        rules.forEach((ruleConfig: any) => {
          const ruleName = ruleConfig.name || ruleConfig['@_name'];
          if (!ruleName) return;
          
          const ruleKey = `${dgName}:${ruleName}`;
          const configuredTargets = new Set<string>();
          
          // Extract configured device targets from the rule configuration
          if (ruleConfig.target) {
            // Extract specific device targets first
            if (ruleConfig.target.devices?.entry) {
              const deviceEntries = Array.isArray(ruleConfig.target.devices.entry) 
                ? ruleConfig.target.devices.entry 
                : [ruleConfig.target.devices.entry];
              
              deviceEntries.forEach((device: any) => {
                const deviceName = device.name || device['@_name'];
                if (deviceName) {
                  configuredTargets.add(deviceName);
                }
              });
            }
            
            // Only mark as 'all' if no specific devices were found AND negate=no
            // (negate=no with no specific devices means target all devices in the group)
            if (configuredTargets.size === 0 && ruleConfig.target.negate === 'no') {
              configuredTargets.add('all');
            }
          }
          
          // If no targets found at all, assume it targets all
          if (configuredTargets.size === 0) {
            configuredTargets.add('all');
          }
          
          ruleConfigMap.set(ruleKey, configuredTargets);
          console.log(`  Rule "${ruleName}" in "${dgName}" has configured targets: ${Array.from(configuredTargets).join(', ')}`);
        });
      } catch (err) {
        console.error(`  Failed to fetch rule config for device group "${dgName}":`, err instanceof Error ? err.message : err);
      }
    }
    
    console.log(`Fetched configurations for ${ruleConfigMap.size} rules`);

    const processedRules = Array.from(ruleMap.values());

    processedRules.forEach(rule => {
      let firewallsToUntarget = new Set<string>();
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
          
          // A target is unused if its last hit was before the threshold
          // The historical hit count doesn't matter - what matters is when it was last used
          const isUnused = targetLastHit < unusedThreshold;
          
          // Debug logging for troubleshooting
          console.log(`  Target ${target.name} (${target.displayName || 'unknown'}): lastHitDate=${target.lastHitDate || 'none (using rule aggregate)'}, targetLastHit=${targetLastHit.toISOString()}, threshold=${unusedThreshold.toISOString()}, isUnused=${isUnused}, hitCount=${target.hitCount}`);

          // Check if this target has an HA partner - either directly set or via the haMap
          const partnerName = target.haPartner || haMap.get(target.name);
          if (partnerName) {
            // Log the HA partner relationship for debugging
            console.log(`  Target ${target.name} (${target.displayName || 'unknown'}) has HA partner: ${partnerName}`);
            
            // Find the partner in the rule targets
            const partner = rule.targets.find(t => t.name === partnerName);
            if (partner) {
              console.log(`  Found partner ${partnerName} (${partner.displayName || 'unknown'}) in rule targets`);
              
              const partnerLastHit = partner.lastHitDate
                ? new Date(partner.lastHitDate)
                : new Date(rule.lastHitDate);
              const partnerIsUnused = partnerLastHit < unusedThreshold;
              
              console.log(`  Target ${target.name}: isUnused=${isUnused}, Partner ${partnerName}: isUnused=${partnerIsUnused}`);

              if (!isUnused || !partnerIsUnused) {
                // At least one of the HA pair has been hit recently â†’ HA-protected
                firewallsToUntarget.delete(target.name);
                firewallsToUntarget.delete(partnerName);
                hasHAProtection = true;
                console.log(`  HA protection applied: ${target.name} and ${partnerName} will not be untargeted`);
              } else {
                // Both sides of the HA pair are unused within the threshold
                firewallsToUntarget.add(target.name);
                firewallsToUntarget.add(partnerName);
                console.log(`  Both HA partners unused: ${target.name} and ${partnerName} will be untargeted`);
              }
              processed.add(target.name);
              processed.add(partnerName);
            } else {
              // Partner is not in the rule targets - check if it's in the actual targets
              console.log(`  Partner ${partnerName} not found in rule targets - checking if it's in actual targets`);
              
              // If the partner is in the actual targets, we should still apply HA protection
              if (actualTargets.has(partnerName)) {
                console.log(`  Partner ${partnerName} found in actual targets - applying HA protection`);
                if (isUnused) {
                  // We don't know if the partner is used or not, so we'll be conservative and not untarget
                  firewallsToUntarget.delete(target.name);
                  hasHAProtection = true;
                  console.log(`  HA protection applied: ${target.name} will not be untargeted (partner in actual targets)`);
                }
              } else {
                // Partner is not in actual targets, so handle this target normally
                if (isUnused) {
                  firewallsToUntarget.add(target.name);
                  console.log(`  Target ${target.name} is unused and partner not in targets - will be untargeted`);
                }
              }
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
        // For rules with specific targets, use UNTARGET only if there are actual targets to untarget
        // and those targets are actually configured in Panorama
        console.log(`  Rule has ${firewallsToUntarget.size} firewalls to untarget: ${Array.from(firewallsToUntarget).join(', ')}`);
        rule.action = 'UNTARGET';
      } else {
        rule.action = 'KEEP';
      }

      // First, get the actual configured targets from Panorama's rule configuration
      const ruleKey = `${rule.deviceGroup}:${rule.name}`;
      const configuredDeviceNames = ruleConfigMap.get(ruleKey) || new Set<string>();
      
      console.log(`Rule "${rule.name}" in "${rule.deviceGroup}" has configured device names: ${Array.from(configuredDeviceNames).join(', ')}`);
      
      // Build actualTargets by normalizing device identifiers
      // Configured targets can be either hostnames or serial numbers
      // Usage data always has serial numbers (sometimes zero-padded)
      const actualTargets = new Set<string>();
      
      if (configuredDeviceNames.has('all')) {
        actualTargets.add('all');
      } else {
        // Process each configured device identifier
        configuredDeviceNames.forEach(deviceIdentifier => {
          // Convert to string in case it's a number
          const deviceIdStr = String(deviceIdentifier);
          
          // First, try to find if this is a hostname that maps to a serial
          let serial = hostnameToSerial.get(deviceIdStr.toLowerCase());
          
          if (serial) {
            // It's a hostname, use the mapped serial
            actualTargets.add(serial);
            console.log(`  Mapped hostname "${deviceIdStr}" to serial "${serial}"`);
          } else {
            // It's likely already a serial number, add both the original and zero-padded versions
            // This handles cases where Panorama stores serials in different formats
            actualTargets.add(deviceIdStr);
            actualTargets.add(deviceIdStr.padStart(12, '0'));
            
            // Also check if this serial is in the hostname map (reverse lookup)
            const hostname = hostnameMap.get(deviceIdStr) || hostnameMap.get(deviceIdStr.padStart(12, '0'));
            if (hostname) {
              console.log(`  Device identifier "${deviceIdStr}" is serial with hostname "${hostname}"`);
            } else {
              console.log(`  Device identifier "${deviceIdStr}" treated as serial (no hostname mapping found)`);
            }
          }
        });
      }
      
      // Also add any HA partners to the actual targets set
      // This ensures that if one device in an HA pair is targeted, its partner is also considered
      const haPartners = new Set<string>();
      actualTargets.forEach(target => {
        const partner = haMap.get(target);
        if (partner) {
          haPartners.add(partner);
          console.log(`  Adding HA partner ${partner} for target ${target}`);
        }
      });
      
      // Add all HA partners to the actual targets
      haPartners.forEach(partner => actualTargets.add(partner));
      
      console.log(`Rule "${rule.name}" in "${rule.deviceGroup}" has actual targets (as serials): ${Array.from(actualTargets).join(', ')}`);
      
      // Save the original counts BEFORE any filtering - we'll need these to determine DISABLE vs KEEP
      const originalFirewallsToUntargetCount = firewallsToUntarget.size;
      const originalTargetCount = rule.targets.filter(t => t.name !== 'all').length;
      
      // Filter targets to only include those actually configured in Panorama
      rule.targets = rule.targets.filter(target => 
        target.name === 'all' || actualTargets.has(target.name)
      );
      
      // CRITICAL: Recalculate the rule's aggregate lastHitDate from only the remaining targets
      // This fixes the issue where timestamps from non-targeted devices were included
      if (rule.targets.length > 0 && !rule.targets.some(t => t.name === 'all')) {
        let latestDate: Date | null = null;
        rule.targets.forEach(target => {
          if (target.lastHitDate) {
            const targetDate = new Date(target.lastHitDate);
            if (!latestDate || targetDate > latestDate) {
              latestDate = targetDate;
            }
          }
        });
        
        if (latestDate) {
          const oldLastHitDate = rule.lastHitDate;
          rule.lastHitDate = latestDate.toISOString();
          
          if (rule.name === 'ISR - Ground Machine to SNC Linux and Satellite IPs') {
            logger.debug('RuleProcessing', `Recalculated lastHitDate for rule "${rule.name}": was ${oldLastHitDate}, now ${rule.lastHitDate} (from ${rule.targets.length} filtered targets)`);
          }
        }
      }
      
      // Also make sure firewallsToUntarget only includes devices that are actually targeted
      // This is critical to prevent showing untarget recommendations for non-targeted devices
      const untargetableFirewalls = new Set<string>();
      firewallsToUntarget.forEach(fw => {
        if (actualTargets.has(fw)) {
          untargetableFirewalls.add(fw);
        } else {
          console.log(`  Removing ${fw} from firewallsToUntarget as it's not actually targeted by this rule`);
        }
      });
      firewallsToUntarget = untargetableFirewalls;
      
      console.log(`After filtering for actual targets: ${rule.targets.length} targets remain`);
      console.log(`After filtering firewallsToUntarget: ${firewallsToUntarget.size} firewalls to untarget remain`);
      
      // Check if untargeting would remove ALL targets from the rule
      // If so, we should DISABLE the rule instead of UNTARGET
      if (rule.action === 'UNTARGET' && !isAnyTargetRule) {
        // Count how many actual targets exist in the rule (excluding 'all')
        const actualRuleTargetCount = rule.targets.filter(t => t.name !== 'all').length;
        const untargetCount = firewallsToUntarget.size;
        
        console.log(`  Rule has ${actualRuleTargetCount} actual targets, untargeting ${untargetCount} firewalls`);
        
        // If we're untargeting all targets that exist in the rule, change action to DISABLE
        if (actualRuleTargetCount > 0 && untargetCount >= actualRuleTargetCount) {
          console.log(`  Untargeting would remove all ${actualRuleTargetCount} targets - changing action to DISABLE`);
          rule.action = 'DISABLE';
        }
      }
      
      // Mark individual targets that will be removed so the UI can highlight them in red
      rule.targets.forEach(target => {
        if (rule.action === 'DISABLE') {
          target.toBeRemoved = true; // whole rule disabled â†’ all targets marked
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
        rule.targets = rule.targets.filter(target => {
          // Skip 'all' targets as they're not real devices
          if (target.name === 'all') return false;
          
          // Only include targets that are actually configured in Panorama AND marked for removal
          const isActualTarget = actualTargets.has(target.name);
          const isMarkedForRemoval = target.toBeRemoved === true;
          
          if (isMarkedForRemoval && !isActualTarget) {
            console.log(`  Removing target ${target.name} from display as it's not actually targeted by this rule`);
            return false;
          }
          
          return isMarkedForRemoval;
        });
        
        console.log(`  After filtering: ${rule.targets.length} targets remain`);
        
        // If we have no targets left after filtering, we need to determine the correct action
        if (rule.targets.length === 0) {
          // Check if we were going to untarget ALL targets or just SOME targets
          // Only mark as DISABLE if we were going to untarget ALL targets
          // Use the ORIGINAL counts before filtering to make this determination
          if (originalFirewallsToUntargetCount > 0 && originalFirewallsToUntargetCount >= originalTargetCount) {
            // We were going to untarget ALL targets, so the rule should be disabled
            console.log(`  No targets remain after filtering, and originally had ${originalFirewallsToUntargetCount} firewalls to untarget out of ${originalTargetCount} total targets - changing action to DISABLE`);
            rule.action = 'DISABLE';
          } else {
            // We were only going to untarget SOME targets, or no targets at all
            // This means the rule has active targets - mark as KEEP
            console.log(`  No targets remain after filtering, but only ${originalFirewallsToUntargetCount} of ${originalTargetCount} targets were to be untargeted - changing action to KEEP`);
            rule.action = 'KEEP';
          }
        }
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

    // Fallback: If no device groups found, try to discover them from the config
    if (deviceGroupNames.length === 0) {
      console.log('Attempting fallback: discovering device groups from config...');
      try {
        const configXpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group`;
        const configData = await fetchConfigPaginated(panoramaUrl, apiKey, configXpath);
        const result = configData.response?.result;
        if (result?.['device-group']?.entry) {
          const entries = Array.isArray(result['device-group'].entry) 
            ? result['device-group'].entry 
            : [result['device-group'].entry];
          deviceGroupNames = entries.map((e: any) => e['@_name'] || e.name).filter(Boolean);
          console.log(`Fallback discovered ${deviceGroupNames.length} device groups:`, deviceGroupNames);
        }
      } catch (fallbackError) {
        console.error('Fallback device group discovery failed:', fallbackError);
      }
    }

    if (deviceGroupNames.length === 0) {
      console.log('No device groups found after fallback, skipping audit');
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
      logger.info(`[DisabledRules] Processing Device Group: ${dgName}`);
      
      try {
        // Fetch both pre-rulebase and post-rulebase rules
        let rules: any[] = [];
        let rulebaseType: string = '';
        
        // Try pre-rulebase first
        console.log(`Fetching pre-rulebase rules for device group "${dgName}"...`);
        logger.info(`[DisabledRules] Fetching pre-rulebase for ${dgName}`);
        const preRulesXpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group/entry[@name='${dgName}']/pre-rulebase/security/rules`;
        try {
          const preConfigData = await fetchConfigPaginated(panoramaUrl, apiKey, preRulesXpath);
          const result = preConfigData.response?.result;
          if (result?.rules?.entry) {
            const preRules = Array.isArray(result.rules.entry) ? result.rules.entry : [result.rules.entry];
            rules.push(...preRules.map((r: any) => ({ ...r, _rulebase: 'pre' })));
          } else if (result?.entry?.rules?.entry) {
            const preRules = Array.isArray(result.entry.rules.entry) ? result.entry.rules.entry : [result.entry.rules.entry];
            rules.push(...preRules.map((r: any) => ({ ...r, _rulebase: 'pre' })));
          }
        } catch (err) {
          console.error(`  Pre-rulebase fetch failed:`, err instanceof Error ? err.message : err);
        }
        
        // Try post-rulebase
        console.log(`Fetching post-rulebase rules for device group "${dgName}"...`);
        const postRulesXpath = `/config/devices/entry[@name='${panoramaDeviceName}']/device-group/entry[@name='${dgName}']/post-rulebase/security/rules`;
        try {
          const postConfigData = await fetchConfigPaginated(panoramaUrl, apiKey, postRulesXpath);
          const result = postConfigData.response?.result;
          if (result?.rules?.entry) {
            const postRules = Array.isArray(result.rules.entry) ? result.rules.entry : [result.rules.entry];
            rules.push(...postRules.map((r: any) => ({ ...r, _rulebase: 'post' })));
          } else if (result?.entry?.rules?.entry) {
            const postRules = Array.isArray(result.entry.rules.entry) ? result.entry.rules.entry : [result.entry.rules.entry];
            rules.push(...postRules.map((r: any) => ({ ...r, _rulebase: 'post' })));
          }
        } catch (err) {
          console.error(`  Post-rulebase fetch failed:`, err instanceof Error ? err.message : err);
        }
        
        if (rules.length === 0) {
          console.log(`  No rules found in either rulebase for device group "${dgName}"`);
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
        
        logger.info(`[DisabledRules] ${dgName}: Found ${rules.length} total rules before filtering`);
        
        rules = rules.filter((rule: any) => {
          const disabled = rule.disabled || rule['@_disabled'];
          if (disabled === 'yes') {
            const ruleName = rule.name || rule['@_name'];
            console.log(`  Found disabled rule: "${ruleName}"`);
            logger.info(`[DisabledRules] ${dgName}: Found disabled rule "${ruleName}"`);
            return true;
          }
          return false;
        });
        
        if (rules.length === 0) {
          console.log(`  No disabled rules found for device group "${dgName}"`);
          logger.info(`[DisabledRules] ${dgName}: No disabled rules found`);
          continue;
        }

        console.log(`  Found ${rules.length} disabled rules in "${dgName}"`);
        logger.info(`[DisabledRules] ${dgName}: Found ${rules.length} disabled rules`);
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
            logger.info(`[DisabledRules] ${dgName}: Rule "${ruleName}" has disabled tag date ${new Date(tagDate).toLocaleDateString()}`);
          } else if (ruleName) {
            console.log(`  Rule "${ruleName}" has NO disabled-YYYYMMDD tag`);
            logger.info(`[DisabledRules] ${dgName}: Rule "${ruleName}" has NO disabled-YYYYMMDD tag`);
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

        const ruleDataMap = new Map<string, { modificationTimestamp?: string; hitCount: number; rulebase: string }>();

        // Query hit counts for both pre and post rulebases
        for (const rulebaseType of ['pre', 'post']) {
          const rulesInRulebase = rules.filter((r: any) => r._rulebase === rulebaseType);
          if (rulesInRulebase.length === 0) continue;
          
          const ruleNamesInRulebase = rulesInRulebase.map((r: any) => r.name || r['@_name']).filter(Boolean);
          const uniqueRuleNamesInRulebase = [...new Set(ruleNamesInRulebase)];
          
          try {
            console.log(`    Querying hit counts for ${uniqueRuleNamesInRulebase.length} disabled rules in ${rulebaseType}-rulebase of device group "${dgName}" (in chunks of ${RULE_HIT_COUNT_CHUNK_SIZE})`);
            for (let i = 0; i < uniqueRuleNamesInRulebase.length; i += RULE_HIT_COUNT_CHUNK_SIZE) {
              if ((i + 1) % 25 === 0 || i + 1 === uniqueRuleNamesInRulebase.length) {
                onProgress?.(`Processing device group: ${dgName} (${i + 1}/${uniqueRuleNamesInRulebase.length} rules in ${rulebaseType}-rulebase)`);
              }
              const chunk = uniqueRuleNamesInRulebase.slice(i, i + RULE_HIT_COUNT_CHUNK_SIZE);
              const ruleEntryXml = chunk.map(name => `<entry name="${name}"/>`).join('');
              const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}"><${rulebaseType}-rulebase><entry name="security"><rules>${ruleEntryXml}</rules></entry></${rulebaseType}-rulebase></entry></device-group></rule-hit-count></show>`;
              const apiUrl = `${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
              const response = await fetch(apiUrl);
              if (!response.ok) {
                console.error(`    ${rulebaseType}-rulebase chunk ${Math.floor(i / RULE_HIT_COUNT_CHUNK_SIZE) + 1} failed: ${response.status} ${response.statusText}`);
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
                      ruleDataMap.set(ruleName, { modificationTimestamp, hitCount, rulebase: rulebaseType });
                    });
                  }
                });
              };
              processRuleBase(dg['pre-rulebase']?.entry);
              processRuleBase(dg['post-rulebase']?.entry);
              processRuleBase(dg['rule-base']?.entry);
            }); // deviceGroups.forEach
          } // for chunk loop
        } catch (err) {
          console.error(`    Hit count query failed for ${rulebaseType}-rulebase:`, err instanceof Error ? err.message : err);
        }
      } // for rulebaseType loop

      for (const ruleName of ruleNames) {
        const ruleData = ruleDataMap.get(ruleName);
        const modificationTimestamp = ruleData?.modificationTimestamp;
        const hitCount = ruleData?.hitCount || 0;
        
        // Get the disabled tag date (disabled-YYYYMMDD)
        const disabledTagDateStr = disabledTagDateMap.get(ruleName);
        
        // Skip rules without a disabled-YYYYMMDD tag
        if (!disabledTagDateStr) {
          console.log(`    Rule "${ruleName}" has no disabled-YYYYMMDD tag - skipping`);
          continue;
        }
        
        const disabledTagDate = new Date(disabledTagDateStr);
        const protectedKey = `${dgName}:${ruleName}`;
        const isProtected = protectedRuleSet.has(protectedKey);
        
        logger.info(`[DisabledRules] ${dgName}: Rule "${ruleName}" - disabledTagDate: ${disabledTagDate.toISOString()}, threshold: ${disabledThreshold.toISOString()}, comparison: ${disabledTagDate < disabledThreshold ? 'OLDER' : 'NEWER'}`);
        
        if (isProtected) {
          console.log(`    Rule "${ruleName}" has PROTECT tag - marking as protected (disabled tag date: ${disabledTagDate.toLocaleDateString()}, hit count: ${hitCount})`);
          logger.info(`[DisabledRules] ${dgName}: Rule "${ruleName}" - PROTECTED`);

          const panoramaRule: PanoramaRule = {
            id: `disabled-rule-${disabledRules.length}`,
            name: ruleName,
            deviceGroup: dgName,
            totalHits: hitCount,
            lastHitDate: disabledTagDate.toISOString(),
            disabledDate: disabledTagDateStr,
            targets: [],
            action: 'PROTECTED',
            isShared: false,
          };

          disabledRules.push(panoramaRule);
          logger.info(`[DisabledRules] ${dgName}: Rule "${ruleName}" - PROTECTED rule pushed to array (total: ${disabledRules.length})`);
        } else if (disabledTagDate < disabledThreshold) {
          // Only flag rules where the disabled tag date is older than the threshold
          console.log(`    Rule "${ruleName}" disabled tag date ${disabledTagDate.toLocaleDateString()} is older than ${disabledDays} days threshold - marking for DELETE (hit count: ${hitCount})`);
          logger.info(`[DisabledRules] ${dgName}: Rule "${ruleName}" - DELETE (date ${disabledTagDate.toLocaleDateString()} older than threshold)`);

          const panoramaRule: PanoramaRule = {
            id: `disabled-rule-${disabledRules.length}`,
            name: ruleName,
            deviceGroup: dgName,
            totalHits: hitCount,
            lastHitDate: disabledTagDate.toISOString(),
            disabledDate: disabledTagDateStr,
            targets: [],
            action: 'DELETE',
            isShared: false,
          };

          disabledRules.push(panoramaRule);
          logger.info(`[DisabledRules] ${dgName}: Rule "${ruleName}" - DELETE rule pushed to array (total: ${disabledRules.length})`);
        } else {
          console.log(`    Rule "${ruleName}" disabled tag date ${disabledTagDate.toLocaleDateString()} is within ${disabledDays} days threshold - keeping`);
          logger.info(`[DisabledRules] ${dgName}: Rule "${ruleName}" - KEEP (date ${disabledTagDate.toLocaleDateString()} within threshold)`);
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
