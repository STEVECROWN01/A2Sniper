'use client';

import { useState } from 'react';
import { useAppStore } from '@/lib/store';

export default function DebugPayoutsPage() {
  const [query, setQuery] = useState('GBPJPY');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const getApiUrl = useAppStore((s) => s.getApiUrl);

  const runSearch = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const url = getApiUrl();
      // Use the Next.js API proxy (same-origin) so httpOnly cookies are sent
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

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-white p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-black mb-2">🔍 Payout Diagnostic Tool</h1>
        <p className="text-gray-400 mb-6 text-sm">
          Search ALL raw symbols PO sent us by substring. This shows exactly what
          PO is sending via WebSocket for each pair, so we can diagnose payout
          mismatches between our bot and PO&apos;s UI.
        </p>

        <div className="flex gap-2 mb-6">
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
            className="bg-[#D4AF37] text-black px-6 py-2 rounded-xl text-sm font-black uppercase tracking-wider hover:from-[#c5a059] hover:to-[#D4AF37] disabled:opacity-50"
          >
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6">
            <p className="text-red-400 text-sm font-bold">Error: {error}</p>
            <p className="text-gray-500 text-xs mt-2">
              Make sure you&apos;re logged in and your SSID is connected.
            </p>
          </div>
        )}

        {result && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="bg-black/60 border border-white/10 rounded-xl p-4">
              <h2 className="text-sm font-black uppercase tracking-wider mb-3 text-[#D4AF37]">Summary</h2>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-gray-500">Query:</span>{' '}
                  <span className="font-mono font-bold">{result.query}</span>
                </div>
                <div>
                  <span className="text-gray-500">Total matches:</span>{' '}
                  <span className="font-bold">{result.total_matches}</span>
                </div>
                <div>
                  <span className="text-gray-500">Our get_payout() returns:</span>{' '}
                  <span className="font-black text-green-400">
                    {result.our_get_payout_returns !== null
                      ? `${result.our_get_payout_returns}%`
                      : 'null'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">For display name:</span>{' '}
                  <span className="font-mono">{result.for_display_name || 'N/A'}</span>
                </div>
                {result.freshness && (
                  <div className="col-span-2">
                    <span className="text-gray-500">Data freshness:</span>{' '}
                    <span className="font-mono">
                      {result.freshness.last_assets_update_age_seconds !== null
                        ? `${result.freshness.last_assets_update_age_seconds}s ago`
                        : 'never'}
                      {' '}(should be &lt;10s)
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* All matching symbols */}
            <div className="bg-black/60 border border-white/10 rounded-xl p-4">
              <h2 className="text-sm font-black uppercase tracking-wider mb-3 text-[#D4AF37]">
                All Matching Symbols (sorted by payout, highest first)
              </h2>
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
                        <div>
                          <span className="text-gray-500">Active:</span>{' '}
                          <span className={s.is_active ? 'text-green-400' : 'text-red-400'}>
                            {s.is_active ? 'YES' : 'NO (greyed out on PO)'}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">Updated:</span>{' '}
                          <span className="font-mono">{s.updated_at || 'N/A'}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-sm">No symbols found matching &quot;{result.query}&quot;</p>
              )}
            </div>

            {/* Diagnostic note */}
            <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4">
              <h3 className="text-xs font-black uppercase tracking-wider mb-2 text-blue-400">
                How to interpret
              </h3>
              <p className="text-xs text-gray-400 leading-relaxed">{result.diagnostic_note}</p>
            </div>
          </div>
        )}

        {!result && !error && !loading && (
          <div className="bg-black/40 border border-white/5 rounded-xl p-8 text-center">
            <p className="text-gray-500 text-sm">
              Enter a pair symbol above (e.g., GBPJPY) and click Search to see what PO is sending us.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
