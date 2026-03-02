import React from 'react';
import { PanoramaRule } from '../types';

interface RuleRowProps {
  rule: PanoramaRule;
  auditMode?: 'unused' | 'disabled';
  isSelected?: boolean;
  onSelectionChange?: (checked: boolean) => void;
  rowIndex?: number;
}

const EPOCH_ISO = '1970-01-01';

function formatDate(s: string): string {
  if (!s || s.startsWith(EPOCH_ISO)) return 'Never';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
}

function ageLabel(s: string): string {
  if (!s || s.startsWith(EPOCH_ISO)) return '';
  const days = Math.floor((Date.now() - new Date(s).getTime()) / 86_400_000);
  if (days < 1)   return 'today';
  if (days < 30)  return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

// ── Action badge config ────────────────────────────────────────────────────
interface BadgeCfg { dot: string; text: string; bg: string; border: string; label: string; }
const BADGE: Record<string, BadgeCfg> = {
  DISABLE:        { dot: 'bg-red-500',     text: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30',    label: 'Disable'     },
  UNTARGET:       { dot: 'bg-amber-400',   text: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/30',  label: 'Untarget'    },
  'HA-PROTECTED': { dot: 'bg-blue-400',    text: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/30',   label: 'HA-Protected'},
  PROTECTED:      { dot: 'bg-purple-400',  text: 'text-purple-400',  bg: 'bg-purple-500/10',  border: 'border-purple-500/30', label: 'Protected'   },
  IGNORE:         { dot: 'bg-[#374151]',   text: 'text-[#475569]',   bg: 'bg-[#131e30]',      border: 'border-[#1d2e45]',     label: 'Ignored'     },
  KEEP:           { dot: 'bg-emerald-400', text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30',label: 'Keep'        },
};
const getBadge = (action: string): BadgeCfg => BADGE[action] ?? BADGE['KEEP'];

// ── Target chip ───────────────────────────────────────────────────────────
const TargetChip: React.FC<{ name: string; displayName?: string; hasHits: boolean; toBeRemoved?: boolean }> = ({ name, displayName, hasHits, toBeRemoved }) => {
  // Always prioritize displayName when available
  const displayValue = displayName || name;
  
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono border ${
      toBeRemoved
        ? 'bg-red-500/10 border-red-500/40 text-red-400 line-through'
        : hasHits
          ? 'bg-[#00d4c8]/5 border-[#00d4c8]/25 text-[#00d4c8]'
          : 'bg-[#1d2e45] border-[#1d2e45] text-[#475569]'
    }`}>
      <span className={`w-1 h-1 rounded-full ${toBeRemoved ? 'bg-red-400' : hasHits ? 'bg-[#00d4c8]' : 'bg-[#374151]'}`} />
      {displayValue}
    </span>
  );
};

export const RuleRow: React.FC<RuleRowProps> = ({
  rule, auditMode = 'unused', isSelected = false, onSelectionChange, rowIndex = 0,
}) => {
  const badge = getBadge(rule.action);
  const isSelectable =
    (auditMode === 'disabled' && rule.action === 'DISABLE') ||
    (auditMode === 'unused' && (rule.action === 'DISABLE' || rule.action === 'UNTARGET'));

  const rowBg = isSelected
    ? 'bg-[#00d4c8]/5'
    : rowIndex % 2 === 0 ? 'bg-transparent' : 'bg-[#0c1322]/30';

  // Only render chips for targets being removed (untargeted/disabled).
  // Active targets that are staying don't need to be shown.
  const chips: React.ReactNode[] = [];
  const seen = new Set<string>();
  const removalTargets = rule.targets.filter(t => t.toBeRemoved);

  removalTargets.forEach(t => {
    if (seen.has(t.name)) return;
    if (t.haPartner) {
      const partner = rule.targets.find(p => p.name === t.haPartner);
      if (partner) {
        chips.push(
          <span key={`${t.name}-ha`} className="inline-flex items-center gap-0.5 border border-[#1d2e45] rounded-md px-0.5 bg-[#192540]">
            <TargetChip name={t.name} displayName={t.displayName} hasHits={t.hasHits} toBeRemoved={t.toBeRemoved} />
            <span className="text-[#374151] text-[10px] px-0.5">↔</span>
            <TargetChip name={partner.name} displayName={partner.displayName} hasHits={partner.hasHits} toBeRemoved={partner.toBeRemoved} />
          </span>
        );
        seen.add(t.name); seen.add(partner.name);
        return;
      }
    }
    chips.push(<TargetChip key={t.name} name={t.name} displayName={t.displayName} hasHits={t.hasHits} toBeRemoved={t.toBeRemoved} />);
    seen.add(t.name);
  });

  return (
    <tr className={`transition-colors hover:bg-[#192540]/60 ${rowBg} ${isSelected ? 'ring-inset ring-1 ring-[#00d4c8]/20' : ''}`}>
      {/* Checkbox */}
      <td className="px-5 py-3.5 w-10">
        {isSelectable ? (
          <input type="checkbox" checked={isSelected}
            onChange={e => onSelectionChange?.(e.target.checked)}
            className="w-4 h-4 rounded accent-[#00d4c8] cursor-pointer" />
        ) : <span />}
      </td>

      {/* Rule Name */}
      <td className="px-5 py-3.5 max-w-[400px]">
        <p className="text-sm font-medium text-[#e2e8f0] break-words font-mono">{rule.name}</p>
      </td>

      {/* Device Group */}
      <td className="px-5 py-3.5 whitespace-nowrap">
        <span className="text-xs text-[#475569] font-medium">{rule.deviceGroup}</span>
      </td>

      {/* Hits */}
      <td className="px-5 py-3.5 whitespace-nowrap">
        <span className="text-sm font-semibold text-[#00d4c8] tabular-nums font-mono">
          {rule.totalHits.toLocaleString()}
        </span>
      </td>

      {/* Last Hit */}
      <td className="px-5 py-3.5 whitespace-nowrap">
        <p className={`text-sm ${rule.lastHitDate.startsWith(EPOCH_ISO) ? 'text-[#475569]' : 'text-[#cbd5e1]'}`}>
          {formatDate(rule.lastHitDate)}
        </p>
        {!rule.lastHitDate.startsWith(EPOCH_ISO) && (
          <p className="text-[10px] text-[#64748b]">{ageLabel(rule.lastHitDate)}</p>
        )}
      </td>

      {/* Created */}
      <td className="px-5 py-3.5 whitespace-nowrap">
        <p className={`text-sm ${!rule.createdDate ? 'text-[#475569]' : 'text-[#cbd5e1]'}`}>
          {rule.createdDate ? formatDate(rule.createdDate) : '—'}
        </p>
        {rule.createdDate && (
          <p className="text-[10px] text-[#64748b]">{ageLabel(rule.createdDate)}</p>
        )}
      </td>

      {/* Targets / Disabled Date */}
      <td className="px-5 py-3.5">
        {auditMode === 'disabled' ? (
          <div>
            <p className={`text-sm ${!rule.disabledDate ? 'text-[#475569]' : 'text-[#cbd5e1]'}`}>
              {rule.disabledDate ? formatDate(rule.disabledDate) : '—'}
            </p>
            {rule.disabledDate && (
              <p className="text-[10px] text-[#64748b]">{ageLabel(rule.disabledDate)}</p>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">{chips}</div>
        )}
      </td>

      {/* Action badge */}
      <td className="px-5 py-3.5 pr-6 whitespace-nowrap text-right">
        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${badge.bg} ${badge.border} ${badge.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
          {badge.label}
        </span>
      </td>
    </tr>
  );
};
