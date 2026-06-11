'use client';

import { useState, useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import { motion } from 'framer-motion';
import { 
  Zap, 
  TrendingUp, 
  Users, 
  Target, 
  BarChart3, 
  ShieldAlert,
  Power,
  ChevronRight,
  Brain
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer
} from 'recharts';

interface WinRateData {
  win_rate: number;
  total: number;
  wins: number;
  losses: number;
}

interface PerfData {
  win_rate_24h: WinRateData;
  win_rate_7d: WinRateData;
  win_rate_30d: WinRateData;
  win_rate_all: WinRateData;
  circuit_breaker: Record<string, unknown>;
  total_signals: number;
  signals_today: number;
  mrr?: number;
  mrr_growth?: number;
}

interface StatusData {
  status: string;
  total_users: number;
  retention?: number;
  circuit_breaker: Record<string, unknown>;
  risk: Record<string, unknown>;
  pairs: string[];
  total_signals: number;
}

export default function AdminDashboard() {
  useAuth(true);
  const { signals, fetchSignals } = useAppStore();
  const [weights, setWeights] = useState({ LSTM: 40, Transformer: 35, XGBoost: 25, threshold: 95 });
  const [isSuspended, setIsSuspended] = useState(false);
  const [perfData, setPerfData] = useState<PerfData | null>(null);

  const aiVotes = [
    { name: 'LSTM', value: 'N/A', weight: `${weights.LSTM}%`, status: 'Operational' },
    { name: 'Transformer', value: 'N/A', weight: `${weights.Transformer}%`, status: 'Operational' },
    { name: 'XGBoost', value: 'N/A', weight: `${weights.XGBoost}%`, status: 'Operational' },
  ];
  const [statusData, setStatusData] = useState<StatusData | null>(null);

  // Build revenue chart data from actual signal data (daily signal volume as proxy)
  const revenueChartData = (() => {
    if (signals.length === 0) return [];
    const dailyMap: Record<string, { name: string; value: number }> = {};
    signals.forEach(s => {
      const dateStr = new Date(s.timestamp).toISOString().split('T')[0];
      const label = dateStr.slice(5); // MM-DD
      if (!dailyMap[dateStr]) dailyMap[dateStr] = { name: label, value: 0 };
      // Revenue proxy: each signal contributes estimated revenue based on outcome
      if (s.is_win === true) dailyMap[dateStr].value += (s.payout || 80);
      else if (s.is_win === false) dailyMap[dateStr].value -= 100;
      // Active signals contribute 0 (pending)
    });
    return Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => v);
  })();

  useEffect(() => {
    const fetchData = async () => {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      try {
        const [perfRes, statusRes, weightsRes] = await Promise.all([
          fetch(`${url}/api/performance`, { headers }),
          fetch(`${url}/api/status`, { headers }),
          fetch(`${url}/api/admin/engine/weights`, { headers })
        ]);
        
        if (perfRes.ok) setPerfData(await perfRes.json());
        if (statusRes.ok) setStatusData(await statusRes.json());
        if (weightsRes.ok) {
          const wData = await weightsRes.json();
          setWeights({
            LSTM: wData.lstm * 100,
            Transformer: wData.transformer * 100,
            XGBoost: wData.xgboost * 100,
            threshold: wData.threshold * 100
          });
        }
        
        fetchSignals();
      } catch (err) {
        console.error('Failed to fetch admin data', err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchSignals]);

  const handleCircuitBreaker = async () => {
    const nextState = !isSuspended;
    setIsSuspended(nextState);
    
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${url}/api/admin/circuit-breaker`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ active: nextState })
      });
      
      if (res.ok) {
        const data = await res.json();
        setIsSuspended(data.active);
      }
    } catch (err) {
      console.error('Failed to toggle circuit breaker', err);
      // Revert UI if failed
      setIsSuspended(!nextState);
    }
  };

  return (
    <div className="space-y-8 pb-20">
      {/* Header Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <MetricCard 
          title="Daily Signal Volume" 
          value={perfData?.signals_today ?? signals.length} 
          subValue={perfData?.signals_today ? `${perfData.signals_today} signals today` : 'Pending API'} 
          icon={Target}
          color="red"
        />
        <MetricCard 
          title="Active Sniper Subs" 
          value={statusData?.total_users ?? '—'} 
          subValue={statusData?.retention ? `${statusData.retention}% retention` : 'Pending API'} 
          icon={Users}
          color="blue"
        />
        <MetricCard 
          title="Global Precision" 
          value={`${perfData?.win_rate_all?.win_rate ?? 'N/A'}%`} 
          subValue={perfData?.win_rate_all?.total ? `Based on ${perfData.win_rate_all.total} signals` : 'Pending API'} 
          icon={TrendingUp}
          color="green"
        />
        <MetricCard 
          title="Monthly Recurring" 
          value={perfData?.mrr ? `$${perfData.mrr.toLocaleString()}` : '—'} 
          subValue={perfData?.mrr_growth ? `Growth: +$${perfData.mrr_growth / 1000}k` : 'Pending API'} 
          icon={Zap}
          color="purple"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main Chart */}
        <div className="lg:col-span-2 bg-gray-900/40 border border-gray-800 rounded-2xl p-8 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h2 className="text-xl font-bold">Revenue Matrix</h2>
              <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">Founders Exclusive View</p>
            </div>
            <div className="flex gap-2">
              <span className="px-3 py-1 bg-gray-800 rounded-full text-[10px] text-gray-400 font-bold">24H</span>
              <span className="px-3 py-1 bg-red-500/10 text-red-500 rounded-full text-[10px] font-bold border border-red-500/20">7D</span>
              <span className="px-3 py-1 bg-gray-800 rounded-full text-[10px] text-gray-400 font-bold">30D</span>
            </div>
          </div>
          
          <div className="h-[300px] w-full">
            {revenueChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={revenueChartData}>
                <defs>
                  <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                <XAxis 
                  dataKey="name" 
                  stroke="#4b5563" 
                  fontSize={10} 
                  tickLine={false} 
                  axisLine={false} 
                />
                <YAxis 
                  stroke="#4b5563" 
                  fontSize={10} 
                  tickLine={false} 
                  axisLine={false}
                  tickFormatter={(value) => `$${value/1000}k`}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1f2937', borderRadius: '8px' }}
                  itemStyle={{ color: '#ef4444' }}
                />
                <Area 
                  type="monotone" 
                  dataKey="value" 
                  stroke="#ef4444" 
                  strokeWidth={3}
                  fillOpacity={1} 
                  fill="url(#colorValue)" 
                />
              </AreaChart>
            </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <BarChart3 className="w-12 h-12 text-gray-700 mx-auto mb-3" />
                  <p className="text-gray-500 text-sm font-medium">No revenue data yet</p>
                  <p className="text-gray-600 text-xs mt-1">Chart will populate as signals are resolved</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* AI Voting & Controls */}
        <div className="space-y-8">
          {/* Circuit Breaker */}
          <div className={`p-8 rounded-2xl border transition-all duration-500 ${
            isSuspended 
            ? 'bg-red-500/10 border-red-500 shadow-[0_0_30px_rgba(239,68,68,0.2)]' 
            : 'bg-gray-900/40 border-gray-800'
          }`}>
            <div className="flex items-center gap-3 mb-6">
              <ShieldAlert className={`w-5 h-5 ${isSuspended ? 'text-red-500' : 'text-gray-500'}`} />
              <h2 className="text-lg font-bold uppercase tracking-tighter">Circuit Breaker</h2>
            </div>
            
            <p className="text-xs text-gray-500 mb-8 leading-relaxed">
              Immediate global kill-switch for all signal distribution via Telegram and API. 
              Use only in case of extreme market volatility or engine malfunction.
            </p>

            <div className="relative group">
              <div className="absolute -inset-1 bg-gradient-to-r from-red-600 to-red-400 rounded-xl blur opacity-25 group-hover:opacity-50 transition duration-1000"></div>
              <button 
                onClick={handleCircuitBreaker}
                className={`relative w-full py-4 rounded-xl flex items-center justify-center gap-3 font-bold text-sm transition-all ${
                  isSuspended 
                  ? 'bg-white text-red-600' 
                  : 'bg-red-600 text-white hover:bg-red-700'
                }`}
              >
                <Power className="w-4 h-4" />
                {isSuspended ? 'REACTIVATE SIGNALS' : 'EMERGENCY SHUTDOWN'}
              </button>
            </div>
            
            {isSuspended && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-4 text-center text-[10px] text-red-500 font-bold animate-pulse"
              >
                ● ALL SYSTEMS SUSPENDED
              </motion.div>
            )}
          </div>

          {/* AI Consensus Board */}
          <div className="bg-gray-900/40 border border-gray-800 rounded-2xl p-8">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <Brain className="w-5 h-5 text-purple-500" />
                <h2 className="text-lg font-bold uppercase tracking-tighter">AI Consensus</h2>
              </div>
              <div className="text-[10px] bg-purple-500/10 text-purple-500 px-2 py-0.5 rounded border border-purple-500/20">VOTING</div>
            </div>

            <div className="space-y-6">
              {aiVotes.map((model) => (
                <div key={model.name}>
                  <div className="flex justify-between text-xs mb-2">
                    <span className="text-gray-400">{model.name} ({model.weight})</span>
                    <span className="text-white font-bold">{model.value}% Probability</span>
                  </div>
                  <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${model.value}%` }}
                      className="h-full bg-gradient-to-r from-purple-600 to-red-500"
                    />
                  </div>
                </div>
              ))}
            </div>

            <button className="w-full mt-8 flex items-center justify-center gap-2 text-[10px] text-gray-500 hover:text-white transition-colors">
              VIEW DETAILED WEIGHTS <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ title, value, subValue, icon: Icon, color }: { title: string; value: string | number; subValue: string; icon: React.ComponentType<{ className?: string }>; color: string }) {
  const colors: Record<string, string> = {
    red: 'text-red-500 bg-red-500/10 border-red-500/20',
    blue: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
    green: 'text-green-500 bg-green-500/10 border-green-500/20',
    purple: 'text-purple-500 bg-purple-500/10 border-purple-500/20',
  };

  return (
    <div className="bg-gray-900/40 border border-gray-800 p-6 rounded-2xl backdrop-blur-sm group hover:border-red-500/30 transition-all">
      <div className="flex items-center justify-between mb-4">
        <div className={`p-2 rounded-lg ${colors[color]} border transition-transform group-hover:scale-110`}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Live</div>
      </div>
      <h3 className="text-xs text-gray-500 mb-1">{title}</h3>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold tracking-tight">{value}</span>
        <span className="text-[10px] text-green-500">{subValue}</span>
      </div>
    </div>
  );
}
