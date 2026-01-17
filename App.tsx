
import React, { useState, useMemo, useRef } from 'react';
import { PanoramaConfig, PanoramaRule, AuditSummary, HAPair } from './types';
import { analyzeRulesWithAI } from './services/geminiService';
import { RuleRow } from './components/RuleRow';

const App: React.FC = () => {
  const [config, setConfig] = useState<PanoramaConfig>({
    url: 'https://panorama.officeours.com',
    apiKey: 'LUFRPT1LQWx1dUk4RVVqODQrQkN3TDZtRlBYd0dHUkk9dzczNHg3T0VsRS9yYmFMcEpWdXBWdFZ4S3Jwd0JYeEdLaTNnc2RVV29iQ1BqcnVCRU1vOVVHUmF6SUE2VHlDOA==',
    unusedDays: 90
  });

  const [haPairs, setHAPairs] = useState<HAPair[]>([]);
  const [rules, setRules] = useState<PanoramaRule[]>([]);
  const [deviceGroups, setDeviceGroups] = useState<string[]>([]);
  const [isAuditing, setIsAuditing] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [showApiPreview, setShowApiPreview] = useState(false);
  const [apiCalls, setApiCalls] = useState<Array<{ url: string; description: string; xmlCommand?: string }>>([]);
  const [currentApiCallIndex, setCurrentApiCallIndex] = useState(0);
  const [pendingAudit, setPendingAudit] = useState<{ url: string; apiKey: string; unusedDays: number; haPairs: HAPair[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const summary: AuditSummary = useMemo(() => {
    return rules.reduce((acc, rule) => {
      acc.totalRules++;
      if (rule.action === 'DISABLE') acc.toDisable++;
      else if (rule.action === 'UNTARGET') acc.toUntarget++;
      else if (rule.action === 'IGNORE') acc.ignoredShared++;
      else acc.toKeep++;
      return acc;
    }, { totalRules: 0, toDisable: 0, toUntarget: 0, toKeep: 0, ignoredShared: 0 });
  }, [rules]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      const lines = content.split(/\r?\n/);
      const pairs: HAPair[] = [];
      lines.forEach(line => {
        const parts = line.split(':');
        if (parts.length === 2) {
          pairs.push({ fw1: parts[0].trim(), fw2: parts[1].trim() });
        }
      });
      setHAPairs(pairs);
    };
    reader.readAsText(file);
  };

  const handleAudit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAiAnalysis(null);
    
    try {
      const previewResponse = await fetch('/api/audit/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: config.url,
          apiKey: config.apiKey
        })
      });

      if (!previewResponse.ok) {
        throw new Error(`Preview error: ${previewResponse.statusText}`);
      }

      const previewData = await previewResponse.json();
      setApiCalls(previewData.apiCalls || []);
      setCurrentApiCallIndex(0);
      setPendingAudit({
        url: config.url,
        apiKey: config.apiKey,
        unusedDays: config.unusedDays,
        haPairs: haPairs
      });
      setShowApiPreview(true);
    } catch (error) {
      console.error('Preview failed:', error);
      alert(`Failed to generate preview: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleApiCallApproval = async () => {
    if (currentApiCallIndex < apiCalls.length - 1) {
      setCurrentApiCallIndex(currentApiCallIndex + 1);
    } else {
      setShowApiPreview(false);
      if (pendingAudit) {
        setIsAuditing(true);
        try {
          const response = await fetch('/api/audit', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(pendingAudit)
          });

          if (!response.ok) {
            throw new Error(`API error: ${response.statusText}`);
          }

          const data = await response.json();
          console.log('API Response:', data);
          setRules(data.rules || []);
          setDeviceGroups(data.deviceGroups || []);
          console.log('Device groups set:', data.deviceGroups);
          setShowReport(true);
        } catch (error) {
          console.error('Audit failed:', error);
          alert(`Failed to perform audit: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
          setIsAuditing(false);
          setPendingAudit(null);
        }
      }
    }
  };

  const handleCancelApiPreview = () => {
    setShowApiPreview(false);
    setApiCalls([]);
    setCurrentApiCallIndex(0);
    setPendingAudit(null);
  };

  const runAiAnalysis = async () => {
    setIsAiLoading(true);
    const analysis = await analyzeRulesWithAI(rules, config.unusedDays);
    setAiAnalysis(analysis);
    setIsAiLoading(false);
  };

  const getDisabledDateTag = () => {
    const d = new Date();
    return `disabled-${d.getFullYear()}${(d.getMonth() + 1).toString().padStart(2, '0')}${d.getDate().toString().padStart(2, '0')}`;
  };

  const currentApiCall = apiCalls[currentApiCallIndex];

  return (
    <div className="min-h-screen pb-20">
      {showApiPreview && currentApiCall && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-4xl w-full mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-bold mb-4 text-gray-800">
              API Call Preview ({currentApiCallIndex + 1} of {apiCalls.length})
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">Description:</label>
                <p className="text-gray-900 bg-gray-50 p-2 rounded">{currentApiCall.description}</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">URL:</label>
                <div className="bg-gray-50 p-3 rounded border border-gray-200">
                  <code className="text-xs text-gray-800 break-all">{currentApiCall.url}</code>
                </div>
              </div>
              {currentApiCall.xmlCommand && (
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">XML Command:</label>
                  <div className="bg-gray-50 p-3 rounded border border-gray-200">
                    <pre className="text-xs text-gray-800 whitespace-pre-wrap break-all">{currentApiCall.xmlCommand}</pre>
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={handleCancelApiPreview}
                className="px-4 py-2 bg-gray-300 text-gray-700 rounded hover:bg-gray-400 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleApiCallApproval}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
              >
                {currentApiCallIndex < apiCalls.length - 1 ? 'Next' : 'OK - Execute Audit'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Header */}
      <header className="bg-slate-900 text-white py-6 shadow-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="bg-blue-500 p-2 rounded-lg">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold tracking-tight">Panorama Rule Auditor</h1>
          </div>
          <div className="text-xs text-slate-400 font-mono hidden md:block">
            {config.url}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 mt-8 max-w-6xl">
        {/* Config Form */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-8">
          <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
            Audit Settings
          </h2>
          <form onSubmit={handleAudit} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-600">Panorama URL</label>
                <input 
                  type="text" 
                  value={config.url}
                  onChange={e => setConfig({...config, url: e.target.value})}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all"
                  placeholder="https://your-panorama-ip"
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-600">API Key</label>
                <input 
                  type="password" 
                  value={config.apiKey}
                  onChange={e => setConfig({...config, apiKey: e.target.value})}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all"
                  placeholder="••••••••••••••••"
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-600">Unused Threshold (Days)</label>
                <input 
                  type="number" 
                  value={config.unusedDays}
                  onChange={e => setConfig({...config, unusedDays: parseInt(e.target.value) || 0})}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all"
                  min="1"
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-600">HA Pairs Definition (.txt)</label>
                <div className="flex gap-2">
                  <input 
                    type="file" 
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                    className="hidden"
                    accept=".txt,.csv"
                  />
                  <button 
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 px-4 py-2 bg-slate-50 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:bg-slate-100 transition-all text-left truncate"
                  >
                    {haPairs.length > 0 ? `${haPairs.length} HA Pairs Loaded` : 'Upload fw1:fw2 file'}
                  </button>
                  {haPairs.length > 0 && (
                    <button 
                      type="button" 
                      onClick={() => setHAPairs([])}
                      className="text-red-500 hover:text-red-700 p-2"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-slate-400">Format: firewall1:firewall2</p>
              </div>
            </div>
            
            <div className="pt-2">
              <button 
                type="submit"
                disabled={isAuditing}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-semibold py-3 px-6 rounded-lg shadow-md transition-all flex justify-center items-center gap-2"
              >
                {isAuditing ? (
                  <>
                    <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Scanning Panorama Rules...
                  </>
                ) : 'Generate Dry Run Report'}
              </button>
            </div>
          </form>
        </section>

        {showReport && (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Device Groups Found */}
            <div className="bg-blue-50 rounded-xl border border-blue-200 p-4">
              <h3 className="text-sm font-semibold text-blue-800 mb-2 flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Device Groups Found ({deviceGroups.length})
              </h3>
              {deviceGroups.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {deviceGroups.map((dg) => (
                    <span
                      key={dg}
                      className={`px-3 py-1 rounded-full text-xs font-medium ${
                        dg === 'Shared'
                          ? 'bg-slate-200 text-slate-700'
                          : 'bg-blue-100 text-blue-700'
                      }`}
                    >
                      {dg}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-blue-600 italic">No device groups found in the scan results.</p>
              )}
            </div>
            
            {/* Stats Summary */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                <p className="text-xs text-slate-500 uppercase font-bold mb-1">Total Rules</p>
                <p className="text-2xl font-bold text-slate-800">{summary.totalRules}</p>
              </div>
              <div className="bg-red-50 p-4 rounded-xl border border-red-100 shadow-sm">
                <p className="text-xs text-red-600 uppercase font-bold mb-1">To Disable</p>
                <p className="text-2xl font-bold text-red-700">{summary.toDisable}</p>
              </div>
              <div className="bg-amber-50 p-4 rounded-xl border border-amber-100 shadow-sm">
                <p className="text-xs text-amber-600 uppercase font-bold mb-1">To Untarget</p>
                <p className="text-2xl font-bold text-amber-700">{summary.toUntarget}</p>
              </div>
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 shadow-sm">
                <p className="text-xs text-slate-500 uppercase font-bold mb-1">Ignored (Shared)</p>
                <p className="text-2xl font-bold text-slate-600">{summary.ignoredShared}</p>
              </div>
              <div className="bg-green-50 p-4 rounded-xl border border-green-100 shadow-sm">
                <p className="text-xs text-green-600 uppercase font-bold mb-1">Keep Active</p>
                <p className="text-2xl font-bold text-green-700">{summary.toKeep}</p>
              </div>
            </div>

            {/* Dry Run Detail */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                <h3 className="text-lg font-semibold text-slate-800">Audit Results</h3>
                <div className="flex gap-2">
                   <button 
                    onClick={runAiAnalysis}
                    disabled={isAiLoading}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 rounded-md transition-colors"
                  >
                    {isAiLoading ? 'Analyzing...' : 'AI Security Commentary'}
                  </button>
                  <button className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white text-slate-700 hover:bg-slate-50 border border-slate-200 rounded-md transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                    Export
                  </button>
                </div>
              </div>

              {aiAnalysis && (
                <div className="p-6 bg-slate-900 text-slate-100 border-b border-slate-800 overflow-auto max-h-96 prose prose-invert max-w-none">
                  <div className="flex items-center gap-2 mb-4 text-blue-400">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
                    <span className="font-semibold uppercase tracking-wider text-xs">Gemini AI Audit Intelligence</span>
                  </div>
                  <div className="text-sm font-light leading-relaxed whitespace-pre-wrap">
                    {aiAnalysis}
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Rule Name / Group</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Hit Stats</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Target Status (HA Aware)</th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Proposed Action</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {rules.map((rule) => (
                      <RuleRow key={rule.id} rule={rule} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Automation Logic Recap */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-slate-50 rounded-xl p-6 border border-slate-200">
                <h4 className="font-semibold text-slate-800 mb-3 uppercase tracking-wider text-xs">HA-Pair Audit Logics</h4>
                <ul className="space-y-3 text-sm text-slate-600">
                  <li className="flex gap-3">
                    <span className="h-5 w-5 rounded bg-indigo-100 text-indigo-600 flex items-center justify-center font-bold text-xs">HA</span>
                    <span>Rules targeted to HA pairs are only remediation-eligible if <strong>BOTH</strong> firewalls in the pair show 0 hits.</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="h-5 w-5 rounded bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-xs">1</span>
                    <span>Rules in <strong className="text-slate-800">Shared</strong> device group are completely ignored.</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="h-5 w-5 rounded bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-xs">2</span>
                    <span>Full Disable: 0 hits across all targets for {config.unusedDays} days. Tag: <code className="bg-slate-200 px-1 rounded">{getDisabledDateTag()}</code>.</span>
                  </li>
                </ul>
              </div>

              <div className="bg-slate-50 rounded-xl p-6 border border-slate-200">
                <h4 className="font-semibold text-slate-800 mb-3 uppercase tracking-wider text-xs">Technical Reference</h4>
                <div className="space-y-4">
                   <div>
                    <p className="text-xs font-bold text-slate-500 uppercase mb-1">Hit Detection Command</p>
                    <code className="text-xs block bg-slate-200 p-2 rounded font-mono text-slate-700">
                      show running panorama-rule-use
                    </code>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-500 uppercase mb-1">API Endpoint Context</p>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Audits are performed by querying the Panorama XML API via Operational Commands to pull the most recent rule usage statistics from managed firewalls.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Floating Action Button */}
      {showReport && (
        <div className="fixed bottom-8 right-8 z-40">
          <button 
            className="bg-red-600 hover:bg-red-700 text-white font-bold py-4 px-8 rounded-full shadow-2xl flex items-center gap-2 transform hover:scale-105 transition-all"
            onClick={() => alert("This would update Panorama configuration. Not available in dry run mode.")}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            Apply Remediation (Production)
          </button>
        </div>
      )}
    </div>
  );
};

export default App;
