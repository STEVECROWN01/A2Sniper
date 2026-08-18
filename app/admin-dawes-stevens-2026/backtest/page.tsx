'use client';

import { useState } from 'react';
import { getApiUrl } from '@/lib/api-config';
import { useAuth } from '@/hooks/use-auth';
import { Loader2, Play, TrendingUp, TrendingDown, AlertTriangle, CheckCircle2, BarChart3 } from 'lucide-react';
import { toast } from 'sonner';

interface BacktestSummary {
  pair: string;
  payout: number;
  total_signals: number;
  resolved: number;
  wins: number;
  losses: number;
  ties: number;
  actual_winrate: number;
  avg_claimed_winrate: number;
  claim_vs_actual_gap: number;
  break_even_winrate: number;
  profitable: boolean;
  pnl_simulation_pct: number;
  call_signals: number;
  call_winrate: number;
  put_signals: number;
  put_winrate: number;
  score_breakdown: Record<number, { count: number; wins: number; winrate: number }>;
  verdict: string;
  message?: string; // Only present when total_signals === 0
}

interface BacktestResponse {
  status: string;
  data_source: string;
  candles_analyzed: number;
  summary: BacktestSummary;
}

export default function AdminBacktestPage() {
  useAuth(true);
  const [pair, setPair] = useState('EURUSD_otc');
  const [engine, setEngine] = useState<'ace' | 'sniper'>('ace');
  const [strictMode, setStrictMode] = useState(false);
  const [payout, setPayout] = useState(80);
  const [step, setStep] = useState(1);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<BacktestResponse | null>(null);

  const runBacktest = async () => {
    setIsRunning(true);
    setResult(null);
    try {
      const url = getApiUrl();
      const res = await fetch(`${url}/api/admin/backtest/run`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pair, engine, strict_mode: strictMode, payout, step }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult(data);
        toast.success(`Backtest complete: ${data.summary.total_signals} signals analyzed`);
      } else {
        toast.error(data.detail || 'Backtest failed');
      }
    } catch {
      toast.error('Network error while running backtest');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold uppercase tracking-tighter flex items-center gap-2">
          <BarChart3 className="w-6 h-6 text-[#D4AF37]" />
          Backtest Engine
        </h1>
        <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">
          Measure the ACTUAL win rate vs the engines' claimed numbers
        </p>
      </div>

      {/* Config Card */}
      <div className="bg-gray-900/40 border border-gray-800 rounded-2xl p-6">
        <h2 className="text-lg font-bold text-white mb-4">Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Pair */}
          <div>
            <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mb-2">Pair</label>
            <input
              type="text"
              value={pair}
              onChange={(e) => setPair(e.target.value)}
              placeholder="EURUSD_otc"
              className="w-full bg-black border border-gray-800 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-[#D4AF37] transition-colors"
            />
          </div>

          {/* Engine */}
          <div>
            <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mb-2">Engine</label>
            <select
              value={engine}
              onChange={(e) => setEngine(e.target.value as 'ace' | 'sniper')}
              className="w-full bg-black border border-gray-800 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-[#D4AF37] transition-colors"
            >
              <option value="ace">ACE Engine (regime-adaptive)</option>
              <option value="sniper">Sniper Engine (price-action)</option>
            </select>
          </div>

          {/* Payout */}
          <div>
            <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mb-2">Payout %</label>
            <input
              type="number"
              value={payout}
              onChange={(e) => setPayout(Number(e.target.value))}
              min={50}
              max={100}
              className="w-full bg-black border border-gray-800 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-[#D4AF37] transition-colors"
            />
          </div>

          {/* Step */}
          <div>
            <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mb-2">Step (1=every candle, 5=faster)</label>
            <input
              type="number"
              value={step}
              onChange={(e) => setStep(Number(e.target.value))}
              min={1}
              max={100}
              className="w-full bg-black border border-gray-800 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-[#D4AF37] transition-colors"
            />
          </div>

          {/* Strict mode (sniper only) */}
          <div className={engine === 'sniper' ? '' : 'opacity-30 pointer-events-none'}>
            <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mb-2">Strict Mode (Sniper only)</label>
            <button
              onClick={() => setStrictMode(!strictMode)}
              disabled={engine !== 'sniper'}
              className={`w-full py-3 rounded-xl font-bold text-sm transition-colors ${
                strictMode
                  ? 'bg-[#D4AF37] text-black'
                  : 'bg-black border border-gray-800 text-gray-400'
              }`}
            >
              {strictMode ? 'Option D (Strict)' : 'Option C (Default)'}
            </button>
          </div>
        </div>

        <button
          onClick={runBacktest}
          disabled={isRunning}
          className="w-full mt-6 bg-red-600 hover:bg-red-700 disabled:bg-gray-800 text-white py-4 rounded-xl font-black uppercase tracking-widest text-sm flex items-center justify-center gap-2 transition-colors"
        >
          {isRunning ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
          {isRunning ? 'RUNNING BACKTEST...' : 'RUN BACKTEST'}
        </button>
      </div>

      {/* Results */}
      {result && (
        <BacktestResults result={result} />
      )}
    </div>
  );
}

