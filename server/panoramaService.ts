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
      'panorama-rule-use'?: {
        entry?: PanoramaRuleUseEntry | PanoramaRuleUseEntry[];
      };
    };
  };
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

  const apiUrl = `${panoramaUrl}/api/?type=op&cmd=<show><running><panorama-rule-use></panorama-rule-use></running></show>&key=${apiKey}`;

  try {
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
    const data: PanoramaResponse = parser.parse(xmlText);

    if (!data.response?.result?.['panorama-rule-use']?.entry) {
      return { rules: [], deviceGroups: [] };
    }

    const entries = Array.isArray(data.response.result['panorama-rule-use'].entry)
      ? data.response.result['panorama-rule-use'].entry
      : [data.response.result['panorama-rule-use'].entry];

    const rules: PanoramaRule[] = [];
    const ruleMap = new Map<string, PanoramaRule>();
    const deviceGroupsSet = new Set<string>();

    entries.forEach((entry, index) => {
      if (entry.devicegroup) {
        deviceGroupsSet.add(entry.devicegroup);
      }
      if (!entry.rulename || !entry.devicegroup) return;

      const ruleKey = `${entry.devicegroup}:${entry.rulename}`;
      const isShared = entry.devicegroup === 'Shared';
      const lastUsed = entry.lastused ? new Date(entry.lastused) : null;
      const hitCount = parseInt(entry.hitcnt || '0', 10);
      
      const targets: string[] = [];
      if (entry.target) {
        if (typeof entry.target === 'string') {
          targets.push(entry.target);
        } else if (Array.isArray(entry.target)) {
          entry.target.forEach(t => {
            if (t.entry) targets.push(t.entry);
          });
        }
      }

      if (!ruleMap.has(ruleKey)) {
        const rule: PanoramaRule = {
          id: `rule-${index}`,
          name: entry.rulename,
          deviceGroup: entry.devicegroup,
          totalHits: 0,
          lastHitDate: lastUsed?.toISOString() || new Date().toISOString(),
          targets: [],
          action: 'KEEP',
          isShared,
        };
        ruleMap.set(ruleKey, rule);
      }

      const rule = ruleMap.get(ruleKey)!;
      
      targets.forEach(targetName => {
        const existingTarget = rule.targets.find(t => t.name === targetName);
        if (existingTarget) {
          existingTarget.hitCount += hitCount;
          existingTarget.hasHits = existingTarget.hitCount > 0;
        } else {
          rule.targets.push({
            name: targetName,
            hasHits: hitCount > 0,
            hitCount: hitCount,
            haPartner: haMap.get(targetName) || undefined,
          });
        }
      });

      rule.totalHits += hitCount;
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

    return {
      rules: processedRules,
      deviceGroups: Array.from(deviceGroupsSet).sort()
    };
  } catch (error) {
    console.error('Panorama API error:', error);
    throw error;
  }
}
