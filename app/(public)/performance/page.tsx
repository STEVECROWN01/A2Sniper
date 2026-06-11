'use client';

import { useState, useMemo, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Calendar, TrendingUp, TrendingDown, DollarSign, Target, PieChart, BarChart3, RefreshCw, Download, Filter, AlertCircle } from 'lucide-react';

import { MetricCard } from '@/components/ui/metric-card';
import { PerformanceChart } from '@/components/ui/performance-chart';
import { useAppStore } from '@/lib/store';
import { useAuth } from '@/hooks/use-auth';
import { tradingPairs } from '@/lib/mock-data';

export default function PerformancePage() {
  useAuth();
  const { signals, userStats, fetchPerformance, fetchSignals } = useAppStore();
  const [selectedTimeframe, setSelectedTimeframe] = useState('1M');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch data on mount
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      await Promise.all([fetchSignals(), fetchPerformance()]);
      setIsLoading(false);
    };
    loadData();
  }, [fetchSignals, fetchPerformance]);

  // Filter signals by selected timeframe
  const filteredSignals = useMemo(() => {
    const now = new Date();
    const cutoff = new Date();
    switch (selectedTimeframe) {
      case '1D': cutoff.setDate(now.getDate() - 1); break;
      case '7D': cutoff.setDate(now.getDate() - 7); break;
      case '1M': cutoff.setMonth(now.getMonth() - 1); break;
      case '3M': cutoff.setMonth(now.getMonth() - 3); break;
      case '1Y': cutoff.setFullYear(now.getFullYear() - 1); break;
    }
    return signals.filter(s => new Date(s.timestamp) >= cutoff);
  }, [signals, selectedTimeframe]);

  // Calculer les statistiques par paire
  const pairStats = useMemo(() => {
    return tradingPairs.map(pair => {
      const pairSignals = filteredSignals.filter(s => s.pair === pair.symbol);
      const resolvedSignals = pairSignals.filter(s => s.is_win !== null && s.is_win !== undefined);
      const wonSignals = resolvedSignals.filter(s => s.is_win === true);
      const lostSignals = resolvedSignals.filter(s => s.is_win === false);
      const totalProfit = pairSignals.reduce((sum, s) => sum + (s.profit_loss || 0), 0);
      
      return {
        pair: pair.symbol,
        totalTrades: resolvedSignals.length,
        winRate: resolvedSignals.length > 0 ? (wonSignals.length / resolvedSignals.length) * 100 : 0,
        profit: totalProfit,
        won: wonSignals.length,
        lost: lostSignals.length
      };
    }).filter(stat => stat.totalTrades > 0);
  }, [filteredSignals]);

  // Données pour le graphique (réelles)
  const chartData = useMemo(() => {
    const dailyMap: Record<string, { winRate: number; total: number; profit: number }> = {};
    filteredSignals.forEach(s => {
      const date = new Date(s.timestamp).toISOString().split('T')[0];
      if (!dailyMap[date]) dailyMap[date] = { winRate: 0, total: 0, profit: 0 };
      if (s.is_win !== null && s.is_win !== undefined) {
        dailyMap[date].total++;
        if (s.is_win) dailyMap[date].winRate++;
        dailyMap[date].profit += s.profit_loss || 0;
      }
    });
    return Object.entries(dailyMap).map(([date, data]) => ({
      date,
      winRate: data.total > 0 ? (data.winRate / data.total) * 100 : 0,
      totalTrades: data.total,
      profit: data.profit
    })).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredSignals]);

  // Calculate real change values by comparing with previous period
  const metrics = useMemo(() => {
    const resolvedSignals = filteredSignals.filter(s => s.is_win !== null && s.is_win !== undefined);
    const wonSignals = resolvedSignals.filter(s => s.is_win === true);
    const totalProfit = filteredSignals.reduce((sum, s) => sum + (s.profit_loss || 0), 0);
    const totalTrades = resolvedSignals.length;
    const avgWinRate = totalTrades > 0 ? (wonSignals.length / totalTrades) * 100 : 0;
    const wonTrades = wonSignals.length;

    // Calculate change from userStats (previous period comparison)
    const profitChange = userStats.totalProfit !== 0 
      ? ((totalProfit - userStats.totalProfit) / Math.abs(userStats.totalProfit)) * 100 
      : 0;
    const winRateChange = userStats.winRate !== 0 
      ? avgWinRate - userStats.winRate 
      : 0;
    
    // Only show change if we have data to compare against
    const hasComparison = userStats.totalTrades > 0;

    return {
      totalProfit,
      totalTrades,
      avgWinRate,
      wonTrades,
      profitChange: hasComparison ? profitChange : null,
      winRateChange: hasComparison ? winRateChange : null,
    };
  }, [filteredSignals, userStats]);

  // Monthly performance data (computed from actual signals)
  const monthlyPerformance = useMemo(() => {
    const monthlyMap: Record<string, { wins: number; losses: number; profit: number; trades: number }> = {};
    filteredSignals.forEach(s => {
      if (s.is_win === null || s.is_win === undefined) return;
      const date = new Date(s.timestamp);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (!monthlyMap[key]) monthlyMap[key] = { wins: 0, losses: 0, profit: 0, trades: 0 };
      monthlyMap[key].trades++;
      if (s.is_win) monthlyMap[key].wins++;
      else monthlyMap[key].losses++;
      monthlyMap[key].profit += s.profit_loss || 0;
    });
    return Object.entries(monthlyMap)
      .map(([month, data]) => ({
        month,
        winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
        ...data
      }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [filteredSignals]);

  // Risk metrics data (computed from actual signals)
  const riskMetrics = useMemo(() => {
    const resolvedSignals = filteredSignals.filter(s => s.is_win !== null && s.is_win !== undefined);
    if (resolvedSignals.length === 0) return null;

    const profits = resolvedSignals.filter(s => s.is_win).map(s => s.profit_loss || 0);
    const losses = resolvedSignals.filter(s => !s.is_win).map(s => Math.abs(s.profit_loss || 0));
    const totalProfit = profits.reduce((sum, p) => sum + p, 0);
    const totalLoss = losses.reduce((sum, l) => sum + l, 0);
    const avgProfit = profits.length > 0 ? totalProfit / profits.length : 0;
    const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;
    const winRate = (resolvedSignals.filter(s => s.is_win).length / resolvedSignals.length) * 100;

    // Max drawdown calculation
    let peak = 0;
    let maxDrawdown = 0;
    let runningTotal = 0;
    for (const s of resolvedSignals) {
      runningTotal += s.profit_loss || 0;
      if (runningTotal > peak) peak = runningTotal;
      const drawdown = peak > 0 ? (peak - runningTotal) / peak : 0;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    // Consecutive losses
    let maxConsecutiveLosses = 0;
    let currentLosses = 0;
    for (const s of resolvedSignals) {
      if (!s.is_win) {
        currentLosses++;
        maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
      } else {
        currentLosses = 0;
      }
    }

    return {
      profitFactor: profitFactor === Infinity ? '∞' : profitFactor.toFixed(2),
      avgProfitLossRatio: avgLoss > 0 ? (avgProfit / avgLoss).toFixed(2) : avgProfit > 0 ? '∞' : '0',
      maxDrawdown: (maxDrawdown * 100).toFixed(1),
      maxConsecutiveLosses,
      winRate: winRate.toFixed(1),
      totalTrades: resolvedSignals.length,
    };
  }, [filteredSignals]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([fetchSignals(), fetchPerformance()]);
    setIsRefreshing(false);
  };

  const handleExportPerformance = () => {
    const data = {
      totalProfit: metrics.totalProfit,
      totalTrades: metrics.totalTrades,
      avgWinRate: metrics.avgWinRate,
      pairStats,
      timeframe: selectedTimeframe,
      monthlyPerformance,
      riskMetrics,
      exportDate: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `a2sniper-performance-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="space-y-8">
        <div className="mb-8">
          <div className="h-8 w-64 bg-[#1a1a2e] rounded animate-pulse mb-2" />
          <div className="h-4 w-96 bg-[#1a1a2e] rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1,2,3,4].map(i => (
            <div key={i} className="h-32 bg-[#0A0B0E] rounded-xl border border-[#1a1a2e] animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
          {/* Header */}
          <div className="mb-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4"
            >
              <div>
                <h1 className="text-2xl font-bold text-white mb-2">
                  Analyse de Performance
                </h1>
                <p className="text-gray-400">
                  Analyse détaillée de vos résultats de trading
                </p>
              </div>
              
              <div className="flex items-center space-x-3">
                <select
                  value={selectedTimeframe}
                  onChange={(e) => setSelectedTimeframe(e.target.value)}
                  className="px-4 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white"
                >
                  <option value="1D">1 Jour</option>
                  <option value="7D">7 Jours</option>
                  <option value="1M">1 Mois</option>
                  <option value="3M">3 Mois</option>
                  <option value="1Y">1 Année</option>
                </select>
                
                <button
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  className="p-2 bg-[#D4AF37] text-black rounded-lg hover:bg-[#c5a059] transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
                </button>
                
                <button
                  onClick={handleExportPerformance}
                  className="p-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                >
                  <Download className="w-5 h-5" />
                </button>
              </div>
            </motion.div>
          </div>

          {/* Overview Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            <MetricCard
              title="Profit total"
              value={`$${metrics.totalProfit.toFixed(2)}`}
              change={metrics.profitChange !== null ? { value: Math.abs(metrics.profitChange), type: metrics.profitChange >= 0 ? 'increase' : 'decrease' } : undefined}
              icon={<DollarSign className="w-6 h-6" />}
              color="green"
            />
            <MetricCard
              title="Taux de réussite"
              value={`${metrics.avgWinRate.toFixed(1)}%`}
              change={metrics.winRateChange !== null ? { value: Math.abs(metrics.winRateChange), type: metrics.winRateChange >= 0 ? 'increase' : 'decrease' } : undefined}
              icon={<Target className="w-6 h-6" />}
              color="yellow"
            />
            <MetricCard
              title="Total trades"
              value={metrics.totalTrades}
              icon={<BarChart3 className="w-6 h-6" />}
              color="yellow"
            />
            <MetricCard
              title="Trades gagnants"
              value={metrics.wonTrades}
              icon={<TrendingUp className="w-6 h-6" />}
              color="green"
            />
          </div>

          {/* Performance Chart */}
          <div className="mb-8">
            <PerformanceChart 
              data={chartData.length > 0 ? chartData : [{ date: new Date().toISOString().split('T')[0], winRate: 0, totalTrades: 0, profit: 0 }]}
              title="Évolution de la performance (Données Réelles)"
            />
          </div>

          {/* Performance by Pair */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="bg-[#0A0B0E] rounded-xl border border-[#1a1a2e] p-6 mb-8"
          >
            <h3 className="text-lg font-semibold text-white mb-6">
              Performance par paire de devises
            </h3>
            {pairStats.length === 0 ? (
              <div className="text-center py-12">
                <AlertCircle className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                <p className="text-gray-500 text-sm">Aucune donnée de performance disponible pour cette période.</p>
                <p className="text-gray-600 text-xs mt-2">Les statistiques par paire apparaîtront dès que des signaux résolus seront disponibles.</p>
              </div>
            ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[#1a1a2e]">
                    <th className="text-left py-3 px-4 font-medium text-white">Paire</th>
                    <th className="text-left py-3 px-4 font-medium text-white">Trades</th>
                    <th className="text-left py-3 px-4 font-medium text-white">Taux de réussite</th>
                    <th className="text-left py-3 px-4 font-medium text-white">Profit</th>
                    <th className="text-left py-3 px-4 font-medium text-white">Gagnés</th>
                    <th className="text-left py-3 px-4 font-medium text-white">Perdus</th>
                  </tr>
                </thead>
                <tbody>
                  {pairStats.map((stat, index) => (
                    <motion.tr
                      key={stat.pair}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.3, delay: index * 0.1 }}
                      className="border-b border-[#1a1a2e] hover:bg-white/[0.02]"
                    >
                      <td className="py-4 px-4">
                        <div className="flex items-center space-x-3">
                          <div className="w-8 h-8 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] rounded-lg flex items-center justify-center">
                            <span className="text-black font-bold text-xs">
                              {stat.pair.split('/')[0]}
                            </span>
                          </div>
                          <span className="font-medium text-white">{stat.pair}</span>
                        </div>
                      </td>
                      <td className="py-4 px-4 text-gray-300">{stat.totalTrades}</td>
                      <td className="py-4 px-4">
                        <div className="flex items-center space-x-2">
                          <span className={`font-medium ${
                            stat.winRate >= 80 ? 'text-green-600' :
                            stat.winRate >= 60 ? 'text-yellow-600' :
                            'text-red-600'
                          }`}>
                            {stat.winRate.toFixed(1)}%
                          </span>
                          <div className="w-20 bg-[#1a1a2e] rounded-full h-2">
                            <div 
                              className={`h-2 rounded-full ${
                                stat.winRate >= 80 ? 'bg-green-500' :
                                stat.winRate >= 60 ? 'bg-yellow-500' :
                                'bg-red-500'
                              }`}
                              style={{ width: `${stat.winRate}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        <span className={`font-medium ${
                          stat.profit > 0 ? 'text-green-600' : 'text-red-600'
                        }`}>
                          {stat.profit > 0 ? '+' : ''}${stat.profit.toFixed(2)}
                        </span>
                      </td>
                      <td className="py-4 px-4">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-500/10 text-green-400">
                          {stat.won}
                        </span>
                      </td>
                      <td className="py-4 px-4">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-400">
                          {stat.lost}
                        </span>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </motion.div>

          {/* Additional Stats */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Monthly Performance */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="bg-[#0A0B0E] rounded-xl border border-[#1a1a2e] p-6"
            >
              <h3 className="text-lg font-semibold text-white mb-4">
                Performance mensuelle
              </h3>
              {monthlyPerformance.length === 0 ? (
                <div className="text-center py-8">
                  <Calendar className="w-10 h-10 text-gray-600 mx-auto mb-3" />
                  <p className="text-gray-500 text-sm">Aucune donnée mensuelle disponible.</p>
                  <p className="text-gray-600 text-xs mt-1">Les performances mensuelles s&apos;afficheront dès que des signaux résolus seront enregistrés.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {monthlyPerformance.map(mp => (
                    <div key={mp.month} className="flex items-center justify-between p-3 bg-[#050507] rounded-lg border border-white/5">
                      <span className="text-sm font-medium text-gray-300">{mp.month}</span>
                      <div className="flex items-center gap-4">
                        <span className={`text-sm font-bold ${mp.profit >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          {mp.profit >= 0 ? '+' : ''}{mp.profit.toFixed(2)}$
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          mp.winRate >= 70 ? 'bg-green-500/10 text-green-400' :
                          mp.winRate >= 50 ? 'bg-yellow-500/10 text-yellow-400' :
                          'bg-red-500/10 text-red-400'
                        }`}>
                          {mp.winRate.toFixed(1)}%
                        </span>
                        <span className="text-xs text-gray-500">{mp.trades} trades</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>

            {/* Risk Metrics */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="bg-[#0A0B0E] rounded-xl border border-[#1a1a2e] p-6"
            >
              <h3 className="text-lg font-semibold text-white mb-4">
                Métriques de risque
              </h3>
              {!riskMetrics ? (
                <div className="text-center py-8">
                  <PieChart className="w-10 h-10 text-gray-600 mx-auto mb-3" />
                  <p className="text-gray-500 text-sm">Aucune donnée de risque disponible.</p>
                  <p className="text-gray-600 text-xs mt-1">Les métriques de risque seront calculées dès que des résultats de trades seront enregistrés.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {[
                    { label: 'Profit Factor', value: riskMetrics.profitFactor, color: parseFloat(String(riskMetrics.profitFactor)) >= 1.5 ? 'text-green-400' : 'text-yellow-400' },
                    { label: 'Ratio Gain/Perte moyen', value: riskMetrics.avgProfitLossRatio, color: 'text-[#D4AF37]' },
                    { label: 'Drawdown maximal', value: `${riskMetrics.maxDrawdown}%`, color: 'text-red-400' },
                    { label: 'Pertes consécutives max', value: String(riskMetrics.maxConsecutiveLosses), color: 'text-orange-400' },
                    { label: 'Taux de réussite', value: `${riskMetrics.winRate}%`, color: parseFloat(riskMetrics.winRate) >= 60 ? 'text-green-400' : 'text-red-400' },
                    { label: 'Trades analysés', value: String(riskMetrics.totalTrades), color: 'text-gray-300' },
                  ].map((metric) => (
                    <div key={metric.label} className="flex items-center justify-between p-3 bg-[#050507] rounded-lg border border-white/5">
                      <span className="text-sm text-gray-400">{metric.label}</span>
                      <span className={`text-sm font-bold ${metric.color}`}>{metric.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </div>
    </div>
  );
}