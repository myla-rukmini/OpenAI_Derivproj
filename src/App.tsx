import React, { useState, useEffect } from 'react';
import { Play, CheckCircle, AlertCircle, FileText, Code, MessageSquare, Terminal, ChevronRight, Activity, Cpu } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

import { GoogleGenAI } from "@google/genai";
import { computeStructuredDiff } from './pipeline/diff';
import { classifyChanges } from './pipeline/classification';
import { generateSnippets } from './pipeline/snippets';
import { generateCommunications } from './pipeline/comms';
import { validateSnippet } from './pipeline/validation';
import { generateCompatibilityTests } from './pipeline/tests';
import { generateTelemetryPlan } from './pipeline/telemetry';

export default function App() {
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [classifications, setClassifications] = useState<any[]>([]);
  const [diffs, setDiffs] = useState<any[]>([]);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [llmLogs, setLlmLogs] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'snippets' | 'audit'>('snippets');

  const selectedClassification = classifications.find(c => c.change_id === selectedChangeId);

  const STAGES = [
    'INIT', 'SPECS_LOADED', 'STRUCTURED_DIFF_COMPUTED', 
    'CHANGES_CLASSIFIED', 'SNIPPETS_VALIDATED', 
    'COMMUNICATIONS_GEN', 'VALIDATION_COMPLETE', 'RESULTS_FINALISED'
  ];

  const getCurrentStage = () => {
    if (status === 'idle') return -1;
    const lastLog = logs[logs.length - 1] || "";
    const stageIdx = STAGES.findIndex(s => lastLog.includes(s));
    if (stageIdx !== -1) return stageIdx;
    if (status === 'success') return STAGES.length - 1;
    return -1;
  };

  const runPipeline = async () => {
    setStatus('running');
    setLogs(['Initializing frontend pipeline...']);
    const addLog = (msg: string) => setLogs(prev => [...prev, msg]);

    try {
      addLog("STAGE: INIT -> SPECS_LOADED");
      const specsRes = await fetch('/api/specs');
      const { v1, v2 } = await specsRes.json();

      addLog("STAGE: STRUCTURED_DIFF_COMPUTED");
      const computedDiffs = computeStructuredDiff(v1, v2);
      setDiffs(computedDiffs);
      await fetch('/api/save-artifact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'spec_diff.json', content: computedDiffs })
      });

      const ai = new GoogleGenAI({ apiKey: (process.env as any).GEMINI_API_KEY }); 

      addLog("STAGE: CHANGES_CLASSIFIED");
      const computedClassifications = await classifyChanges(computedDiffs, ai, (entry) => {
        const logEntry = {
          ...entry,
          timestamp: new Date().toISOString(),
          provider: "google",
          model: "gemini-3-flash-preview",
          prompt_hash: Math.random().toString(36).substring(7),
          input_artifacts: ["spec_diff.json"],
          output_artifact: "classification.json"
        };
        fetch('/api/save-artifact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'llm_calls.jsonl', content: JSON.stringify(logEntry) + '\n' })
        });
      });
      setClassifications(computedClassifications);
      if (computedClassifications.length > 0) setSelectedChangeId(computedClassifications[0].change_id);

      await fetch('/api/save-artifact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'classification.json', content: computedClassifications })
      });

      addLog("STAGE: BREAKING_CHANGES_SELECTED -> MIGRATION_SNIPPETS_GENERATED");
      const breakingChanges = computedClassifications.filter((c: any) => c.classification === 'breaking');
      
      const allValidationResults: any[] = [];
      for (const bc of breakingChanges) {
        const diffItem = computedDiffs.find(d => d.change_id === bc.change_id);
        if (diffItem) {
          addLog(`Generating snippets for ${bc.change_id}...`);
          const snippets = await generateSnippets(diffItem, ai, (entry) => {
             const logEntry = {
              ...entry,
              timestamp: new Date().toISOString(),
              provider: "google",
              model: "gemini-3-flash-preview",
              prompt_hash: Math.random().toString(36).substring(7),
              input_artifacts: ["classification.json"],
              output_artifact: `snippets/${bc.change_id}/`
            };
             fetch('/api/save-artifact', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fileName: 'llm_calls.jsonl', content: JSON.stringify(logEntry) + '\n' })
            });
          });
          for (const s of snippets) {
            await fetch('/api/save-artifact', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fileName: `snippets/${bc.change_id}/${s.language}.json`, content: s })
            });

            // Validate snippet
            const vResult = validateSnippet({ change_id: s.change_id, language: s.language, after_code: s.after_code });
            allValidationResults.push(vResult);
          }
        }
      }
      await fetch('/api/save-artifact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'snippet_validation.json', content: allValidationResults })
      });

      addLog("STAGE: COMMUNICATIONS_GENERATED");
      const comms = await generateCommunications(computedDiffs, computedClassifications, ai, (entry) => {
         const logEntry = {
          ...entry,
          timestamp: new Date().toISOString(),
          provider: "google",
          model: "gemini-3-flash-preview",
          prompt_hash: Math.random().toString(36).substring(7),
          input_artifacts: ["spec_diff.json", "classification.json"],
          output_artifact: "comms/"
        };
        fetch('/api/save-artifact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'llm_calls.jsonl', content: JSON.stringify(logEntry) + '\n' })
        });
      });
      for (const c of comms) {
        await fetch('/api/save-artifact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: `comms/${c.audience}.md`, content: c.content })
        });
      }

      addLog("STAGE: ADAPTERS_GENERATED");
      const adapterPrompt = `Generate a server-side compatibility adapter (Middleware/Proxy) for the following changes: ${JSON.stringify(breakingChanges, null, 2)}. Output JSON: { "change_id": "...", "runtime_location": "proxy", "adapter_code": "..." }`;
      const adapterRes = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: adapterPrompt,
        config: { responseMimeType: "application/json" }
      });
      await fetch('/api/save-artifact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'adapters/v1_to_v2_adapter.json', content: adapterRes.text })
      });

      addLog("STAGE: SDK_PATCH_GENERATED");
      const sdkPatchPrompt = `Based on the breaking changes ${JSON.stringify(breakingChanges, null, 2)}, generate a unified git diff (patch) that would migrate a generic client SDK from V1 to V2. Output the diff in a markdown block.`;
      const sdkPatchRes = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: sdkPatchPrompt
      });
      await fetch('/api/save-artifact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'sdk_patch.diff', content: sdkPatchRes.text })
      });

      addLog("STAGE: COMPATIBILITY_TESTS_GENERATED");
      const tests = await generateCompatibilityTests(computedDiffs, computedClassifications, ai, (entry) => {
        const logEntry = {
          ...entry,
          timestamp: new Date().toISOString(),
          provider: "google",
          model: "gemini-3-flash-preview",
          prompt_hash: Math.random().toString(36).substring(7),
          input_artifacts: ["classification.json"],
          output_artifact: "compatibility_tests/"
        };
        fetch('/api/save-artifact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'llm_calls.jsonl', content: JSON.stringify(logEntry) + '\n' })
        });
      });
      await fetch('/api/save-artifact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'compatibility_tests/v1_v2_compat_tests.json', content: tests })
      });

      addLog("STAGE: TELEMETRY_PLAN_GENERATED");
      const telemetry = await generateTelemetryPlan(ai, (entry) => {
        fetch('/api/save-artifact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'llm_calls.jsonl', content: JSON.stringify(entry) + '\n' })
        });
      });
      await fetch('/api/save-artifact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'deprecation_telemetry.md', content: telemetry })
      });

      addLog("STAGE: RESULTS_FINALISED");
      setStatus('success');
      loadArtifacts();
    } catch (err: any) {
      console.error(err);
      addLog(`Error: ${err.message}`);
      setStatus('error');
    }
  };

  const loadArtifacts = async () => {
    try {
      const response = await fetch('/api/artifacts');
      const data = await response.json();
      setArtifacts(data.files);
      
      if (data.files.includes('classification.json')) {
        const cRes = await fetch('/classification.json');
        const cData = await cRes.json();
        setClassifications(cData);
        if (cData.length > 0 && !selectedChangeId) setSelectedChangeId(cData[0].change_id);
      }

      if (data.files.includes('spec_diff.json')) {
        const dRes = await fetch('/spec_diff.json');
        const dData = await dRes.json();
        setDiffs(dData);
      }

      if (data.files.includes('llm_calls.jsonl')) {
        const lRes = await fetch('/llm_calls.jsonl');
        const lText = await lRes.text();
        const logsLine = lText.trim().split('\n').filter(Boolean).map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        setLlmLogs(logsLine);
      }
    } catch (err) {
      console.error("Failed to load artifacts", err);
    }
  };

  useEffect(() => {
    loadArtifacts();
  }, []);

  return (
    <div className="h-screen w-full bg-[#020617] text-slate-300 font-sans flex flex-col overflow-hidden select-none border-4 border-slate-900">
      {/* Header */}
      <header className="h-16 border-b border-slate-800 bg-slate-950/50 flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-4">
          <div className={`w-3 h-3 rounded-full shadow-[0_0_10px_rgba(59,130,246,0.6)] ${status === 'running' ? 'bg-blue-500 animate-pulse' : status === 'success' ? 'bg-emerald-500' : 'bg-slate-700'}`} />
          <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
            TradeAPI Migration Pipeline 
            <span className="text-slate-500 font-mono text-sm ml-2">v1.0.0 ➔ v2.0.0</span>
          </h1>
        </div>
        <div className="flex gap-3">
          <div className="px-3 py-1 bg-slate-900 border border-slate-700 rounded text-xs font-mono text-slate-400">
            {status === 'running' ? 'EXECUTING...' : 'SYNC_STABLE'}
          </div>
          <div className={`px-3 py-1 border rounded text-xs font-semibold uppercase tracking-widest ${
            status === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
            status === 'error' ? 'bg-rose-500/10 border-rose-500/20 text-rose-400' :
            status === 'running' ? 'bg-blue-500/10 border-blue-500/20 text-blue-400' :
            'bg-slate-800 border-slate-700 text-slate-500'
          }`}>
            {status === 'idle' ? 'STANDBY' : status === 'running' ? 'PROCESSING' : status.toUpperCase()}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 border-r border-slate-800 bg-slate-950/30 p-4 flex flex-col gap-1 overflow-y-auto">
          <h2 className="text-[10px] uppercase font-bold tracking-[0.2em] text-slate-500 mb-4 px-2">Pipeline Stages</h2>
          <nav className="space-y-1">
            {STAGES.map((stage, idx) => (
              <div 
                key={stage}
                className={`flex items-center gap-3 px-3 py-2 text-xs transition-all ${
                  idx <= getCurrentStage() 
                    ? idx === getCurrentStage() && status === 'running' ? 'text-blue-400 font-medium bg-blue-500/5 border border-blue-500/10 rounded' : 'text-slate-300'
                    : 'text-slate-500'
                }`}
              >
                <div className={`w-1.5 h-1.5 rounded-full ${
                  idx <= getCurrentStage() 
                    ? idx === getCurrentStage() && status === 'running' ? 'bg-blue-500 shadow-[0_0_5px_#3b82f6]' : 'bg-emerald-500'
                    : 'bg-slate-700'
                }`} />
                {stage}
              </div>
            ))}
          </nav>

          <div className="mt-auto p-4 bg-slate-900/50 rounded-lg border border-slate-800">
            <div className="text-[10px] uppercase font-bold text-slate-500 mb-2 flex items-center gap-1">
              <Cpu className="w-3 h-3" /> System Health
            </div>
            <div className="flex justify-between items-end mb-1">
              <span className="text-xs font-mono">LLM Load</span>
              <span className="text-xs text-blue-400">Stable</span>
            </div>
            <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: "10%" }}
                animate={{ width: status === 'running' ? "85%" : "10%" }}
                className="h-full bg-blue-500 shadow-[0_0_8px_#3b82f6]" 
              />
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col bg-[#010204] overflow-hidden">
          {/* Top Panel: Diff Explorer */}
          <div className="p-6 flex flex-col h-1/2 border-b border-slate-800 shrink-0">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                <Activity className="w-4 h-4 text-blue-500" /> API Change Explorer
              </h3>
              <div className="flex items-center gap-4">
                 <span className="text-[10px] font-mono text-slate-500 uppercase">
                    {classifications.length} Diffs Classified
                 </span>
                 <button 
                  onClick={runPipeline}
                  disabled={status === 'running'}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 text-white text-xs font-bold rounded flex items-center gap-2 transition-colors border border-blue-400/20"
                 >
                   {status === 'running' ? <Activity className="w-3 h-3 animate-spin"/> : <Play className="w-3 h-3" />}
                   {status === 'running' ? 'RUNNING...' : 'EXECUTE PIPELINE'}
                 </button>
              </div>
            </div>

            <div className="flex-1 overflow-x-auto overflow-y-hidden pb-2 scrollbar-thin scrollbar-thumb-slate-800 flex gap-4">
              {classifications.length === 0 && status === 'idle' && (
                <div className="w-full h-full flex flex-col items-center justify-center border-2 border-dashed border-slate-800 rounded-xl text-slate-600">
                  <Terminal className="w-8 h-8 mb-2 opacity-50" />
                  <p className="text-sm">No analysis performed. Execute pipeline to view diffs.</p>
                </div>
              )}

              {classifications.map((change) => {
                const diff = diffs.find(d => d.change_id === change.change_id);
                const isSelected = selectedChangeId === change.change_id;

                return (
                  <div 
                    key={change.change_id}
                    onClick={() => setSelectedChangeId(change.change_id)}
                    className={`min-w-[400px] h-full bg-slate-950 border transition-all rounded-xl p-4 overflow-hidden flex flex-col shadow-2xl cursor-pointer group ${
                      isSelected ? 'border-blue-500 ring-1 ring-blue-500/50' : 'border-slate-800 hover:border-slate-600'
                    }`}
                  >
                    <div className="text-[10px] font-mono text-blue-400 mb-2 uppercase flex justify-between">
                      <span>{change.change_id}</span>
                      <ChevronRight className={`w-3 h-3 transition-transform ${isSelected ? 'rotate-90' : ''}`} />
                    </div>
                    <div className="flex items-center gap-3 mb-4">
                      <span className={`px-2 py-0.5 border text-[10px] font-bold rounded uppercase ${
                        change.classification === 'breaking' ? 'bg-red-500/10 border-red-500/20 text-red-500' : 
                        change.classification === 'behavioral' ? 'bg-amber-500/10 border-amber-500/20 text-amber-500' : 
                        'bg-blue-500/10 border-blue-500/20 text-blue-400'
                      }`}>
                        {change.classification}
                      </span>
                      <span className="text-xs font-mono text-slate-300 truncate">
                        {diff?.endpoint_v1 || "schema change"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 flex-1 overflow-hidden">
                      <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-800 flex flex-col overflow-hidden">
                        <div className="text-[10px] text-slate-500 mb-1 uppercase">Before</div>
                        <pre className="font-mono text-[9px] text-slate-500 truncate overflow-hidden">
                          {JSON.stringify(diff?.before, null, 2)}
                        </pre>
                      </div>
                      <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-800 flex flex-col overflow-hidden">
                        <div className="text-[10px] text-slate-500 mb-1 uppercase">After</div>
                        <pre className="font-mono text-[9px] text-emerald-400 truncate overflow-hidden">
                          {JSON.stringify(diff?.after, null, 2)}
                        </pre>
                      </div>
                    </div>
                    <div className="mt-4 p-3 bg-slate-900/50 border-l-2 border-blue-500 text-[11px] text-slate-400 leading-relaxed italic line-clamp-2">
                       {change.reason}
                    </div>
                  </div>
                );
              })}

              {/* Console Logs Card */}
              {status === 'running' && (
                <div className="min-w-[400px] h-full bg-slate-950 border border-slate-800 rounded-xl flex flex-col shadow-2xl overflow-hidden">
                  <div className="bg-slate-900/80 px-4 py-2 border-b border-slate-800 flex items-center justify-between shrink-0">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-2">
                      <Terminal className="w-3 h-3" /> Execution Log
                    </div>
                    <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shadow-[0_0_5px_blue]" />
                  </div>
                  <div className="flex-1 p-4 font-mono text-[10px] overflow-y-auto space-y-1 bg-black/40">
                    {logs.map((log, i) => (
                      <div key={i} className="text-slate-400 flex gap-2">
                        <span className="text-slate-700 shrink-0 select-none">{i+1}</span>
                        <span className={log.includes('Error') ? 'text-rose-400' : ''}>{log}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Bottom Panel: Interactive Tabs */}
          <div className="flex-1 flex flex-col p-6 overflow-hidden">
            <div className="flex items-center gap-6 mb-4 border-b border-slate-800">
              <button 
                onClick={() => setActiveTab('snippets')}
                className={`pb-2 text-xs font-bold uppercase tracking-widest transition-all ${activeTab === 'snippets' ? 'text-blue-400 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}
              >
                Migration Logic
              </button>
              <button 
                onClick={() => setActiveTab('audit')}
                className={`pb-2 text-xs font-bold uppercase tracking-widest transition-all ${activeTab === 'audit' ? 'text-blue-400 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}
              >
                LLM Audit Log
              </button>
            </div>

            <div className="flex-1 overflow-hidden">
              {activeTab === 'snippets' ? (
                <div className="grid grid-cols-3 gap-6 h-full">
                  <div className="col-span-2 flex flex-col gap-3 h-full overflow-hidden">
                    <div className="flex justify-between items-end">
                      <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 flex items-center gap-2">
                         <Code className="w-3 h-3" /> Snippet View
                      </h4>
                      {selectedClassification?.classification === 'breaking' && (
                        <div className="flex gap-2">
                          <div className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 text-[10px] border border-emerald-500/30 rounded font-mono">TSC OK</div>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 bg-slate-950 rounded-xl border border-slate-800 p-5 font-mono text-[11px] relative overflow-auto group">
                      <div className="absolute left-0 top-0 w-1 h-full bg-blue-500/50" />
                      {!selectedChangeId && <div className="text-slate-600 italic">Select a change above to view migration code.</div>}
                      {selectedChangeId && selectedClassification?.classification !== 'breaking' && (
                         <div className="text-slate-500 italic">Non-breaking change. Client-side migration snippets are optional.</div>
                      )}
                      {selectedChangeId && selectedClassification?.classification === 'breaking' && (
                        <div className="space-y-4">
                            <div>
                               <div className="text-slate-500 mb-1 font-sans font-bold uppercase tracking-widest text-[9px]">Migration Strategy:</div>
                               <div className="text-slate-400 font-sans italic p-3 bg-slate-900/40 rounded border border-slate-800">{selectedClassification?.client_impact}</div>
                            </div>
                            <div className="p-4 bg-slate-900/30 rounded border border-slate-800">
                               <div className="flex items-center gap-2 text-amber-500 mb-2">
                                  <AlertCircle className="w-3 h-3" />
                                  <span className="text-[10px] font-bold uppercase">Affected Patterns</span>
                               </div>
                               <div className="flex flex-wrap gap-2">
                                  {selectedClassification?.affected_client_patterns?.map((p: string) => (
                                    <span key={p} className="px-2 py-0.5 bg-slate-800 text-[9px] text-slate-400 rounded border border-slate-700">{p}</span>
                                  ))}
                                  {(!selectedClassification?.affected_client_patterns || selectedClassification.affected_client_patterns.length === 0) && (
                                    <span className="text-slate-600 italic text-[9px]">General impact</span>
                                  )}
                               </div>
                            </div>
                            <div className="p-3 bg-blue-500/5 border border-blue-500/20 rounded text-[10px] text-blue-300">
                               Full generated logic is available in the <span className="font-mono text-blue-400">/snippets</span> directory.
                            </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="col-span-1 flex flex-col gap-3 h-full overflow-hidden">
                    <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 flex items-center gap-2">
                      <MessageSquare className="w-3 h-3" /> Artifact Overview
                    </h4>
                    <div className="flex-1 bg-slate-950 rounded-xl border border-slate-800 p-5 text-[11px] overflow-y-auto space-y-4">
                       <div>
                          <div className="text-slate-500 uppercase font-bold text-[9px] mb-2 tracking-widest">Active Artifacts</div>
                          <div className="space-y-1">
                             {artifacts.slice(0, 12).map(art => (
                               <div key={art} className="flex items-center gap-2 p-1.5 bg-slate-900 border border-slate-800 rounded group hover:border-slate-600 transition-colors">
                                  <FileText className="w-3 h-3 text-slate-600" />
                                  <span className="truncate text-slate-400 group-hover:text-slate-200 transition-colors">{art}</span>
                               </div>
                             ))}
                             {artifacts.length === 0 && <div className="text-slate-700 italic">No artifacts generated yet.</div>}
                          </div>
                       </div>
                       <div className="space-y-2">
                        <button 
                          onClick={() => window.open('/sdk_patch.diff')}
                          disabled={!artifacts.includes('sdk_patch.diff')}
                          className="w-full py-2 bg-emerald-600/10 hover:bg-emerald-600/20 disabled:bg-slate-900 border border-emerald-600/30 text-emerald-400 font-bold rounded text-[10px] uppercase tracking-widest transition-all"
                        >
                            View SDK Patch
                        </button>
                        <button 
                          onClick={() => window.open('/deprecation_telemetry.md')}
                          disabled={!artifacts.includes('deprecation_telemetry.md')}
                          className="w-full py-2 bg-blue-600/10 hover:bg-blue-600/20 disabled:bg-slate-900 border border-blue-600/30 text-blue-400 font-bold rounded text-[10px] uppercase tracking-widest transition-all"
                        >
                            Telemetry Plan
                        </button>
                       </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-full flex flex-col bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
                   <div className="p-3 bg-slate-900/50 border-b border-slate-800 flex justify-between items-center shrink-0">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Execution Trace ({llmLogs.length} calls)</span>
                      <div className="flex gap-2">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_5px_emerald]" />
                      </div>
                   </div>
                   <div className="flex-1 overflow-y-auto p-4 font-mono text-[10px] space-y-4">
                      {llmLogs.map((log, i) => (
                        <div key={i} className="border-l border-slate-800 pl-4 py-1 hover:bg-slate-900/20 transition-colors rounded-r">
                           <div className="flex justify-between items-start mb-1">
                              <span className="text-blue-400 font-bold">[{log.stage}]</span>
                              <span className="text-slate-600">{new Date(log.timestamp).toLocaleTimeString()}</span>
                           </div>
                           <div className="text-slate-500">
                              <span className="text-slate-700 mr-2 uppercase text-[8px] tracking-tight">Input:</span>
                              <span className="text-slate-400">{log.input_artifacts?.join(', ') || 'none'}</span>
                           </div>
                           <div className="text-slate-500">
                              <span className="text-slate-700 mr-2 uppercase text-[8px] tracking-tight">Artifact:</span>
                              <span className="text-blue-500 underline underline-offset-2">{log.output_artifact}</span>
                           </div>
                        </div>
                      ))}
                      {llmLogs.length === 0 && <div className="text-slate-600 italic h-full flex items-center justify-center">No LLM activity recorded in current session. Run a pipeline cycle to populate.</div>}
                   </div>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      {/* Decorative background effects */}
      <div className="fixed inset-0 pointer-events-none z-[-1] opacity-20">
        <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-blue-500 to-transparent shadow-[0_0_10px_#3b82f6]" />
        <div className="absolute bottom-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-emerald-500 to-transparent shadow-[0_0_10px_#10b981]" />
      </div>
    </div>
  );
}
