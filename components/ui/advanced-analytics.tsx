'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line } from 'recharts';
import { TrendingUp, Zap, Clock, Target, RefreshCw, Download, Loader2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '@/lib/store';
import { Signal } from '@/lib/mock-data';

const darkTooltipStyle = {
  backgroundColor: '#0a0a0c',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '12px',
  color: '#fff',
  fontSize: '11px',
  fontWeight: 700,
};

interface AnalyticsData {
  liveData: {
    signalsGenerated: number;
    aiAccuracy: number;
    avgProfit: number;
    avgExecutionTime: number;
  };
  performanceByHour: { hour: string; signals: number; accuracy: number }[];
  timeframeDistribution: { name: string; value: number; color: string }[];
  pairPerformance: { pair: string; trades: number; winRate: number; profit: number }[];
}

interface AdvancedAnalyticsProps {
  timeframe?: string;
}

export function AdvancedAnalytics({ timeframe = '24H' }: AdvancedAnalyticsProps) {
  const { signals, fetchSignals, fetchPerformance, userStats } = useAppStore();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const prevTimeframeRef = useRef<string>(timeframe);

  const loadAnalyticsData = useCallback(async (forceRefresh = false) => {
    setIsLoading(true);
    setError(null);

    try {
      // Only refetch signals from store if timeframe changed or forced
      if (forceRefresh || prevTimeframeRef.current !== timeframe) {
        await Promise.all([fetchSignals(), fetchPerformance()]);
        prevTimeframeRef.current = timeframe;
      }

      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;

      // Fetch performance data from API
      const perfRes = await fetch(`${apiUrl}/api/performance?timeframe=${timeframe}`, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
      });

      interface PerfApiResponse {
        win_rate?: string;
        avg_execution_time?: number;
        [key: string]: unknown;
      }
      let perfData: PerfApiResponse = {};
      if (perfRes.ok) {
        perfData = await perfRes.json();
      }

      // Read the latest signals from the store directly
      const currentSignals = useAppStore.getState().signals;

      // Compute analytics from real signals data
      const now = new Date();
      const timeframeMs: Record<string, number> = {
        '1H': 60 * 60 * 1000,
        '24H': 24 * 60 * 60 * 1000,
        '7D': 7 * 24 * 60 * 60 * 1000,
        '30D': 30 * 24 * 60 * 60 * 1000,
      };
      const cutoff = new Date(now.getTime() - (timeframeMs[timeframe] || timeframeMs['24H']));
      const filteredSignals = currentSignals.filter((s: Signal) => new Date(s.timestamp) >= cutoff);

      // Calculate live metrics from real data
      const resolvedSignals = filteredSignals.filter((s: Signal) => s.is_win !== null);
      const wonSignals = resolvedSignals.filter((s: Signal) => s.is_win === true);
      const totalProfit = resolvedSignals.reduce((sum: number, s: Signal) => sum + (s.profit_loss || 0), 0);

      const liveData = {
        signalsGenerated: filteredSignals.length,
        aiAccuracy: perfData.win_rate ? parseFloat(perfData.win_rate) : (resolvedSignals.length > 0 ? (wonSignals.length / resolvedSignals.length) * 100 : 0),
        avgProfit: resolvedSignals.length > 0 ? totalProfit / resolvedSignals.length : 0,
        avgExecutionTime: perfData.avg_execution_time || 0,
      };

      // Calculate performance by hour from signals
      const hourMap = new Map<string, { signals: number; wins: number }>();
      for (let h = 0; h < 24; h++) {
        const hourKey = `${h.toString().padStart(2, '0')}:00`;
        hourMap.set(hourKey, { signals: 0, wins: 0 });
      }

      filteredSignals.forEach((s: Signal) => {
        const hour = new Date(s.timestamp).getHours();
        const hourKey = `${hour.toString().padStart(2, '0')}:00`;
        const current = hourMap.get(hourKey) || { signals: 0, wins: 0 };
        current.signals++;
        if (s.is_win === true) current.wins++;
        hourMap.set(hourKey, current);
      });

      const performanceByHour = Array.from(hourMap.entries()).map(([hour, { signals: sigs, wins }]) => ({
        hour,
        signals: sigs,
        accuracy: sigs > 0 ? Math.round((wins / sigs) * 100) : 0,
      }));

      // Calculate timeframe distribution from signals
      const tfMap = new Map<number, number>();
      filteredSignals.forEach((s: Signal) => {
        const exp = s.expiration || 1;
        tfMap.set(exp, (tfMap.get(exp) || 0) + 1);
      });

      const tfColors: Record<number, string> = { 1: '#D4AF37', 3: '#10B981', 5: '#6366F1' };
      const timeframeDistribution = Array.from(tfMap.entries()).map(([exp, count]) => ({
        name: `${exp} min`,
        value: count,
        color: tfColors[exp] || '#D4AF37',
      }));

      // Calculate pair performance from signals
      const pairMap = new Map<string, { trades: number; wins: number; profit: number }>();
      filteredSignals.forEach((s: Signal) => {
        const pair = s.pair || 'Unknown';
        const current = pairMap.get(pair) || { trades: 0, wins: 0, profit: 0 };
        current.trades++;
        if (s.is_win === true) current.wins++;
        current.profit += s.profit_loss || 0;
        pairMap.set(pair, current);
      });

      const pairPerformance = Array.from(pairMap.entries()).map(([pair, { trades, wins, profit }]) => ({
        pair,
        trades,
        winRate: trades > 0 ? (wins / trades) * 100 : 0,
        profit,
      })).sort((a, b) => b.trades - a.trades).slice(0, 8);

      setData({ liveData, performanceByHour, timeframeDistribution, pairPerformance });
    } catch (err) {
      console.error('Failed to load analytics data', err);
      setError('Impossible de charger les données analytiques. Vérifiez votre connexion.');
    } finally {
      setIsLoading(false);
    }
  }, [timeframe, fetchSignals, fetchPerformance]);

  useEffect(() => {
    loadAnalyticsData(true);
  }, [timeframe]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => {
    loadAnalyticsData(true);
    toast.success('Analytics rafraîchis !');
  };

  const handleExport = () => {
    if (!data) return;
    const exportData = {
      timeframe,
      timestamp: new Date().toISOString(),
      liveData: data.liveData,
      performanceByHour: data.performanceByHour,
      timeframeDistribution: data.timeframeDistribution,
      pairPerformance: data.pairPerformance,
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analytics-export-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Analytics exportées !');
  };

  if (isLoading) {
    return (
      <div className="space-y-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-[#0a0a0c]/80 border border-white/5 rounded-2xl p-6 animate-pulse">
              <div className="h-3 w-24 bg-white/5 rounded mb-2" />
              <div className="h-7 w-16 bg-white/5 rounded mb-1" />
              <div className="h-3 w-20 bg-white/5 rounded" />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 text-[#D4AF37] animate-spin" />
          <span className="ml-3 text-gray-400 font-bold">Chargement des données analytiques...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-8">
        <div className="bg-red-500/10 border border-red-500/30 p-6 rounded-2xl flex items-center gap-4">
          <AlertCircle className="w-6 h-6 text-red-400 flex-shrink-0" />
          <div>
            <p className="text-red-300 font-bold">{error || 'Aucune donnée disponible'}</p>
            <button onClick={handleRefresh} className="text-red-400 hover:text-red-300 text-sm mt-1 underline">
              Réessayer
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Métriques */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {[
          { label: 'Signaux Générés', value: data.liveData.signalsGenerated.toString(), sub: timeframe, icon: TrendingUp, color: 'text-[#D4AF37] bg-[#D4AF37]/10' },
          { label: 'Précision', value: data.liveData.aiAccuracy > 0 ? `${data.liveData.aiAccuracy.toFixed(1)}%` : 'N/A', sub: 'Données réelles', icon: Zap, color: 'text-green-400 bg-green-500/10' },
          { label: 'Profit Moyen', value: data.liveData.avgProfit !== 0 ? `$${data.liveData.avgProfit.toFixed(2)}` : 'N/A', sub: 'Par signal', icon: Target, color: 'text-purple-400 bg-purple-500/10' },
          { label: 'Temps Exécution', value: data.liveData.avgExecutionTime > 0 ? `${data.liveData.avgExecutionTime.toFixed(0)}s` : 'N/A', sub: 'Moyenne', icon: Clock, color: 'text-[#D4AF37] bg-[#D4AF37]/10' },
        ].map((metric, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            className="bg-[#0a0a0c]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">{metric.label}</p>
                <p className="text-2xl font-black text-white tracking-tight">{metric.value}</p>
                <p className="text-[10px] text-gray-500 font-bold mt-1">{metric.sub}</p>
              </div>
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${metric.color}`}>
                <metric.icon className="w-5 h-5" />
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Graphiques */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Performance par heure */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="bg-[#0a0a0c]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md"
        >
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-sm font-black text-white uppercase tracking-wider">Performance par Heure</h3>
            <div className="flex space-x-2">
              <button
                onClick={handleRefresh}
                className="p-2 bg-white/[0.03] border border-white/5 text-gray-400 rounded-lg hover:border-[#D4AF37]/30 hover:text-[#D4AF37] transition-all"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleExport}
                className="p-2 bg-white/[0.03] border border-white/5 text-gray-400 rounded-lg hover:border-[#D4AF37]/30 hover:text-[#D4AF37] transition-all"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          {data.performanceByHour.some(d => d.signals > 0) ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.performanceByHour}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="hour" tick={{ fill: '#6b7280', fontSize: 10, fontWeight: 700 }} axisLine={{ stroke: 'rgba(255,255,255,0.05)' }} />
                <YAxis tick={{ fill: '#6b7280', fontSize: 10, fontWeight: 700 }} axisLine={{ stroke: 'rgba(255,255,255,0.05)' }} />
                <Tooltip contentStyle={darkTooltipStyle} />
                <Bar dataKey="signals" fill="#D4AF37" name="Signaux" radius={[4, 4, 0, 0]} />
                <Bar dataKey="accuracy" fill="#10B981" name="Précision %" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-gray-500 text-sm font-bold">
              Aucune donnée disponible pour cette période
            </div>
          )}
        </motion.div>

        {/* Distribution des timeframes */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="bg-[#0a0a0c]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md"
        >
          <h3 className="text-sm font-black text-white uppercase tracking-wider mb-6">Distribution des Timeframes</h3>
          {data.timeframeDistribution.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={data.timeframeDistribution}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {data.timeframeDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip contentStyle={darkTooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-gray-500 text-sm font-bold">
              Aucune donnée de timeframe disponible
            </div>
          )}
        </motion.div>
      </div>

      {/* Performance par paire */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6 }}
        className="bg-[#0a0a0c]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md"
      >
        <h3 className="text-sm font-black text-white uppercase tracking-wider mb-6">Performance par Paire de Devises</h3>
        {data.pairPerformance.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left py-3 px-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">Paire</th>
                  <th className="text-left py-3 px-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">Trades</th>
                  <th className="text-left py-3 px-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">Taux Réussite</th>
                  <th className="text-left py-3 px-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">Profit</th>
                  <th className="text-left py-3 px-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">Tendance</th>
                </tr>
              </thead>
              <tbody>
                {data.pairPerformance.map((pair, index) => (
                  <motion.tr
                    key={pair.pair}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.7 + index * 0.1 }}
                    className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="py-4 px-4">
                      <div className="flex items-center space-x-3">
                        <div className="w-8 h-8 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] rounded-lg flex items-center justify-center">
                          <span className="text-black font-black text-[10px]">
                            {pair.pair.split('/')[0]}
                          </span>
                        </div>
                        <span className="text-xs font-black text-white">{pair.pair}</span>
                      </div>
                    </td>
                    <td className="py-4 px-4 text-xs font-bold text-gray-300">{pair.trades}</td>
                    <td className="py-4 px-4">
                      <div className="flex items-center space-x-2">
                        <span className={`text-xs font-black ${
                          pair.winRate >= 70 ? 'text-green-400' :
                          pair.winRate >= 55 ? 'text-yellow-400' :
                          'text-red-400'
                        }`}>
                          {pair.winRate.toFixed(1)}%
                        </span>
                        <div className="w-20 bg-white/5 rounded-full h-1.5">
                          <div
                            className={`h-1.5 rounded-full ${
                              pair.winRate >= 70 ? 'bg-green-500' :
                              pair.winRate >= 55 ? 'bg-yellow-500' :
                              'bg-red-500'
                            }`}
                            style={{ width: `${Math.min(pair.winRate, 100)}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-4">
                      <span className={`text-xs font-black ${pair.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {pair.profit >= 0 ? '+' : ''}{pair.profit.toFixed(2)}
                      </span>
                    </td>
                    <td className="py-4 px-4">
                      <ResponsiveContainer width={60} height={30}>
                        <LineChart data={[
                          { value: pair.profit * 0.8 },
                          { value: pair.profit * 0.9 },
                          { value: pair.profit * 1.1 },
                          { value: pair.profit }
                        ]}>
                          <Line
                            type="monotone"
                            dataKey="value"
                            stroke={pair.profit >= 0 ? '#10B981' : '#EF4444'}
                            strokeWidth={2}
                            dot={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-12 text-center text-gray-500 text-sm font-bold">
            Aucune donnée de performance par paire disponible
          </div>
        )}
      </motion.div>
    </div>
  );
}
