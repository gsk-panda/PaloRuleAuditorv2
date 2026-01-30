
import React from 'react';
import { PanoramaRule, FirewallTarget } from '../types';

interface RuleRowProps {
  rule: PanoramaRule;
  auditMode?: 'unused' | 'disabled';
  isSelected?: boolean;
  onSelectionChange?: (checked: boolean) => void;
}

export const RuleRow: React.FC<RuleRowProps> = ({ rule, auditMode = 'unused', isSelected = false, onSelectionChange }) => {
  const getActionBadge = (action: string) => {
    switch (action) {
      case 'DISABLE':
        return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-700 uppercase">Disable</span>;
      case 'UNTARGET':
        return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-amber-100 text-amber-700 uppercase">Untarget</span>;
      case 'IGNORE':
        return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-500 uppercase">Ignored (Shared)</span>;
      case 'HA-PROTECTED':
        return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-indigo-100 text-indigo-700 uppercase">HA-Protected</span>;
      case 'PROTECTED':
        return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-purple-100 text-purple-700 uppercase">Protected</span>;
      default:
        return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-700 uppercase">Keep</span>;
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString();
  };

  // Group targets by HA Pair for display
  const renderedTargets = [];
  const processed = new Set<string>();

  rule.targets.forEach(t => {
    if (processed.has(t.name)) return;

    if (t.haPartner) {
      const partner = rule.targets.find(p => p.name === t.haPartner);
      if (partner) {
        renderedTargets.push(
          <div key={`${t.name}-${partner.name}`} className="flex items-center gap-0.5 border border-slate-200 rounded p-0.5 bg-slate-50">
            <span className={`text-[10px] px-1 rounded ${t.hasHits ? 'bg-blue-100 text-blue-700' : 'bg-red-50 text-red-400 line-through'}`}>{t.name}</span>
            <span className="text-[10px] text-slate-400">:</span>
            <span className={`text-[10px] px-1 rounded ${partner.hasHits ? 'bg-blue-100 text-blue-700' : 'bg-red-50 text-red-400 line-through'}`}>{partner.name}</span>
          </div>
        );
        processed.add(t.name);
        processed.add(partner.name);
      } else {
        renderedTargets.push(
          <span key={t.name} className={`text-[10px] px-1.5 py-0.5 rounded border ${t.hasHits ? 'bg-blue-50 border-blue-200 text-blue-600' : 'bg-red-50 border-red-200 text-red-500 line-through'}`}>
            {t.name}
          </span>
        );
        processed.add(t.name);
      }
    } else {
      renderedTargets.push(
        <span key={t.name} className={`text-[10px] px-1.5 py-0.5 rounded border ${t.hasHits ? 'bg-blue-50 border-blue-200 text-blue-600' : 'bg-red-50 border-red-200 text-red-500 line-through'}`}>
          {t.name}
        </span>
      );
      processed.add(t.name);
    }
  });

  return (
    <tr className="hover:bg-gray-50 border-b border-gray-100 transition-colors">
      {(auditMode === 'disabled' && rule.action === 'DISABLE') || (auditMode === 'unused' && (rule.action === 'DISABLE' || rule.action === 'UNTARGET')) ? (
        <td className="px-6 py-4 whitespace-nowrap">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={(e) => onSelectionChange?.(e.target.checked)}
            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
          />
        </td>
      ) : (
        <td className="px-6 py-4 whitespace-nowrap"></td>
      )}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="text-sm font-medium text-gray-900">{rule.name}</div>
        <div className="text-xs text-gray-500">{rule.deviceGroup}</div>
      </td>
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="text-sm text-gray-900">{rule.totalHits.toLocaleString()} hits</div>
        <div className="text-xs text-gray-400">{auditMode === 'disabled' ? 'Disabled:' : 'Last:'} {formatDate(rule.lastHitDate)}</div>
      </td>
      <td className="px-6 py-4">
        <div className="flex flex-wrap gap-2">
          {renderedTargets.length > 0 ? renderedTargets : <span className="text-xs text-gray-400 italic">No specific targets</span>}
        </div>
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-right">
        {getActionBadge(rule.action)}
      </td>
    </tr>
  );
};
