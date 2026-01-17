
import { PanoramaRule, FirewallTarget, RuleAction, HAPair } from '../types';

const DEVICE_GROUPS = ['DataCenter', 'Branch-West', 'Branch-East', 'DMZ-Internal', 'Shared'];
const FIREWALLS = ['FW-01', 'FW-02', 'FW-03', 'FW-04', 'FW-05', 'FW-06'];

export const generateMockRules = (unusedDays: number, haPairs: HAPair[]): PanoramaRule[] => {
  const rules: PanoramaRule[] = [];
  const now = new Date();

  // Create a map for quick HA lookups
  const haMap = new Map<string, string>();
  haPairs.forEach(pair => {
    haMap.set(pair.fw1, pair.fw2);
    haMap.set(pair.fw2, pair.fw1);
  });

  for (let i = 1; i <= 30; i++) {
    const dg = DEVICE_GROUPS[Math.floor(Math.random() * DEVICE_GROUPS.length)];
    const isShared = dg === 'Shared';
    
    const daysSinceLastHit = Math.floor(Math.random() * (unusedDays * 2));
    const lastHit = new Date();
    lastHit.setDate(now.getDate() - daysSinceLastHit);

    const numTargets = dg === 'Shared' ? 0 : Math.floor(Math.random() * 4) + 1;
    const targets: FirewallTarget[] = [];
    
    // Ensure if we pick one of an HA pair, we might pick the other too for realistic mock data
    const pool = [...FIREWALLS].sort(() => 0.5 - Math.random());
    const selectedFws = new Set<string>();
    
    for (const fw of pool) {
      if (selectedFws.size >= numTargets) break;
      selectedFws.add(fw);
      // Frequently add the partner if it's an HA pair to simulate real config
      const partner = haMap.get(fw);
      if (partner && Math.random() > 0.3) {
        selectedFws.add(partner);
      }
    }

    let totalHits = 0;
    Array.from(selectedFws).forEach(fw => {
      // Simulate hits
      const fwHits = daysSinceLastHit > unusedDays ? 0 : Math.floor(Math.random() * 100);
      targets.push({
        name: fw,
        hasHits: fwHits > 0,
        hitCount: fwHits,
        haPartner: haMap.get(fw)
      });
      totalHits += fwHits;
    });

    // Determine action based on HA Logic
    let action: RuleAction = 'KEEP';
    if (isShared) {
      action = 'IGNORE';
    } else {
      // Logic: A rule is "unused" for a target if:
      // 1. It's a standalone firewall with 0 hits
      // 2. It's an HA pair and BOTH have 0 hits
      
      const firewallsToUntarget = new Set<string>();
      const processed = new Set<string>();

      targets.forEach(t => {
        if (processed.has(t.name)) return;

        if (t.haPartner) {
          const partner = targets.find(p => p.name === t.haPartner);
          if (partner) {
            // It's a pair where both are targeted
            if (!t.hasHits && !partner.hasHits) {
              firewallsToUntarget.add(t.name);
              firewallsToUntarget.add(partner.name);
            }
            processed.add(t.name);
            processed.add(partner.name);
          } else {
            // Partner isn't targeted, treat as standalone
            if (!t.hasHits) firewallsToUntarget.add(t.name);
            processed.add(t.name);
          }
        } else {
          // Standalone
          if (!t.hasHits) firewallsToUntarget.add(t.name);
          processed.add(t.name);
        }
      });

      if (firewallsToUntarget.size === targets.length && targets.length > 0) {
        action = 'DISABLE';
      } else if (firewallsToUntarget.size > 0) {
        action = 'UNTARGET';
      }
    }

    rules.push({
      id: `rule-${i}`,
      name: `Access-Rule-${i.toString().padStart(3, '0')}`,
      deviceGroup: dg,
      totalHits,
      lastHitDate: lastHit.toISOString(),
      targets,
      action,
      isShared
    });
  }

  return rules;
};
