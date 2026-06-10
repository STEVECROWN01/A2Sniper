'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line } from 'recharts';
import { TrendingUp, Zap, Clock, Target, RefreshCw, Download } from 'lucide-react';

const darkTooltipStyle = {
  backgroundColor: '#0a0a0c',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '12px',
  color: '#fff',
  fontSize: '11px',
  fontWeight: 700,
};

export function AdvancedAnalytics() {
  const [liveData, setLiveData] = useState({
    signalsGenerated: 247,
    aiAccuracy: 90.2,
    avgProfit: 67.50,
    avgExecutionTime: 28
  });

  const [performanceByHour, setPerformanceByHour] = useState([
    { hour: '00:00', signals: 12, accuracy: 88 },
    { hour: '02:00', signals: 8, accuracy: 92 },
    { hour: '04:00', signals: 15, accuracy: 87 },
    { hour: '06:00', signals: 23, accuracy: 91 },
    { hour: '08:00', signals: 35, accuracy: 93 },
    { hour: '10:00', signals: 42, accuracy: 89 },
    { hour: '12:00', signals: 38, accuracy: 94 },
    { hour: '14:00', signals: 45, accuracy: 88 },
    { hour: '16:00', signals: 41, accuracy: 92 },
    { hour: '18:00', signals: 29, accuracy: 90 },
    { hour: '20:00', signals: 18, accuracy: 86 },
    { hour: '22:00', signals: 14, accuracy: 89 }
  ]);

  const [timeframeDistribution, setTimeframeDistribution] = useState([
    { name: '1 min', value: 35, color: '#D4AF37' },
    { name: '3 min', value: 45, color: '#10B981' },
    { name: '5 min', value: 20, color: '#D4AF37' }
  ]);

  const [pairPerformance, setPairPerformance] = useState([
    { pair: 'EUR/USD', trades: 45, winRate: 92, profit: 234.50 },
    { pair: 'GBP/USD', trades: 38, winRate: 89, profit: 187.20 },
    { pair: 'USD/JPY', trades: 42, winRate: 91, profit: 201.80 },
    { pair: 'AUD/USD', trades: 29, winRate: 87, profit: 156.40 },
    { pair: 'USD/CHF', trades: 33, winRate: 90, profit: 178.90 }
  ]);

  // Mise à jour temps réel des données
  useEffect(() => {
    const interval = setInterval(() => {
      setLiveData(prev => ({
        signalsGenerated: prev.signalsGenerated + Math.floor(Math.random() * 3),
        aiAccuracy: Math.max(85, Math.min(95, prev.aiAccuracy + (Math.random() - 0.5) * 0.5)),
        avgProfit: Math.max(50, Math.min(100, prev.avgProfit + (Math.random() - 0.5) * 5)),
        avgExecutionTime: Math.max(20, Math.min(40, prev.avgExecutionTime + (Math.random() - 0.5) * 2))
      }));

      // Mise à jour des données de performance par heure
      setPerformanceByHour(prev => prev.map(item => ({
        ...item,
        signals: Math.max(5, item.signals + Math.floor((Math.random() - 0.5) * 4)),
        accuracy: Math.max(80, Math.min(98, item.accuracy + (Math.random() - 0.5) * 2))
      })));

      // Mise à jour des performances par paire
      setPairPerformance(prev => prev.map(item => ({
        ...item,
        trades: item.trades + Math.floor(Math.random() * 2),
        winRate: Math.max(80, Math.min(98, item.winRate + (Math.random() - 0.5) * 1)),
        profit: Math.max(100, item.profit + (Math.random() - 0.3) * 20)
      })));
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const handleRefresh = () => {
    const notification = document.createElement('div');
    notification.className = 'fixed top-4 right-4 bg-[#D4AF37] text-black px-6 py-3 rounded-xl shadow-lg z-50 font-bold text-xs uppercase tracking-wider';
    notification.textContent = 'Analytics mis à jour !';
    document.body.appendChild(notification);
    setTimeout(() => document.body.removeChild(notification), 3000);
  };

  const handleExport = () => {
    const data = {
      timestamp: new Date().toISOString(),
      liveData,
      performanceByHour,
      timeframeDistribution,
      pairPerformance
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analytics-export-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const notification = document.createElement('div');
    notification.className = 'fixed top-4 right-4 bg-[#D4AF37] text-black px-6 py-3 rounded-xl shadow-lg z-50 font-bold text-xs uppercase tracking-wider';
    notification.textContent = 'Analytics exportées !';
    document.body.appendChild(notification);
    setTimeout(() => document.body.removeChild(notification), 3000);
  };

  return (
    <div className="space-y-8">
      {/* Métriques temps réel */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {[
          { label: 'Signaux Générés', value: liveData.signalsGenerated.toString(), sub: '+12 dernière heure', icon: TrendingUp, color: 'text-[#D4AF37] bg-[#D4AF37]/10' },
          { label: 'Précision Assistant', value: `${liveData.aiAccuracy.toFixed(1)}%`, sub: '+0.3% aujourd\'hui', icon: Zap, color: 'text-green-400 bg-green-500/10' },
          { label: 'Profit Moyen', value: `$${liveData.avgProfit.toFixed(2)}`, sub: '+5.2% cette semaine', icon: Target, color: 'text-purple-400 bg-purple-500/10' },
          { label: 'Temps Moyen', value: `${liveData.avgExecutionTime.toFixed(0)}s`, sub: '-2s optimisé', icon: Clock, color: 'text-[#D4AF37] bg-[#D4AF37]/10' },
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
                <p className="text-[10px] text-green-400 font-bold mt-1">{metric.sub}</p>
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
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={performanceByHour}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="hour" tick={{ fill: '#6b7280', fontSize: 10, fontWeight: 700 }} axisLine={{ stroke: 'rgba(255,255,255,0.05)' }} />
              <YAxis tick={{ fill: '#6b7280', fontSize: 10, fontWeight: 700 }} axisLine={{ stroke: 'rgba(255,255,255,0.05)' }} />
              <Tooltip contentStyle={darkTooltipStyle} />
              <Bar dataKey="signals" fill="#D4AF37" name="Signaux" radius={[4, 4, 0, 0]} />
              <Bar dataKey="accuracy" fill="#10B981" name="Précision %" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Distribution des timeframes */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="bg-[#0a0a0c]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md"
        >
          <h3 className="text-sm font-black text-white uppercase tracking-wider mb-6">Distribution des Timeframes</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={timeframeDistribution}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="value"
              >
                {timeframeDistribution.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip contentStyle={darkTooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
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
              {pairPerformance.map((pair, index) => (
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
                        pair.winRate >= 90 ? 'text-green-400' :
                        pair.winRate >= 85 ? 'text-yellow-400' :
                        'text-red-400'
                      }`}>
                        {pair.winRate.toFixed(1)}%
                      </span>
                      <div className="w-20 bg-white/5 rounded-full h-1.5">
                        <div 
                          className={`h-1.5 rounded-full ${
                            pair.winRate >= 90 ? 'bg-green-500' :
                            pair.winRate >= 85 ? 'bg-yellow-500' :
                            'bg-red-500'
                          }`}
                          style={{ width: `${pair.winRate}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="py-4 px-4">
                    <span className="text-xs font-black text-green-400">
                      ${pair.profit.toFixed(2)}
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
                          stroke="#D4AF37" 
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
      </motion.div>
    </div>
  );
}