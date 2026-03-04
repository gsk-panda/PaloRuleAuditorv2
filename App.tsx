import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { PanoramaConfig, PanoramaRule, AuditSummary, HAPair } from './types';
import { RuleRow } from './components/RuleRow';
import { ToastContainer, ToastItem, ToastType } from './components/Toast';
import { ConfirmModal } from './components/ConfirmModal';

const apiBase = ((import.meta.env.BASE_URL || '/').replace(/\/?$/, '') || '') + '/api';

// ─────────────────────────────────────────────────────────────────────────────
// Stat Card — matches screenshot style: label, large teal number, subtitle
// ─────────────────────────────────────────────────────────────────────────────
interface StatCardProps {
  label: string;
  value: number;
  subtitle?: string;
  color?: string;
  dimmed?: boolean;
  active?: boolean;
  onClick?: () => void;
}
const StatCard: React.FC<StatCardProps> = ({ label, value, subtitle, color = 'text-[#00d4c8]', dimmed, active, onClick }) => (
  <div
    onClick={onClick}
    className={`bg-[#131e30] rounded-xl p-5 border transition-all select-none ${
      onClick ? 'cursor-pointer' : ''
    } ${
      active
        ? 'border-[#00d4c8]/50 ring-1 ring-[#00d4c8]/20'
        : 'border-[#1d2e45] hover:border-[#2a4060]'
    } ${dimmed ? 'opacity-40' : ''}`}
  >
    <p className="text-[10px] font-semibold text-[#475569] uppercase tracking-widest mb-3">{label}</p>
    <p className={`text-4xl font-extrabold leading-none mb-2 ${dimmed || value === 0 ? 'text-[#374151]' : color}`}>
      {value === 0 ? '—' : value.toLocaleString()}
    </p>
    {subtitle && <p className="text-xs text-[#475569]">{subtitle}</p>}
    {onClick && (
      <p className={`text-[10px] mt-3 ${active ? 'text-[#00d4c8]' : 'text-[#2a4060] hover:text-[#00d4c8]'} transition-colors`}>
        {active ? '✕ clear filter' : 'click to filter'}
      </p>
    )}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Sortable TH
// ─────────────────────────────────────────────────────────────────────────────
interface SortableThProps {
  field: string; label: string;
  sortField: string | null; sortDir: 'asc' | 'desc';
  onSort: (f: string) => void; className?: string;
}
const SortableTh: React.FC<SortableThProps> = ({ field, label, sortField, sortDir, onSort, className = '' }) => {
  const active = sortField === field;
  return (
    <th
      onClick={() => onSort(field)}
      className={`px-5 py-3.5 text-left text-[10px] font-semibold uppercase tracking-widest cursor-pointer select-none transition-colors whitespace-nowrap ${
        active ? 'text-[#00d4c8]' : 'text-[#475569] hover:text-[#64748b]'
      } ${className}`}
    >
      {label} <span className="opacity-60">{active ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span>
    </th>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Live clock
// ─────────────────────────────────────────────────────────────────────────────
const Clock: React.FC = () => {
  const [t, setT] = useState('');
  useEffect(() => {
    const tick = () => setT(new Date().toUTCString().slice(5, 25) + ' UTC');
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="text-xs text-[#374151] font-mono hidden lg:block">{t}</span>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Connection status badge
// ─────────────────────────────────────────────────────────────────────────────
const ConnBadge: React.FC<{ status: 'idle'|'testing'|'ok'|'error'; msg: string }> = ({ status, msg }) => {
  const cfg = {
    idle:    { dot: 'bg-[#374151]',       text: 'text-[#475569]', label: 'Not tested' },
    testing: { dot: 'bg-amber-400 dot-pulse', text: 'text-amber-400', label: 'Testing…' },
    ok:      { dot: 'bg-emerald-400',     text: 'text-emerald-400', label: msg || 'Connected' },
    error:   { dot: 'bg-red-500',         text: 'text-red-400',   label: msg || 'Error' },
  }[status];
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-[#131e30] border border-[#1d2e45] rounded-lg">
      <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />
      <span className={`text-xs font-medium ${cfg.text} max-w-[180px] truncate`}>{cfg.label}</span>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────────────────────
const App: React.FC = () => {
  const [config, setConfig] = useState<PanoramaConfig>({ url: '', apiKey: '', unusedDays: 90 });
  const [auditMode, setAuditMode] = useState<'unused' | 'disabled'>('unused');
  const [disabledDays, setDisabledDays] = useState(90);
  const [haPairs, setHAPairs] = useState<HAPair[]>([]);
  const [isProductionMode, setIsProductionMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [rules, setRules] = useState<PanoramaRule[]>([]);
  const [deviceGroups, setDeviceGroups] = useState<string[]>([]);
  const [rulesProcessed, setRulesProcessed] = useState(0);
  const [isAuditing, setIsAuditing] = useState(false);
  const [auditProgress, setAuditProgress] = useState('');
  const [auditStep, setAuditStep] = useState(0);
  const [showReport, setShowReport] = useState(false);
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
  const [isApplyingRemediation, setIsApplyingRemediation] = useState(false);

  const [panoramaStatus, setPanoramaStatus] = useState<'idle'|'testing'|'ok'|'error'>('idle');
  const [panoramaStatusMsg, setPanoramaStatusMsg] = useState('');

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmModal, setConfirmModal] = useState<{
    title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void;
  } | null>(null);

  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc'|'desc'>('asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterDeviceGroup, setFilterDeviceGroup] = useState('all');
  const [filterAction, setFilterAction] = useState('all');

  // Load config
  useEffect(() => {
    fetch(apiBase + '/config').then(r => r.json()).then(d => {
      if (d.panoramaUrl || d.apiKey) {
        setConfig(p => ({ ...p, url: d.panoramaUrl || p.url, apiKey: d.apiKey || p.apiKey }));
      }
    }).catch(() => {});
  }, []);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    setToasts(p => [...p, { id: Date.now().toString(), message, type }]);
  }, []);
  const dismissToast = useCallback((id: string) => setToasts(p => p.filter(t => t.id !== id)), []);

  const handleSort = (field: string) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  const summary: AuditSummary = useMemo(() =>
    rules.reduce((acc, rule) => {
      acc.totalRules++;
      if      (rule.action === 'DISABLE')      acc.toDisable++;
      else if (rule.action === 'UNTARGET')     acc.toUntarget++;
      else if (rule.action === 'IGNORE')       acc.ignoredShared++;
      else if (rule.action === 'HA-PROTECTED') acc.haProtected++;
      else if (rule.action === 'PROTECTED')    acc.protected++;
      else                                     acc.toKeep++;
      return acc;
    }, { totalRules: 0, toDisable: 0, toUntarget: 0, toKeep: 0, ignoredShared: 0, haProtected: 0, protected: 0 }),
  [rules]);

  const filteredRules = useMemo(() => {
    let r = rules;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      r = r.filter(rule => rule.name.toLowerCase().includes(q) || rule.deviceGroup.toLowerCase().includes(q));
    }
    if (filterDeviceGroup !== 'all') r = r.filter(rule => rule.deviceGroup === filterDeviceGroup);
    if (filterAction !== 'all')      r = r.filter(rule => rule.action === filterAction);
    if (sortField) {
      r = [...r].sort((a, b) => {
        let av: any = a[sortField as keyof PanoramaRule];
        let bv: any = b[sortField as keyof PanoramaRule];
        if (typeof av === 'string') av = av.toLowerCase();
        if (typeof bv === 'string') bv = bv.toLowerCase();
        return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDir === 'asc' ? 1 : -1);
      });
    }
    return r;
  }, [rules, searchQuery, filterDeviceGroup, filterAction, sortField, sortDir]);

  const selectableRules = useMemo(() =>
    filteredRules.filter(r =>
      auditMode === 'disabled' ? r.action === 'DISABLE' : r.action === 'DISABLE' || r.action === 'UNTARGET'
    ), [filteredRules, auditMode]);

  const selectedCount = useMemo(() =>
    [...selectedRuleIds].filter(id => filteredRules.some(r => r.id === id)).length,
  [selectedRuleIds, filteredRules]);

  const allSelectableSelected = selectableRules.length > 0 && selectableRules.every(r => selectedRuleIds.has(r.id));
  const someSelectableSelected = selectableRules.some(r => selectedRuleIds.has(r.id)) && !allSelectableSelected;

  // ── Connectivity test ──────────────────────────────────────────────────────
  const handleTestPanorama = async () => {
    if (!config.url || !config.apiKey) { showToast('Enter Panorama URL and API key first', 'warning'); return; }
    setPanoramaStatus('testing'); setPanoramaStatusMsg('');
    try {
      const res = await fetch(apiBase + '/test/panorama', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: config.url, apiKey: config.apiKey }),
      });
      const data = await res.json();
      setPanoramaStatus(data.ok ? 'ok' : 'error');
      setPanoramaStatusMsg(data.message);
      showToast(data.message, data.ok ? 'success' : 'error');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed';
      setPanoramaStatus('error'); setPanoramaStatusMsg(msg); showToast(msg, 'error');
    }
  };

  // ── HA pairs upload ────────────────────────────────────────────────────────
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const pairs: HAPair[] = [];
      (ev.target?.result as string).split(/\r?\n/).forEach(line => {
        const p = line.split(':');
        if (p.length === 2 && p[0].trim() && p[1].trim()) pairs.push({ fw1: p[0].trim(), fw2: p[1].trim() });
      });
      if (!pairs.length) { showToast('No valid HA pairs. Expected fw1:fw2', 'warning'); return; }
      setHAPairs(pairs); showToast(`Loaded ${pairs.length} HA pair(s)`, 'success');
    };
    reader.readAsText(file);
  };

  // ── Audit ──────────────────────────────────────────────────────────────────
  const handleAudit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsAuditing(true); setAuditProgress('Connecting…'); setAuditStep(0);
    setShowReport(false); setRules([]);
    try {
      const endpoint = auditMode === 'disabled' ? apiBase + '/audit/disabled' : apiBase + '/audit';
      const body = auditMode === 'disabled'
        ? { url: config.url, apiKey: config.apiKey, disabledDays }
        : { url: config.url, apiKey: config.apiKey, unusedDays: config.unusedDays, haPairs };
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3_600_000);
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctrl.signal,
      });
      clearTimeout(tid);
      if (!response.ok) {
        const t = await response.text();
        throw new Error(`API error ${response.status}: ${t.substring(0, 200)}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');
      const dec = new TextDecoder();
      let buf = '';
      let lastResult: any = null, lastError: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const line of lines) {
          const tr = line.trim(); if (!tr) continue;
          try {
            const p = JSON.parse(tr);
            if (p.progress) { setAuditProgress(p.progress); setAuditStep(s => s + 1); }
            if (p.result)   lastResult = p.result;
            if (p.error)    lastError  = p.error;
          } catch (_) {}
        }
      }
      if (buf.trim()) { try { const p = JSON.parse(buf.trim()); if (p.result) lastResult = p.result; if (p.error) lastError = p.error; } catch (_) {} }
      if (lastError) throw new Error(lastError);
      if (lastResult) {
        const newRules = lastResult.rules ?? [];
        setRules(newRules);
        setDeviceGroups(lastResult.deviceGroups ?? []);
        setRulesProcessed(lastResult.rulesProcessed ?? 0);
        setSelectedRuleIds(new Set(newRules.filter((r: PanoramaRule) => r.action === 'DISABLE' || r.action === 'UNTARGET').map((r: PanoramaRule) => r.id)));
        setFilterDeviceGroup('all'); setFilterAction('all'); setSearchQuery('');
        setShowReport(true);
        showToast(`Audit complete — ${newRules.length} rules across ${(lastResult.deviceGroups ?? []).length} group(s)`, 'success');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      showToast(isAbort ? 'Audit timed out' : `Audit failed: ${msg}`, 'error');
    } finally {
      setIsAuditing(false); setAuditProgress('');
    }
  };

  // ── Remediation ────────────────────────────────────────────────────────────
  const getDisabledDateTag = () => {
    const d = new Date();
    return `disabled-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  };

  const handleApplyRemediation = () => {
    if (!isProductionMode) { showToast('Enable Production Mode to apply remediation', 'warning'); return; }
    const toProcess = rules.filter(r =>
      selectedRuleIds.has(r.id) &&
      (auditMode === 'disabled' ? r.action === 'DISABLE' : r.action === 'DISABLE' || r.action === 'UNTARGET')
    );
    if (!toProcess.length) { showToast('No rules selected', 'warning'); return; }
    // Count only the selected rules that will be processed
    const selectedRuleCount = toProcess.length;
    
    setConfirmModal({
      title: 'Confirm Remediation',
      message: `This will ${auditMode === 'disabled' ? 'permanently delete' : 'disable/untarget and tag'} ${selectedRuleCount} rule(s) in Panorama and commit. This cannot be undone.`,
      confirmLabel: auditMode === 'disabled' ? 'Delete Rules' : 'Apply Changes',
      danger: true,
      onConfirm: () => { setConfirmModal(null); executeRemediation(toProcess); },
    });
  };

  const executeRemediation = async (toProcess: PanoramaRule[]) => {
    setIsApplyingRemediation(true);
    try {
      const res = await fetch(apiBase + '/remediate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: config.url, apiKey: config.apiKey,
          rules: toProcess.map(r => ({ name: r.name, deviceGroup: r.deviceGroup, action: r.action, targets: r.targets })),
          tag: getDisabledDateTag(), auditMode,
        }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || res.statusText); }
      const result = await res.json();
      showToast(auditMode === 'disabled'
        ? `Deleted ${result.deletedCount ?? result.disabledCount} rule(s)`
        : `Applied: ${result.disabledCount} disabled, ${result.untargetedCount ?? 0} untargeted`,
      'success');
      if (result.errors?.length) showToast(`${result.errors.length} error(s) — check server logs`, 'warning');
    } catch (err) {
      showToast(`Remediation failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally { setIsApplyingRemediation(false); }
  };

  // ── Selection ──────────────────────────────────────────────────────────────
  const handleRuleSelection = (id: string, checked: boolean) =>
    setSelectedRuleIds(prev => { const n = new Set(prev); checked ? n.add(id) : n.delete(id); return n; });

  const handleSelectAll = (checked: boolean) =>
    setSelectedRuleIds(prev => {
      const n = new Set(prev);
      selectableRules.forEach(r => checked ? n.add(r.id) : n.delete(r.id));
      return n;
    });

  // ── PDF ────────────────────────────────────────────────────────────────────
  const handleExportPDF = async () => {
    try {
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF({ orientation: 'landscape' });
      const W = doc.internal.pageSize.getWidth(), M = 20;
      let y = M;
      doc.setFontSize(18); doc.text('Panorama Rule Auditor — Audit Report', M, y); y += 12;
      doc.setFontSize(10); doc.setTextColor(120, 120, 120);
      doc.text(`Generated: ${new Date().toLocaleString()}`, M, y); y += 6;
      doc.text(`URL: ${config.url}`, M, y); y += 6;
      doc.text(`Mode: ${auditMode === 'disabled' ? `Disabled Rules > ${disabledDays}d` : `Unused Rules > ${config.unusedDays}d`}`, M, y); y += 10;
      doc.setTextColor(0,0,0); doc.setFontSize(13); doc.text('Summary', M, y); y += 7;
      doc.setFontSize(10);
      [['Rules Scanned', rulesProcessed.toLocaleString()], ['Total Flagged', summary.totalRules.toString()],
       [`To ${auditMode === 'disabled' ? 'Delete' : 'Disable'}`, summary.toDisable.toString()],
       ...(auditMode !== 'disabled' ? [['To Untarget', summary.toUntarget.toString()]] : []),
       ['HA-Protected', summary.haProtected.toString()], ['Protected', summary.protected.toString()],
       ['Keep', summary.toKeep.toString()]].forEach(([l, v]) => { doc.text(`${l}: ${v}`, M, y); y += 5; });
      y += 5;
      if (rules.length) {
        doc.setFontSize(13); doc.text('Audit Results', M, y); y += 7;
        doc.setFontSize(8);
        const cols = ['Rule Name','Device Group','Hits','Last Hit','Created','Targets','Action'];
        const widths = [60,35,16,28,28,60,22];
        doc.setFillColor(220,220,220); doc.rect(M, y-4, W-2*M, 7, 'F');
        let x = M; cols.forEach((h,i) => { doc.text(h, x, y); x += widths[i]; }); y += 7;
        rules.forEach(rule => {
          if (y > doc.internal.pageSize.getHeight() - 20) { doc.addPage(); y = M; }
          x = M;
          const lh = rule.lastHitDate.startsWith('1970') ? 'Never' : new Date(rule.lastHitDate).toLocaleDateString();
          const cd = rule.createdDate ? new Date(rule.createdDate).toLocaleDateString() : '—';
          const tgts = rule.targets.map(t => t.displayName || t.name).join(', ');
          [rule.name.slice(0,26), rule.deviceGroup.slice(0,14), rule.totalHits.toString(),
           lh, cd, tgts.slice(0,28), rule.action]
            .forEach((c,i) => { doc.text(c, x, y); x += widths[i]; });
          y += 5;
        });
      }
      doc.save(`panorama-audit-${auditMode}-${new Date().toISOString().split('T')[0]}.pdf`);
      showToast('PDF exported', 'success');
    } catch (err) { showToast(`PDF failed: ${err instanceof Error ? err.message : 'error'}`, 'error'); }
  };

  // ── Styles ─────────────────────────────────────────────────────────────────
  const inputCls = 'w-full bg-[#0c1322] border border-[#1d2e45] text-[#e2e8f0] placeholder-[#374151] rounded-lg px-3.5 py-2.5 text-sm focus:outline-none focus:border-[#00d4c8]/50 focus:ring-1 focus:ring-[#00d4c8]/20 transition-colors';
  const labelCls = 'block text-xs font-semibold text-[#475569] mb-1.5';

  const actionFilterOptions = [
    { value: 'all', label: 'All Actions' }, { value: 'DISABLE', label: 'Disable' },
    { value: 'UNTARGET', label: 'Untarget' }, { value: 'HA-PROTECTED', label: 'HA-Protected' },
    { value: 'PROTECTED', label: 'Protected' }, { value: 'KEEP', label: 'Keep' }, { value: 'IGNORE', label: 'Ignored' },
  ];

  return (
    <div className="min-h-screen bg-[#0c1322] text-[#e2e8f0] pb-28">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title} message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel} danger={confirmModal.danger}
          onConfirm={confirmModal.onConfirm} onCancel={() => setConfirmModal(null)}
        />
      )}

      {/* ── Header ── */}
      <header className="bg-[#0c1322] border-b border-[#1d2e45] sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-6 h-16 flex items-center justify-between gap-6">
          {/* Logo + title */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-8 h-8 rounded-lg bg-[#00d4c8]/10 border border-[#00d4c8]/30 flex items-center justify-center">
              <svg className="w-4 h-4 text-[#00d4c8]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <div>
              <h1 className="text-sm font-bold text-[#e2e8f0] tracking-tight">Panorama Rule Auditor</h1>
              <p className="text-[10px] text-[#374151] font-medium">Security Policy Hygiene</p>
            </div>
          </div>

          {/* Center: URL + connection badge */}
          <div className="flex items-center gap-3 flex-1 justify-center min-w-0">
            {config.url && (
              <span className="text-xs text-[#374151] truncate max-w-xs font-mono hidden md:block">{config.url}</span>
            )}
            <ConnBadge status={panoramaStatus} msg={panoramaStatusMsg} />
          </div>

          {/* Right: clock + mode badge */}
          <div className="flex items-center gap-3 shrink-0">
            <Clock />
            {isProductionMode ? (
              <span className="px-2.5 py-1 text-[10px] font-bold text-red-400 bg-red-500/10 border border-red-500/30 rounded-full uppercase tracking-wide">
                ⚠ Production
              </span>
            ) : (
              <span className="px-2.5 py-1 text-[10px] font-bold text-[#00d4c8] bg-[#00d4c8]/10 border border-[#00d4c8]/30 rounded-full uppercase tracking-wide">
                Dry-Run
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-6 py-6 space-y-6">

        {/* ── Configuration Panel ── */}
        <section className="bg-[#131e30] border border-[#1d2e45] rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-[#1d2e45] flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[#e2e8f0]">Audit Configuration</h2>
              <p className="text-xs text-[#475569] mt-0.5">Configure and run a policy audit against Panorama</p>
            </div>
            {/* Mode toggle */}
            <div className="flex bg-[#0c1322] border border-[#1d2e45] rounded-lg p-1 gap-1">
              {(['unused','disabled'] as const).map(mode => (
                <button key={mode} type="button" onClick={() => setAuditMode(mode)}
                  className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-all ${
                    auditMode === mode
                      ? 'bg-[#00d4c8] text-[#0c1322]'
                      : 'text-[#475569] hover:text-[#64748b]'
                  }`}
                >
                  {mode === 'unused' ? 'Unused Rules' : 'Disabled Rules'}
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleAudit} className="p-6 space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Panorama URL */}
              <div>
                <label className={labelCls}>Panorama URL</label>
                <input type="text" value={config.url}
                  onChange={e => { setConfig({...config, url: e.target.value}); setPanoramaStatus('idle'); }}
                  className={inputCls} placeholder="https://panorama.example.com" required />
              </div>

              {/* API Key + test */}
              <div>
                <label className={labelCls}>API Key</label>
                <div className="flex gap-2">
                  <input type="password" value={config.apiKey}
                    onChange={e => { setConfig({...config, apiKey: e.target.value}); setPanoramaStatus('idle'); }}
                    className={inputCls} placeholder="••••••••••••" required />
                  <button type="button" onClick={handleTestPanorama}
                    disabled={panoramaStatus === 'testing'}
                    className={`shrink-0 px-3 py-2.5 text-xs font-semibold rounded-lg border transition-all ${
                      panoramaStatus === 'ok'    ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400' :
                      panoramaStatus === 'error' ? 'bg-red-500/10 border-red-500/40 text-red-400' :
                      'bg-[#0c1322] border-[#1d2e45] text-[#475569] hover:text-[#00d4c8] hover:border-[#00d4c8]/40'
                    }`}
                  >
                    {panoramaStatus === 'testing' ? '…' : panoramaStatus === 'ok' ? '✓' : panoramaStatus === 'error' ? '✕' : 'Test'}
                  </button>
                </div>
              </div>

              {/* Threshold */}
              <div>
                {auditMode === 'unused' ? (
                  <>
                    <label className={labelCls}>Unused Threshold (Days)</label>
                    <input type="number" value={config.unusedDays}
                      onChange={e => setConfig({...config, unusedDays: parseInt(e.target.value)||0})}
                      className={inputCls} min="1" required />
                  </>
                ) : (
                  <>
                    <label className={labelCls}>Disabled Threshold (Days)</label>
                    <input type="number" value={disabledDays}
                      onChange={e => setDisabledDays(parseInt(e.target.value)||0)}
                      className={inputCls} min="1" required />
                  </>
                )}
              </div>

              {/* Production mode */}
              <div className="flex flex-col justify-end">
                <label className={labelCls}>Remediation Mode</label>
                <label className="flex items-center gap-2.5 cursor-pointer group">
                  <div className="relative">
                    <input type="checkbox" checked={isProductionMode}
                      onChange={e => {
                        if (e.target.checked) {
                          setConfirmModal({
                            title: 'Enable Production Mode',
                            message: 'Production mode allows live changes to Panorama. Rules will be disabled, untargeted, or deleted. This cannot be undone.',
                            confirmLabel: 'Enable Production Mode', danger: true,
                            onConfirm: () => { setIsProductionMode(true); setConfirmModal(null); },
                          });
                        } else { setIsProductionMode(false); }
                      }}
                      className="sr-only" />
                    <div className={`w-10 h-5 rounded-full border transition-all ${
                      isProductionMode ? 'bg-red-500 border-red-600' : 'bg-[#0c1322] border-[#1d2e45]'
                    }`}>
                      <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform mt-0.5 ${
                        isProductionMode ? 'translate-x-5 ml-0.5' : 'translate-x-0.5'
                      }`} />
                    </div>
                  </div>
                  <span className={`text-sm font-medium transition-colors ${isProductionMode ? 'text-red-400' : 'text-[#475569] group-hover:text-[#64748b]'}`}>
                    {isProductionMode ? '⚠ Production' : 'Dry-Run only'}
                  </span>
                </label>
              </div>
            </div>

            {/* HA pairs */}
            {auditMode === 'unused' && (
              <div>
                <label className={labelCls}>HA Pairs <span className="text-[#374151] font-normal">(fw1:fw2 per line)</span></label>
                <div className="flex gap-2">
                  <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept=".txt,.csv" />
                  <button type="button" onClick={() => fileInputRef.current?.click()}
                    className="flex-1 px-4 py-2.5 bg-[#0c1322] border border-dashed border-[#1d2e45] hover:border-[#2a4060] rounded-lg text-sm text-[#374151] hover:text-[#475569] transition-colors text-left truncate"
                  >
                    {haPairs.length > 0 ? `✓  ${haPairs.length} HA pair(s) loaded` : '+ Upload HA pairs file'}
                  </button>
                  {haPairs.length > 0 && (
                    <button type="button" onClick={() => { setHAPairs([]); showToast('HA pairs cleared', 'info'); }}
                      className="px-3 text-xs text-[#374151] hover:text-red-400 border border-[#1d2e45] rounded-lg transition-colors"
                    >Clear</button>
                  )}
                </div>
              </div>
            )}

            {/* Audit button */}
            <div>
              <button type="submit" disabled={isAuditing}
                className="w-full bg-[#00d4c8] hover:bg-[#00bfb3] disabled:bg-[#00d4c8]/20 disabled:text-[#00d4c8]/30 text-[#0c1322] font-bold text-sm py-3 rounded-xl transition-all flex items-center justify-center gap-3"
              >
                {isAuditing ? (
                  <>
                    <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                    </svg>
                    Scanning…
                  </>
                ) : auditMode === 'disabled'
                  ? `Run Audit — Find Disabled Rules (> ${disabledDays} days)`
                  : `Run Audit — Find Unused Rules (> ${config.unusedDays} days)`
                }
              </button>

              {isAuditing && (
                <div className="mt-3 space-y-2">
                  <div className="h-1 bg-[#1d2e45] rounded-full overflow-hidden">
                    <div className="h-full rounded-full shimmer-bar" style={{ width: `${Math.min(95, auditStep * 8 + 5)}%` }} />
                  </div>
                  <p className="text-xs text-[#475569] text-center">{auditProgress || 'Connecting to Panorama…'}</p>
                </div>
              )}
            </div>
          </form>
        </section>

        {/* ── Report ── */}
        {showReport && (
          <div className="space-y-6">

            {/* Stat cards — row 1: main counts */}
            <div>
              <p className="text-[10px] font-semibold text-[#374151] uppercase tracking-widest mb-3">Audit Summary</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <StatCard label="Total Flagged"  value={summary.totalRules}  subtitle={`${rulesProcessed.toLocaleString()} rules scanned`} color="text-[#00d4c8]" />
                <StatCard label={auditMode === 'disabled' ? 'To Delete' : 'To Disable'} value={summary.toDisable}
                  color="text-red-400" dimmed={summary.toDisable === 0}
                  active={filterAction === 'DISABLE'} onClick={() => setFilterAction(filterAction === 'DISABLE' ? 'all' : 'DISABLE')} />
                {auditMode !== 'disabled' && (
                  <StatCard label="To Untarget" value={summary.toUntarget} color="text-amber-400"
                    dimmed={summary.toUntarget === 0} active={filterAction === 'UNTARGET'}
                    onClick={() => setFilterAction(filterAction === 'UNTARGET' ? 'all' : 'UNTARGET')} />
                )}
                <StatCard label="HA-Protected" value={summary.haProtected} color="text-blue-400"
                  dimmed={summary.haProtected === 0} active={filterAction === 'HA-PROTECTED'}
                  onClick={() => setFilterAction(filterAction === 'HA-PROTECTED' ? 'all' : 'HA-PROTECTED')} />
                <StatCard label="Protected" value={summary.protected} color="text-purple-400"
                  dimmed={summary.protected === 0} active={filterAction === 'PROTECTED'}
                  onClick={() => setFilterAction(filterAction === 'PROTECTED' ? 'all' : 'PROTECTED')} />
                <StatCard label="Keep Active" value={summary.toKeep} color="text-emerald-400"
                  dimmed={summary.toKeep === 0} active={filterAction === 'KEEP'}
                  onClick={() => setFilterAction(filterAction === 'KEEP' ? 'all' : 'KEEP')} />
              </div>
            </div>

            {/* Device group pills */}
            <div className="bg-[#131e30] border border-[#1d2e45] rounded-2xl px-6 py-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] font-semibold text-[#374151] uppercase tracking-widest">
                  Device Groups <span className="text-[#00d4c8]">({deviceGroups.length})</span>
                </p>
                {filterDeviceGroup !== 'all' && (
                  <button onClick={() => setFilterDeviceGroup('all')} className="text-xs text-[#475569] hover:text-[#00d4c8] transition-colors">
                    Clear filter
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {deviceGroups.length > 0 ? deviceGroups.map(dg => (
                  <button key={dg} onClick={() => setFilterDeviceGroup(filterDeviceGroup === dg ? 'all' : dg)}
                    className={`px-3.5 py-1.5 text-xs font-medium rounded-full border transition-all ${
                      filterDeviceGroup === dg
                        ? 'bg-[#00d4c8]/10 border-[#00d4c8]/50 text-[#00d4c8]'
                        : 'bg-[#0c1322] border-[#1d2e45] text-[#475569] hover:text-[#64748b] hover:border-[#2a4060]'
                    }`}
                  >{dg}</button>
                )) : (
                  <span className="text-xs text-[#374151] italic">No device groups found</span>
                )}
              </div>
            </div>

            {/* Rules table */}
            <div className="bg-[#131e30] border border-[#1d2e45] rounded-2xl overflow-hidden">
              {/* Toolbar */}
              <div className="px-6 py-4 border-b border-[#1d2e45] flex flex-col sm:flex-row items-start sm:items-center gap-3 justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-[#e2e8f0]">Audit Results</h3>
                  <p className="text-xs text-[#475569] mt-0.5">{filteredRules.length} of {rules.length} rules</p>
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search rules or groups…"
                    className="flex-1 sm:w-56 bg-[#0c1322] border border-[#1d2e45] text-[#e2e8f0] placeholder-[#374151] rounded-lg px-3.5 py-2 text-xs focus:outline-none focus:border-[#00d4c8]/50 focus:ring-1 focus:ring-[#00d4c8]/20 transition-colors"
                  />
                  <select value={filterAction} onChange={e => setFilterAction(e.target.value)}
                    className="bg-[#0c1322] border border-[#1d2e45] text-[#475569] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[#00d4c8]/50 transition-colors"
                  >
                    {actionFilterOptions.map(o => <option key={o.value} value={o.value} className="bg-[#131e30]">{o.label}</option>)}
                  </select>
                  <button onClick={handleExportPDF}
                    className="px-3.5 py-2 text-xs font-medium text-[#475569] hover:text-[#e2e8f0] bg-[#0c1322] border border-[#1d2e45] hover:border-[#2a4060] rounded-lg transition-colors whitespace-nowrap"
                  >↓ PDF</button>
                </div>
              </div>

              {/* Table */}
              <div className="overflow-x-auto">
                <table className="min-w-full">
                  <thead className="bg-[#0c1322]">
                    <tr className="border-b border-[#1d2e45]">
                      <th className="px-5 py-3.5 w-10">
                        <input type="checkbox" checked={allSelectableSelected}
                          ref={el => { if (el) el.indeterminate = someSelectableSelected; }}
                          onChange={e => handleSelectAll(e.target.checked)}
                          disabled={selectableRules.length === 0}
                          className="w-4 h-4 rounded accent-[#00d4c8] cursor-pointer" />
                      </th>
                      <SortableTh field="name" label="Rule Name" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                      <SortableTh field="deviceGroup" label="Device Group" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                      <SortableTh field="totalHits" label="Hits" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                      <th className="px-5 py-3.5 text-left text-[10px] font-semibold text-[#475569] uppercase tracking-widest whitespace-nowrap">Last Hit</th>
                      <th className="px-5 py-3.5 text-left text-[10px] font-semibold text-[#475569] uppercase tracking-widest whitespace-nowrap">Created</th>
                      <th className="px-5 py-3.5 text-left text-[10px] font-semibold text-[#475569] uppercase tracking-widest whitespace-nowrap">
                        {auditMode === 'disabled' ? 'Disabled Date' : 'Targets'}
                      </th>
                      <SortableTh field="action" label="Action" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-right pr-6" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1d2e45]">
                    {filteredRules.length > 0 ? (
                      filteredRules.map((rule, idx) => (
                        <RuleRow key={rule.id} rule={rule} auditMode={auditMode}
                          isSelected={selectedRuleIds.has(rule.id)}
                          onSelectionChange={checked => handleRuleSelection(rule.id, checked)}
                          rowIndex={idx} />
                      ))
                    ) : (
                      <tr>
                        <td colSpan={7} className="px-5 py-16 text-center text-sm text-[#374151]">
                          {searchQuery || filterDeviceGroup !== 'all' || filterAction !== 'all'
                            ? 'No rules match the current filters'
                            : 'No rules returned by audit'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Reference panels */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-[#131e30] border border-[#1d2e45] rounded-2xl p-6">
                <h3 className="text-sm font-semibold text-[#e2e8f0] mb-4">HA-Pair Decision Logic</h3>
                <ul className="space-y-3 text-xs text-[#475569]">
                  <li className="flex gap-3"><span className="text-blue-400 shrink-0 mt-0.5">↔</span>Either firewall in HA pair has hits → both protected from changes</li>
                  <li className="flex gap-3"><span className="text-amber-400 shrink-0 mt-0.5">↗</span><span className="text-amber-400 font-semibold">UNTARGET</span>: Remove from unused firewalls only. Active firewalls keep the rule.</li>
                  <li className="flex gap-3"><span className="text-red-400 shrink-0 mt-0.5">✕</span><span className="text-red-400 font-semibold">DISABLE</span>: All targets unused. Tagged: <span className="text-[#00d4c8] font-mono ml-1 text-[10px]">{getDisabledDateTag()}</span></li>
                  <li className="flex gap-3"><span className="text-[#374151] shrink-0 mt-0.5">—</span>Rules in Shared device group are always ignored</li>
                </ul>
              </div>
              <div className="bg-[#131e30] border border-[#1d2e45] rounded-2xl p-6">
                <h3 className="text-sm font-semibold text-[#e2e8f0] mb-4">API Reference</h3>
                <div className="space-y-3">
                  <div>
                    <p className="text-[10px] font-semibold text-[#374151] uppercase tracking-widest mb-2">Hit Count Query</p>
                    <pre className="bg-[#0c1322] border border-[#1d2e45] rounded-lg px-4 py-3 text-[10px] text-[#00d4c8] font-mono leading-relaxed overflow-x-auto">{`<show><rule-hit-count>
  <device-group>
    <entry name="GROUP">...</entry>
  </device-group>
