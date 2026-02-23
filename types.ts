
export type RuleAction = 'KEEP' | 'DISABLE' | 'UNTARGET' | 'IGNORE' | 'HA-PROTECTED' | 'PROTECTED';

export interface HAPair {
  fw1: string;
  fw2: string;
}

export interface FirewallTarget {
  name: string;         // serial number — used for Panorama config write operations
  displayName?: string; // resolved hostname — used for display only
  hasHits: boolean;
  hitCount: number;
  haPartner?: string;
  lastHitDate?: string; // ISO string – per-target last hit date for threshold comparison
  toBeRemoved?: boolean; // true when this target will be untargeted or the rule disabled
}

export interface PanoramaRule {
  id: string;
  name: string;
  deviceGroup: string;
  totalHits: number;
  lastHitDate: string;   // ISO string
  createdDate?: string;  // ISO string — rule-creation-timestamp from Panorama
  targets: FirewallTarget[];
  action: RuleAction;
  suggestedActionNotes?: string;
  isShared: boolean;
}

export interface PanoramaConfig {
  url: string;
  apiKey: string;
  unusedDays: number;
}

export interface AuditSummary {
  totalRules: number;
  toDisable: number;
  toUntarget: number;
  toKeep: number;
  ignoredShared: number;
  haProtected: number;
  protected: number;
}
