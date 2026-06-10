'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Download, TrendingUp, TrendingDown, DollarSign, Target, Calendar, BarChart3 } from 'lucide-react';
import { BacktestResult } from '@/lib/backtesting';

interface BacktestResultsProps {
  result: BacktestResult;
  onClose: () => void;
}

export function BacktestResults({ result, onClose }: BacktestResultsProps) {
  const [activeTab, setActiveTab] = useState('overview');

  const handleDownload = (format: 'pdf' | 'csv' | 'json') => {
    const data = format === 'json' ? JSON.stringify(result, null, 2) : 
                 format === 'csv' ? convertToCSV(result) : 
                 'PDF export simulation';
    
    const blob = new Blob([data], { 
      type: format === 'json' ? 'application/json' : 
            format === 'csv' ? 'text/csv' : 
            'application/pdf' 
    });
    
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backtest-results.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const convertToCSV = (result: BacktestResult): string => {
    const headers = ['Trade ID', 'Entry Time', 'Exit Time', 'Pair', 'Direction', 'Result', 'Profit'];
    const rows = result.trades.map(trade => [
      trade.id,
      trade.entryTime.toISOString(),
      trade.exitTime.toISOString(),
      trade.signal.pair,
      trade.direction,
      trade.result,
      trade.netProfit.toFixed(2)
    ]);
    
    return [headers, ...rows].map(row => row.join(',')).join('\n');
  };

  const tabs = [
    { id: 'overview', name: 'Vue d\'ensemble', icon: BarChart3 },
    { id: 'trades', name: 'Trades', icon: TrendingUp },
    { id: 'metrics', name: 'Métriques', icon: Target }
  ];

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-[#0a0a0c] border border-white/10 rounded-2xl shadow-2xl max-w-6xl w-full max-h-[90vh] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/5">
          <div>
            <h2 className="text-xl font-black text-white uppercase tracking-wider">Résultats du Backtest</h2>
            <p className="text-xs text-gray-500 font-bold mt-1">Analyse détaillée des performances historiques.</p>
          </div>
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2">
              <button
                onClick={() => handleDownload('pdf')}
                className="bg-[#D4AF37] hover:bg-[#c5a059] text-black font-black uppercase tracking-wider text-[10px] px-4 py-2 rounded-xl transition-all"
              >
                PDF
              </button>
              <button
                onClick={() => handleDownload('csv')}
                className="bg-white/5 border border-white/10 text-white hover:bg-white/10 font-bold uppercase tracking-wider text-[10px] px-4 py-2 rounded-xl transition-all"
              >
                CSV
              </button>
              <button
                onClick={() => handleDownload('json')}
                className="bg-white/5 border border-white/10 text-white hover:bg-white/10 font-bold uppercase tracking-wider text-[10px] px-4 py-2 rounded-xl transition-all"
              >
                JSON
              </button>
            </div>
            <button
              onClick={onClose}
              className="p-2 text-gray-500 hover:text-white hover:bg-white/[0.03] rounded-xl transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b border-white/5 bg-[#050507]">
          <nav className="flex space-x-8 px-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`py-4 px-1 border-b-2 font-black text-xs uppercase tracking-wider flex items-center space-x-2 transition-all ${
                  activeTab === tab.id
                    ? 'border-[#D4AF37] text-[#D4AF37]'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                <span>{tab.name}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[60vh] bg-[#050507]">
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              
              <div className="bg-[#0a0a0c] rounded-xl p-5 border border-white/5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">Profit Net</p>
                    <p className="text-2xl font-black text-green-500">
                      ${result.netProfit.toFixed(2)}
                    </p>
                  </div>
                  <DollarSign className="w-8 h-8 text-green-500" />
                </div>
              </div>

              <div className="bg-[#0a0a0c] rounded-xl p-5 border border-white/5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">Taux de Réussite</p>
                    <p className="text-2xl font-black text-[#D4AF37]">
                      {result.winRate.toFixed(1)}%
                    </p>
                  </div>
                  <Target className="w-8 h-8 text-[#D4AF37]" />
                </div>
              </div>

              <div className="bg-[#0a0a0c] rounded-xl p-5 border border-white/5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">Total Trades</p>
                    <p className="text-2xl font-black text-white">
                      {result.totalTrades}
                    </p>
                  </div>
                  <BarChart3 className="w-8 h-8 text-gray-400" />
                </div>
              </div>

              <div className="bg-[#0a0a0c] rounded-xl p-5 border border-white/5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">Ratio Sharpe</p>
                    <p className="text-2xl font-black text-yellow-500">
                      {result.sharpeRatio.toFixed(2)}
                    </p>
                  </div>
                  <TrendingUp className="w-8 h-8 text-yellow-500" />
                </div>
              </div>

              <div className="bg-[#0a0a0c] rounded-xl p-5 border border-white/5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">Drawdown Max</p>
                    <p className="text-2xl font-black text-red-500">
                      {result.maxDrawdown.toFixed(1)}%
                    </p>
                  </div>
                  <TrendingDown className="w-8 h-8 text-red-500" />
                </div>
              </div>

              <div className="bg-[#0a0a0c] rounded-xl p-5 border border-white/5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">Facteur Profit</p>
                    <p className="text-2xl font-black text-[#D4AF37]">
                      {result.profitFactor.toFixed(2)}
                    </p>
                  </div>
                  <DollarSign className="w-8 h-8 text-[#D4AF37]" />
                </div>
              </div>

              <div className="bg-[#0a0a0c] rounded-xl p-5 border border-white/5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">Gain Moyen</p>
                    <p className="text-2xl font-black text-green-400">
                      ${result.avgWin.toFixed(2)}
                    </p>
                  </div>
                  <TrendingUp className="w-8 h-8 text-green-400" />
                </div>
              </div>

              <div className="bg-[#0a0a0c] rounded-xl p-5 border border-white/5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">Perte Moyenne</p>
                    <p className="text-2xl font-black text-red-400">
                      ${result.avgLoss.toFixed(2)}
                    </p>
                  </div>
                  <TrendingDown className="w-8 h-8 text-red-400" />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'trades' && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-bold">
                <thead>
                  <tr className="border-b border-white/10 text-gray-500 uppercase text-[10px] tracking-wider">
                    <th className="text-left py-3 px-4">ID</th>
                    <th className="text-left py-3 px-4">Paire</th>
                    <th className="text-left py-3 px-4">Direction</th>
                    <th className="text-left py-3 px-4">Entrée</th>
                    <th className="text-left py-3 px-4">Sortie</th>
                    <th className="text-left py-3 px-4">Résultat</th>
                    <th className="text-left py-3 px-4">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.slice(0, 50).map((trade, index) => (
                    <tr key={trade.id} className="border-b border-white/[0.02] hover:bg-white/[0.02] transition-colors text-white">
                      <td className="py-3 px-4 text-gray-500">
                        #{index + 1}
                      </td>
                      <td className="py-3 px-4 uppercase">
                        {trade.signal.pair}
                      </td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${
                          trade.direction === 'CALL' 
                            ? 'bg-green-500/10 text-green-500' 
                            : 'bg-red-500/10 text-red-500'
                        }`}>
                          {trade.direction}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono">
                        {trade.entryPrice.toFixed(4)}
                      </td>
                      <td className="py-3 px-4 font-mono">
                        {trade.exitPrice.toFixed(4)}
                      </td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${
                          trade.result === 'WIN' 
                            ? 'bg-green-500/10 text-green-500' 
                            : 'bg-red-500/10 text-red-500'
                        }`}>
                          {trade.result}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`font-black ${
                          trade.netProfit > 0 ? 'text-green-500' : 'text-red-500'
                        }`}>
                          {trade.netProfit > 0 ? '+' : ''}${trade.netProfit.toFixed(2)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'metrics' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 text-xs font-bold text-gray-400">
              <div>
                <h3 className="text-sm font-black text-[#D4AF37] uppercase tracking-wider mb-4">Métriques de Performance</h3>
                <div className="space-y-3">
                  <div className="flex justify-between border-b border-white/[0.02] pb-2">
                    <span>Trades Gagnants</span>
                    <span className="text-white font-black">{result.winningTrades}</span>
                  </div>
                  <div className="flex justify-between border-b border-white/[0.02] pb-2">
                    <span>Trades Perdants</span>
                    <span className="text-white font-black">{result.losingTrades}</span>
                  </div>
                  <div className="flex justify-between border-b border-white/[0.02] pb-2">
                    <span>Plus Gros Gain</span>
                    <span className="text-green-500 font-black">${result.largestWin.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between border-b border-white/[0.02] pb-2">
                    <span>Plus Grosse Perte</span>
                    <span className="text-red-500 font-black">${result.largestLoss.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between border-b border-white/[0.02] pb-2">
                    <span>Série Gagnante Max</span>
                    <span className="text-white font-black">{result.consecutiveWins}</span>
                  </div>
                  <div className="flex justify-between border-b border-white/[0.02] pb-2">
                    <span>Série Perdante Max</span>
                    <span className="text-white font-black">{result.consecutiveLosses}</span>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-black text-[#D4AF37] uppercase tracking-wider mb-4">Métriques de Risque</h3>
                <div className="space-y-3">
                  <div className="flex justify-between border-b border-white/[0.02] pb-2">
                    <span>Profit Total</span>
                    <span className="text-green-500 font-black">${result.totalProfit.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between border-b border-white/[0.02] pb-2">
                    <span>Perte Totale</span>
                    <span className="text-red-500 font-black">${result.totalLoss.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between border-b border-white/[0.02] pb-2">
                    <span>Ratio Gain/Perte</span>
                    <span className="text-white font-black">{(result.avgWin / result.avgLoss).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between border-b border-white/[0.02] pb-2">
                    <span>Facteur de Profit</span>
                    <span className="text-white font-black">{result.profitFactor.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between border-b border-white/[0.02] pb-2">
                    <span>Ratio de Sharpe</span>
                    <span className="text-white font-black">{result.sharpeRatio.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between border-b border-white/[0.02] pb-2">
                    <span>Drawdown Maximum</span>
                    <span className="text-red-500 font-black">{result.maxDrawdown.toFixed(1)}%</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}