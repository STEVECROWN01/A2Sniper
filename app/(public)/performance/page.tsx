'use client';

import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Calendar, TrendingUp, DollarSign, Target, PieChart, BarChart3, RefreshCw, Download, Filter } from 'lucide-react';

import { MetricCard } from '@/components/ui/metric-card';
import { PerformanceChart } from '@/components/ui/performance-chart';
import { useAppStore } from '@/lib/store';
import { useAuth } from '@/hooks/use-auth';
import { tradingPairs } from '@/lib/mock-data';

export default function PerformancePage() {
  useAuth();
  const { signals, userStats } = useAppStore();
  const [selectedTimeframe, setSelectedTimeframe] = useState('1M');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Calculer les statistiques par paire
  const pairStats = useMemo(() => {
    return tradingPairs.map(pair => {
      const pairSignals = signals.filter(s => s.pair === pair.symbol);
      const resolvedSignals = pairSignals.filter(s => s.is_win !== null);
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
  }, [signals]);

  // Données pour le graphique (réelles)
  const chartData = useMemo(() => {
    // Regrouper les signaux par jour
    const dailyMap: Record<string, { winRate: number; total: number; profit: number }> = {};
    signals.forEach(s => {
      const date = new Date(s.timestamp).toISOString().split('T')[0];
      if (!dailyMap[date]) dailyMap[date] = { winRate: 0, total: 0, profit: 0 };
      if (s.is_win !== null) {
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
  }, [signals]);

  const totalProfit = signals.reduce((sum, s) => sum + (s.profit_loss || 0), 0);
  const totalTrades = signals.filter(s => s.status === 'WON' || s.status === 'LOST').length;
  const wonTrades = signals.filter(s => s.status === 'WON').length;
  const avgWinRate = totalTrades > 0 ? (wonTrades / totalTrades) * 100 : 0;

  const handleRefresh = () => {
    setIsRefreshing(true);
    setTimeout(() => {
      setIsRefreshing(false);
    }, 1500);
  };

  const handleExportPerformance = () => {
    const data = {
      totalProfit,
      totalTrades,
      avgWinRate,
      pairStats,
      timeframe: selectedTimeframe,
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
                <h1 className="text-2xl font-bold text-gray-900 mb-2">
                  Analyse de Performance
                </h1>
                <p className="text-gray-600">
                  Analyse détaillée de vos résultats de trading
                </p>
              </div>
              
              <div className="flex items-center space-x-3">
                <select
                  value={selectedTimeframe}
                  onChange={(e) => setSelectedTimeframe(e.target.value)}
                  className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent"
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
              value={`$${totalProfit.toFixed(2)}`}
              change={{ value: 15.3, type: 'increase' }}
              icon={<DollarSign className="w-6 h-6" />}
              color="green"
            />
            <MetricCard
              title="Taux de réussite"
              value={`${avgWinRate.toFixed(1)}%`}
              change={{ value: 2.5, type: 'increase' }}
              icon={<Target className="w-6 h-6" />}
              color="yellow"
            />
            <MetricCard
              title="Total trades"
              value={totalTrades}
              change={{ value: 8, type: 'increase' }}
              icon={<BarChart3 className="w-6 h-6" />}
              color="yellow"
            />
            <MetricCard
              title="Trades gagnants"
              value={wonTrades}
              change={{ value: 12, type: 'increase' }}
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
            className="bg-white rounded-xl shadow-lg border border-gray-100 p-6 mb-8"
          >
            <h3 className="text-lg font-semibold text-gray-900 mb-6">
              Performance par paire de devises
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-3 px-4 font-medium text-gray-900">Paire</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-900">Trades</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-900">Taux de réussite</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-900">Profit</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-900">Gagnés</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-900">Perdus</th>
                  </tr>
                </thead>
                <tbody>
                  {pairStats.map((stat, index) => (
                    <motion.tr
                      key={stat.pair}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.3, delay: index * 0.1 }}
                      className="border-b border-gray-100 hover:bg-gray-50"
                    >
                      <td className="py-4 px-4">
                        <div className="flex items-center space-x-3">
                          <div className="w-8 h-8 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] rounded-lg flex items-center justify-center">
                            <span className="text-black font-bold text-xs">
                              {stat.pair.split('/')[0]}
                            </span>
                          </div>
                          <span className="font-medium text-gray-900">{stat.pair}</span>
                        </div>
                      </td>
                      <td className="py-4 px-4 text-gray-900">{stat.totalTrades}</td>
                      <td className="py-4 px-4">
                        <div className="flex items-center space-x-2">
                          <span className={`font-medium ${
                            stat.winRate >= 80 ? 'text-green-600' :
                            stat.winRate >= 60 ? 'text-yellow-600' :
                            'text-red-600'
                          }`}>
                            {stat.winRate.toFixed(1)}%
                          </span>
                          <div className="w-20 bg-gray-200 rounded-full h-2">
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
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                          {stat.won}
                        </span>
                      </td>
                      <td className="py-4 px-4">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                          {stat.lost}
                        </span>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>

          {/* Additional Stats */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Monthly Performance */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="bg-white rounded-xl shadow-lg border border-gray-100 p-6"
            >
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Performance mensuelle
              </h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Janvier 2026</span>
                  <span className="text-green-600 font-medium">+$1,247</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Février 2026</span>
                  <span className="text-green-600 font-medium">+$1,863</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Mars 2026</span>
                  <span className="text-green-600 font-medium">+$2,156</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Avril 2026</span>
                  <span className="text-green-600 font-medium">+$1,924</span>
                </div>
              </div>
            </motion.div>

            {/* Risk Metrics */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="bg-white rounded-xl shadow-lg border border-gray-100 p-6"
            >
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Métriques de risque
              </h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Drawdown max</span>
                  <span className="text-red-600 font-medium">-12.5%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Ratio gain/perte</span>
                  <span className="text-green-600 font-medium">1.8:1</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Série gagnante</span>
                  <span className="text-[#D4AF37] font-medium">8 trades</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">Série perdante</span>
                  <span className="text-red-600 font-medium">3 trades</span>
                </div>
              </div>
            </motion.div>
          </div>
    </div>
  );
}