</rule-hit-count></show>`}</pre>
                  </div>
                  <p className="text-xs text-[#374151]">Source: Panorama XML API op commands querying managed firewall rule-hit-count statistics</p>
                </div>
              </div>
            </div>

          </div>
        )}
      </main>

      {/* ── Bottom action bar ── */}
      {showReport && (summary.toDisable > 0 || (auditMode !== 'disabled' && summary.toUntarget > 0)) && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#0c1322]/95 border-t border-[#1d2e45] backdrop-blur-sm">
          <div className="max-w-[1600px] mx-auto px-6 py-3.5 flex items-center justify-between gap-4">
            <p className="text-sm text-[#475569]">
              <span className="text-[#00d4c8] font-bold">{selectedCount}</span>
              <span className="mx-1">/</span>
              <span>{selectableRules.length}</span>
              <span className="ml-1">rules selected</span>
              {!isProductionMode && <span className="ml-3 text-[#1d2e45] text-xs">Dry-run active — no changes will be made</span>}
            </p>
            <div className="flex items-center gap-3">
              <button onClick={handleExportPDF}
                className="px-4 py-2 text-xs font-semibold text-[#475569] hover:text-[#e2e8f0] bg-[#131e30] border border-[#1d2e45] hover:border-[#2a4060] rounded-lg transition-colors">
                ↓ Export PDF
              </button>
              <button onClick={handleApplyRemediation}
                disabled={!isProductionMode || isApplyingRemediation || selectedCount === 0}
                className={`px-6 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-2 ${
                  !isProductionMode
                    ? 'bg-[#1d2e45] text-[#374151] cursor-not-allowed'
                    : selectedCount === 0
                    ? 'bg-red-900/30 text-red-800 cursor-not-allowed'
                    : 'bg-red-500 hover:bg-red-600 text-white shadow-[0_0_20px_rgba(239,68,68,0.3)]'
                }`}
              >
                {isApplyingRemediation ? (
                  <><svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/></svg>Applying…</>
                ) : `${auditMode === 'disabled' ? 'Delete' : 'Apply'} (${selectedCount})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
