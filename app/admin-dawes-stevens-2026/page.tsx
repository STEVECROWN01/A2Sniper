'use client';

import { useState, useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Zap, 
  TrendingUp, 
  Users, 
  Target, 
  AlertTriangle, 
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
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell
} from 'recharts';

const data = [
  { name: '08:00', value: 12400 },
  { name: '10:00', value: 13200 },
  { name: '12:00', value: 12800 },
  { name: '14:00', value: 14500 },
  { name: '16:00', value: 15100 },
  { name: '18:00', value: 14800 },
  { name: '20:00', value: 15900 },
];

export default function AdminDashboard() {
  useAuth(true);
  const { signals, fetchSignals } = useAppStore();
  const [weights, setWeights] = useState({ LSTM: 40, Transformer: 35, XGBoost: 25, threshold: 95 });
  const [isBreakerOpen, setIsBreakerOpen] = useState(false);
  const [mrr, setMrr] = useState(15900);
  const [isSuspended, setIsSuspended] = useState(false);
  const [perfData, setPerfData] = useState<any>(null);

  const aiVotes = [
    { name: 'LSTM', value: 98, weight: `${weights.LSTM}%`, status: 'Operational' },
    { name: 'Transformer', value: 96, weight: `${weights.Transformer}%`, status: 'Operational' },
    { name: 'XGBoost', value: 99, weight: `${weights.XGBoost}%`, status: 'Operational' },
  ];
  const [statusData, setStatusData] = useState<any>(null);

  useEffect(() => {
    const fetchData = async () => {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      try {
        const [perfRes, statusRes, weightsRes] = await Promise.all([
          fetch(`${url}/api/performance`),
          fetch(`${url}/api/status`),
          fetch(`${url}/api/admin/engine/weights`)
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
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      const res = await fetch(`${url}/api/admin/circuit-breaker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
          value={perfData?.signals_today || signals.length} 
          subValue="+12% from yesterday" 
          icon={Target}
          color="red"
        />
        <MetricCard 
          title="Active Sniper Subs" 
          value="428" 
          subValue="98% retention rate" 
          icon={Users}
          color="blue"
        />
        <MetricCard 
          title="Global Precision" 
          value={`${perfData?.win_rate_all?.win_rate || '99.99'}%`} 
          subValue={`Based on ${perfData?.win_rate_all?.total || 1000} signals`} 
          icon={TrendingUp}
          color="green"
        />
        <MetricCard 
          title="Monthly Recurring" 
          value={`$${mrr.toLocaleString()}`} 
          subValue="Growth: +$2.4k" 
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
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data}>
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

function MetricCard({ title, value, subValue, icon: Icon, color }: any) {
  const colors: any = {
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
