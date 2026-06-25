'use client';

import { useState, useEffect } from 'react';

export default function DebugPayoutsPage() {
  const [query, setQuery] = useState('GBPJPY');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live payout monitor state
  const [liveData, setLiveData] = useState<any>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Batch verification state
  const [batchInput, setBatchInput] = useState(`USD/PKR OTC=92
USD/RUB OTC=92
AUD/JPY OTC=90
EUR/TRY OTC=90
NGN/USD OTC=90
TND/USD OTC=90
KES/USD OTC=89
EUR/GBP OTC=88
GBP/CAD OTC=87
YER/USD OTC=87
GBP/JPY OTC=84
USD/CHF OTC=84`);
  const [batchResult, setBatchResult] = useState<any>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);

  const runSearch = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/market/debug/search?q=${encodeURIComponent(query)}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }
      const data = await res.json();
      setResult(data);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const runBatchVerify = async () => {
    setBatchLoading(true);
    setBatchError(null);
    setBatchResult(null);
    try {
      // Convert newlines to commas, URL-encode
      const pairsParam = batchInput
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join(',');
      const res = await fetch(
        `/api/market/debug/verify-payouts?pairs=${encodeURIComponent(pairsParam)}`,
        { credentials: 'include' }
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }
      const data = await res.json();
      setBatchResult(data);
    } catch (e: any) {
      setBatchError(e.message || String(e));
    } finally {
      setBatchLoading(false);
    }
  };

  // Live payout monitor — fetches current payouts + event stats every 3s
  const fetchLiveData = async () => {
    try {
      const res = await fetch('/api/market/debug/payout-changes', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setLiveData(data);
      }
    } catch (e) {
      // silent fail — don't spam console
    }
  };

  // Auto-refresh live data every 1s when enabled (real-time updates)
  useEffect(() => {
    if (!autoRefresh) return;
    fetchLiveData();
    const interval = setInterval(fetchLiveData, 1000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-white p-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-black mb-2">🔍 Payout Diagnostic Tool</h1>
        <p className="text-gray-400 mb-6 text-sm">
          Verify that payouts shown in our bot match what PocketOption&apos;s UI displays.
        </p>

        {/* LIVE PAYOUT MONITOR */}
        <div className="mb-8 bg-gradient-to-br from-green-500/10 to-transparent border border-green-500/20 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-black uppercase tracking-wider text-green-400 flex items-center gap-2">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
              Live Payout Monitor (real-time, 1s refresh)
            </h2>
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="w-4 h-4"
              />
              Auto-refresh
            </label>
          </div>

          {liveData ? (
            <div className="space-y-4">
              {/* Freshness */}
              {liveData.freshness && (
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div className="bg-black/40 rounded-lg p-2">
                    <span className="text-gray-500">Last update:</span>{' '}
                    <span className={`font-black ${liveData.freshness.last_assets_update_age_seconds < 5 ? 'text-green-400' : 'text-yellow-400'}`}>
                      {liveData.freshness.last_assets_update_age_seconds !== null
                        ? `${liveData.freshness.last_assets_update_age_seconds}s ago`
                        : 'never'}
                    </span>
                  </div>
                  <div className="bg-black/40 rounded-lg p-2">
                    <span className="text-gray-500">Snapshots:</span>{' '}
                    <span className="font-bold">{liveData.freshness.assets_received_count || 0}</span>
                  </div>
                  <div className="bg-black/40 rounded-lg p-2">
                    <span className="text-gray-500">Payout events:</span>{' '}
                    <span className={`font-black ${liveData.event_statistics.bare_payout_frames_received > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {liveData.event_statistics.bare_payout_frames_received || 0} bare frames
                    </span>
                  </div>
                </div>
              )}

              {/* Current major payouts */}
              <div>
                <p className="text-[10px] text-gray-500 uppercase font-bold mb-2">Current Payouts (live):</p>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {liveData.current_major_payouts &&
                    Object.entries(liveData.current_major_payouts).map(([pair, payout]: [string, any]) => (
                      <div key={pair} className="bg-black/40 rounded-lg p-2 border border-white/5">
                        <p className="text-[9px] text-gray-500 font-mono truncate">{pair}</p>
                        <p className={`text-lg font-black ${payout >= 90 ? 'text-green-400' : payout >= 80 ? 'text-yellow-300' : 'text-orange-400'}`}>
                          +{payout}%
                        </p>
                      </div>
                    ))}
                </div>
                <p className="text-[9px] text-gray-600 mt-2">
                  💡 Compare these with PO&apos;s UI right now. They should match within 2-3 seconds.
                  If they don&apos;t match, check the event statistics below.
                </p>
              </div>

              {/* Event statistics */}
              <div>
                <p className="text-[10px] text-gray-500 uppercase font-bold mb-2">PO Events Received:</p>
                <div className="flex flex-wrap gap-1.5">
                  {liveData.event_statistics.event_counts &&
                    Object.entries(liveData.event_statistics.event_counts).map(([event, count]: [string, any]) => (
                      <span
                        key={event}
                        className={`text-[10px] font-mono px-2 py-1 rounded border ${
                          event.toLowerCase().includes('payout') || event.toLowerCase().includes('asset')
                            ? 'bg-green-500/10 border-green-500/30 text-green-400'
                            : 'bg-white/5 border-white/10 text-gray-400'
                        }`}
                      >
                        {event}: {count}
                      </span>
                    ))}
                </div>
                {liveData.event_statistics.bare_payout_frames_received === 0 && (
                  <p className="text-[10px] text-yellow-400 mt-2">
                    ⚠️ No bare payout frames received yet. PO pushes these every 30-60s —
                    wait a minute and check again. If still 0 after 2 min, the bare frame
                    parser may need adjustment.
                  </p>
                )}
                {liveData.event_statistics.bare_payout_frames_received > 0 && (
                  <p className="text-[10px] text-green-400 mt-2">
                    ✅ Real-time payout parser is working! {liveData.event_statistics.bare_payout_frames_received} bare frames received.
                    Payouts should now update automatically as PO pushes them.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className="text-gray-500 text-sm">Loading live data...</p>
          )}
        </div>

        {/* BATCH VERIFY SECTION */}
        <div className="mb-8">
          <h2 className="text-sm font-black uppercase tracking-wider mb-2 text-white">
            Batch Verify (Recommended) — Paste PO payouts to verify
          </h2>
          <p className="text-gray-500 text-xs mb-3">
            Format: <code className="bg-black/40 px-1 rounded">PAIR_NAME=PAYOUT</code> (without the % sign).
            Pre-filled with the pairs from your PO screenshot.
          </p>
          <textarea
            value={batchInput}
            onChange={(e) => setBatchInput(e.target.value)}
            rows={12}
            className="w-full bg-black/60 border border-white/10 rounded-xl px-4 py-3 text-sm font-mono mb-3"
            placeholder="USD/PKR OTC=92&#10;USD/RUB OTC=92&#10;..."
          />
          <button
            onClick={runBatchVerify}
            disabled={batchLoading || !batchInput}
            className="bg-[#D4AF37] text-black px-6 py-2 rounded-xl text-sm font-black uppercase tracking-wider hover:opacity-90 disabled:opacity-50"
          >
            {batchLoading ? 'Verifying...' : 'Verify All Payouts'}
          </button>

          {batchError && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mt-4">
              <p className="text-red-400 text-sm font-bold">Error: {batchError}</p>
            </div>
          )}

          {batchResult && (
            <div className="mt-6 space-y-4">
              {/* Summary */}
              <div className="bg-black/60 border border-white/10 rounded-xl p-4">
                <h3 className="text-sm font-black uppercase tracking-wider mb-3 text-[#D4AF37]">Summary</h3>
                <div className="grid grid-cols-4 gap-3 text-center">
                  <div className="bg-white/5 rounded-lg p-3">
                    <p className="text-2xl font-black text-white">{batchResult.summary.total_checked}</p>
                    <p className="text-[10px] text-gray-500 uppercase">Total</p>
                  </div>
                  <div className="bg-green-500/10 rounded-lg p-3">
                    <p className="text-2xl font-black text-green-400">{batchResult.summary.matched}</p>
                    <p className="text-[10px] text-green-500 uppercase">Matched</p>
                  </div>
                  <div className="bg-red-500/10 rounded-lg p-3">
                    <p className="text-2xl font-black text-red-400">{batchResult.summary.mismatched}</p>
                    <p className="text-[10px] text-red-500 uppercase">Mismatched</p>
                  </div>
                  <div className="bg-yellow-500/10 rounded-lg p-3">
                    <p className="text-2xl font-black text-yellow-400">{batchResult.summary.not_found}</p>
                    <p className="text-[10px] text-yellow-500 uppercase">Not Found</p>
                  </div>
                </div>
                {batchResult.freshness && (
                  <p className="text-[10px] text-gray-500 mt-3">
                    Data freshness: {batchResult.freshness.last_assets_update_age_seconds}s ago
                    {batchResult.freshness.last_assets_update_age_seconds > 10 && ' ⚠️ STALE'}
                  </p>
                )}
              </div>

              {/* Results table */}
              <div className="bg-black/60 border border-white/10 rounded-xl overflow-hidden overflow-x-auto">
                <table className="w-full text-xs min-w-[700px]">
                  <thead className="bg-white/5">
                    <tr>
                      <th className="text-left p-3 font-black uppercase text-gray-400">Pair</th>
                      <th className="text-center p-3 font-black uppercase text-gray-400">PO UI</th>
                      <th className="text-center p-3 font-black uppercase text-gray-400">Our System</th>
                      <th className="text-center p-3 font-black uppercase text-gray-400">Status</th>
                      <th className="text-left p-3 font-black uppercase text-gray-400">Raw Symbols (PO sent)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchResult.results.map((r: any, i: number) => (
                      <tr key={i} className="border-t border-white/5">
                        <td className="p-3 font-mono font-bold">{r.display_name}</td>
                        <td className="p-3 text-center font-black">{r.po_ui_payout}%</td>
                        <td className="p-3 text-center font-black">
                          {r.our_payout !== null ? `${r.our_payout}%` : '—'}
                        </td>
                        <td className="p-3 text-center">
                          <span
                            className={`px-2 py-1 rounded text-[10px] font-black uppercase ${
                              r.status === 'MATCH'
                                ? 'bg-green-500/20 text-green-400'
                                : r.status === 'MISMATCH'
                                  ? 'bg-red-500/20 text-red-400'
                                  : 'bg-yellow-500/20 text-yellow-400'
                            }`}
                          >
                            {r.status === 'MATCH' ? '✓ Match' : r.status === 'MISMATCH' ? '✗ Mismatch' : '? Not Found'}
                          </span>
                        </td>
                        <td className="p-3 text-[10px] font-mono text-gray-400">
                          {r.all_raw_symbols && r.all_raw_symbols.length > 0 ? (
                            r.all_raw_symbols.map((s: any, j: number) => (
                              <div key={j}>
                                {s.symbol} = {s.payout}% {s.is_active ? '✓' : '✗'}
                                {s.po_display_name && <span className="text-gray-600"> ({s.po_display_name})</span>}
                              </div>
                            ))
                          ) : (
                            <span className="text-gray-600">No matching symbols</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* SINGLE SEARCH SECTION */}
        <div className="border-t border-white/10 pt-6">
          <h2 className="text-sm font-black uppercase tracking-wider mb-2 text-white">Single Pair Search</h2>
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. GBPJPY, EURUSD, AUDNZD"
              className="flex-1 bg-black/60 border border-white/10 rounded-xl px-4 py-2 text-sm font-mono"
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            />
            <button
              onClick={runSearch}
              disabled={loading || !query}
              className="bg-white/10 text-white px-6 py-2 rounded-xl text-sm font-black uppercase tracking-wider hover:bg-white/20 disabled:opacity-50"
            >
              {loading ? 'Searching...' : 'Search'}
            </button>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-4">
              <p className="text-red-400 text-sm font-bold">Error: {error}</p>
            </div>
          )}

          {result && (
            <div className="space-y-4">
              <div className="bg-black/60 border border-white/10 rounded-xl p-4">
                <h3 className="text-sm font-black uppercase tracking-wider mb-3 text-[#D4AF37]">Summary</h3>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="text-gray-500">Query:</span>{' '}
                    <span className="font-mono font-bold">{result.query}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Total matches:</span>{' '}
                    <span className="font-bold">{result.total_matches}</span>
                  </div>
                </div>
              </div>

              <div className="bg-black/60 border border-white/10 rounded-xl p-4">
                <h3 className="text-sm font-black uppercase tracking-wider mb-3 text-[#D4AF37]">
                  All Matching Symbols (sorted by payout, highest first)
                </h3>
                {result.all_matching_symbols && result.all_matching_symbols.length > 0 ? (
                  <div className="space-y-2">
                    {result.all_matching_symbols.map((s: any, i: number) => (
                      <div
                        key={i}
                        className={`p-3 rounded-lg border ${
                          s.is_active
                            ? 'bg-green-500/5 border-green-500/20'
                            : 'bg-red-500/5 border-red-500/20'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-mono font-bold text-sm">{s.symbol}</span>
                          <span
                            className={`font-black text-lg ${
                              s.payout >= 90
                                ? 'text-green-400'
                                : s.payout >= 80
                                  ? 'text-yellow-300'
                                  : 'text-orange-400'
                            }`}
                          >
                            +{s.payout}%
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[10px] text-gray-400">
                          <div>
                            <span className="text-gray-500">Display:</span>{' '}
                            <span className="font-mono">{s.display_name}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">PO&apos;s label:</span>{' '}
                            <span className="font-mono">{s.po_display_name || 'N/A'}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-gray-500 text-sm">No symbols found</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
