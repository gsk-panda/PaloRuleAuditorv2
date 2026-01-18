
export type RuleAction = 'KEEP' | 'DISABLE' | 'UNTARGET' | 'IGNORE' | 'HA-PROTECTED' | 'PROTECTED';

export interface HAPair {
  fw1: string;
  fw2: string;
}

export interface FirewallTarget {
  name: string;
  hasHits: boolean;
  hitCount: number;
  haPartner?: string;
}

export interface PanoramaRule {
  id: string;
  name: string;
  deviceGroup: string;
  totalHits: number;
  lastHitDate: string; // ISO string
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