function BacktestResults({ result }: { result: BacktestResponse }) {
  const s = result.summary;

  if (s.total_signals === 0) {
    return (
      <div className="bg-gray-900/40 border border-gray-800 rounded-2xl p-8 text-center">
        <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
        <h3 className="text-lg font-bold text-white mb-2">No signals generated</h3>
        <p className="text-sm text-gray-500">{s.message || 'The engines found no qualifying setups in the available data.'}</p>
        <p className="text-xs text-gray-600 mt-4">
          Data source: {result.data_source} ({result.candles_analyzed} candles analyzed)
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Verdict */}
      <div className={`rounded-2xl p-6 border ${
        s.profitable
          ? 'bg-green-500/5 border-green-500/20'
          : 'bg-red-500/5 border-red-500/20'
      }`}>
        <div className="flex items-start gap-4">
          {s.profitable ? (
            <CheckCircle2 className="w-8 h-8 text-green-500 flex-shrink-0 mt-1" />
          ) : (
            <AlertTriangle className="w-8 h-8 text-red-500 flex-shrink-0 mt-1" />
          )}
          <div>
            <h2 className="text-xl font-bold text-white mb-1">
              {s.profitable ? 'PROFITABLE' : 'NOT PROFITABLE'}
            </h2>
            <p className="text-sm text-gray-400">{s.verdict}</p>
          </div>
        </div>
      </div>

      {/* Key Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Actual Win Rate"
          value={`${s.actual_winrate}%`}
          sublabel={`Break-even: ${s.break_even_winrate}%`}
          color={s.profitable ? 'green' : 'red'}
          icon={s.profitable ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
        />
        <StatCard
          label="Claimed Win Rate"
          value={`${s.avg_claimed_winrate}%`}
          sublabel={`Gap: ${s.claim_vs_actual_gap > 0 ? '+' : ''}${s.claim_vs_actual_gap}pp`}
          color="yellow"
          icon={<AlertTriangle className="w-5 h-5" />}
        />
        <StatCard
          label="Total Signals"
          value={String(s.total_signals)}
          sublabel={`${s.resolved} resolved, ${s.ties} ties`}
          color="blue"
        />
        <StatCard
          label="P&L Simulation"
          value={`${s.pnl_simulation_pct > 0 ? '+' : ''}${s.pnl_simulation_pct}%`}
          sublabel="1% stake per trade"
          color={s.pnl_simulation_pct > 0 ? 'green' : 'red'}
        />
      </div>

      {/* Direction Breakdown */}
      <div className="bg-gray-900/40 border border-gray-800 rounded-2xl p-6">
        <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-4">Direction Breakdown</h3>
        <div className="grid grid-cols-2 gap-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-green-400" />
            </div>
            <div>
              <p className="text-sm font-bold text-white">CALL signals</p>
              <p className="text-xs text-gray-500">{s.call_signals} signals · {s.call_winrate}% win rate</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
              <TrendingDown className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <p className="text-sm font-bold text-white">PUT signals</p>
              <p className="text-xs text-gray-500">{s.put_signals} signals · {s.put_winrate}% win rate</p>
            </div>
          </div>
        </div>
      </div>

      {/* Score Breakdown */}
      {Object.keys(s.score_breakdown).length > 0 && (
        <div className="bg-gray-900/40 border border-gray-800 rounded-2xl p-6">
          <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-4">Score Breakdown (higher = more confluence factors)</h3>
          <div className="space-y-3">
            {Object.entries(s.score_breakdown).map(([score, stats]) => (
              <div key={score} className="flex items-center gap-4">
                <div className="w-12 text-sm font-bold text-gray-400">Score {score}</div>
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${stats.winrate >= s.break_even_winrate ? 'bg-green-500' : 'bg-red-500'}`}
                        style={{ width: `${stats.winrate}%` }}
                      />
                    </div>
                    <span className="text-sm font-bold text-white w-12 text-right">{stats.winrate}%</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{stats.count} signals ({stats.wins} wins, {stats.count - stats.wins} losses)</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Data Source */}
      <div className="text-xs text-gray-600 text-center">
        Data source: {result.data_source} · {result.candles_analyzed} candles analyzed · {s.wins}W / {s.losses}L / {s.ties}T
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sublabel,
  color,
  icon,
}: {
  label: string;
  value: string;
  sublabel: string;
  color: 'green' | 'red' | 'yellow' | 'blue';
  icon?: React.ReactNode;
}) {
  const colorMap = {
    green: 'text-green-400 border-green-500/20 bg-green-500/5',
    red: 'text-red-400 border-red-500/20 bg-red-500/5',
    yellow: 'text-yellow-400 border-yellow-500/20 bg-yellow-500/5',
    blue: 'text-blue-400 border-blue-500/20 bg-blue-500/5',
  };
  return (
    <div className={`rounded-xl border p-4 ${colorMap[color]}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">{label}</span>
        {icon}
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="text-[10px] text-gray-500 mt-1">{sublabel}</p>
    </div>
  );
}
