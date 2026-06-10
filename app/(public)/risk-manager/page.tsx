'use client';

import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';

import { 
  Calculator, 
  TrendingUp, 
  TrendingDown, 
  RefreshCw, 
  Save, 
  Download, 
  Target, 
  ShieldAlert, 
  Plus, 
  Trash2, 
  ArrowUpRight, 
  ArrowDownRight,
  ChevronRight,
  Zap,
  DollarSign
} from 'lucide-react';
import { toast } from 'sonner';

export default function RiskManagerPage() {
  const [initialCapital, setInitialCapital] = useState(1000);
  const [payout, setPayout] = useState(92);
  const [trades, setTrades] = useState<any[]>(Array(10).fill({ result: '', amount: 0, return: 0 }));
  const [sessionCounter, setSessionCounter] = useState(0);

  const results = useMemo(() => {
    let currentBalance = initialCapital;
    let wins = 0;
    let losses = 0;
    let totalProfit = 0;
    let totalStake = 0;

    const computedTrades = trades.map(trade => {
      if (!trade.result || trade.amount <= 0) return { ...trade, balance: '-' };
      
      totalStake += trade.amount;
      let res = 0;
      if (trade.result === 'WIN') {
        res = trade.amount * (payout / 100);
        currentBalance += res;
        wins++;
        totalProfit += res;
      } else {
        res = -trade.amount;
        currentBalance += res;
        losses++;
        totalProfit += res;
      }
      return { ...trade, return: Math.abs(res), balance: currentBalance.toFixed(2) };
    });

    const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;
    const accountGain = ((currentBalance - initialCapital) / initialCapital) * 100;

    return { computedTrades, wins, losses, totalProfit, currentBalance, winRate, accountGain, totalStake };
  }, [trades, initialCapital, payout]);

  const handleUpdateTrade = (idx: number, field: string, val: any) => {
    const newTrades = [...trades];
    newTrades[idx] = { ...newTrades[idx], [field]: val };
    setTrades(newTrades);
  };

  const addTradeRow = () => {
    setTrades([...trades, { result: '', amount: 0, return: 0 }]);
  };

  const clearSession = () => {
    if (confirm("Voulez-vous vraiment réinitialiser la session actuelle ?")) {
      setTrades(Array(10).fill({ result: '', amount: 0, return: 0 }));
      setSessionCounter(0);
      toast.success("Session réinitialisée");
    }
  };

  return (
    <div className="space-y-8">
          
          {/* Header */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-12">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-[#D4AF37]/10 p-2 rounded-lg border border-[#D4AF37]/20">
                  <Calculator className="w-5 h-5 text-[#D4AF37]" />
                </div>
                <h1 className="text-2xl font-black text-white uppercase tracking-tight">Advanced Risk Manager</h1>
              </div>
              <p className="text-gray-400 font-medium">Gestionnaire de capital professionnel A2Sniper 3.0</p>
            </motion.div>

            <div className="flex items-center gap-3">
              <button 
                onClick={clearSession}
                className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-xl text-xs font-black text-red-400 flex items-center gap-2 transition-all"
              >
                <RefreshCw className="w-4 h-4" /> RESET
              </button>
              <button className="px-4 py-2 bg-[#121216] hover:bg-[#1a1a1f] border border-gray-800 rounded-xl text-xs font-black text-white flex items-center gap-2 transition-all">
                <Save className="w-4 h-4 text-[#D4AF37]" /> SAUVEGARDER
              </button>
              <button className="px-6 py-2 bg-[#D4AF37] hover:bg-[#c5a059] rounded-xl text-xs font-black text-black flex items-center gap-2 transition-all shadow-lg shadow-[#D4AF37]/20">
                <Download className="w-4 h-4 text-black" /> EXPORTER PDF
              </button>
            </div>
          </div>

          {/* Main Grid */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
            
            {/* Left: Tracker */}
            <div className="xl:col-span-8 space-y-6">
              
              {/* Stats Bar */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-[#0a0a0c] p-6 rounded-3xl border border-gray-800/50">
                  <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">Balance Actuelle</p>
                  <p className="text-2xl font-black text-white tracking-tight">${results.currentBalance.toFixed(2)}</p>
                </div>
                <div className="bg-[#0a0a0c] p-6 rounded-3xl border border-gray-800/50">
                  <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">Profit Net</p>
                  <p className={`text-2xl font-black tracking-tight ${results.totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {results.totalProfit >= 0 ? '+' : ''}${results.totalProfit.toFixed(2)}
                  </p>
                </div>
                <div className="bg-[#0a0a0c] p-6 rounded-3xl border border-gray-800/50">
                  <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">Win Rate</p>
                  <p className="text-2xl font-black text-[#D4AF37] tracking-tight">{results.winRate.toFixed(1)}%</p>
                </div>
                <div className="bg-[#0a0a0c] p-6 rounded-3xl border border-gray-800/50">
                  <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">Gain Compte</p>
                  <p className={`text-2xl font-black tracking-tight ${results.accountGain >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {results.accountGain >= 0 ? '+' : ''}{results.accountGain.toFixed(2)}%
                  </p>
                </div>
              </div>

              {/* Trade Table */}
              <div className="bg-[#0a0a0c] rounded-[2rem] border border-gray-800/50 overflow-hidden">
                <div className="p-6 border-b border-gray-800/50 flex justify-between items-center bg-[#0d0d0f]">
                  <h3 className="text-sm font-black text-white uppercase tracking-widest flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-[#D4AF37]" />
                    Journal de Trading
                  </h3>
                  <button 
                    onClick={addTradeRow}
                    className="p-2 bg-[#D4AF37]/10 hover:bg-[#D4AF37]/20 border border-[#D4AF37]/20 rounded-lg text-[#D4AF37] transition-all"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                </div>
                
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-black/40 text-[10px] font-black text-gray-600 uppercase tracking-[0.2em]">
                        <th className="px-6 py-4">#</th>
                        <th className="px-6 py-4">Résultat</th>
                        <th className="px-6 py-4">Stake ($)</th>
                        <th className="px-6 py-4 text-right">Retour ($)</th>
                        <th className="px-6 py-4 text-right">Balance ($)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800/30">
                      {results.computedTrades.map((trade, i) => (
                        <tr key={i} className="hover:bg-white/[0.02] transition-colors group">
                          <td className="px-6 py-4 text-xs font-black text-gray-600">{i + 1}</td>
                          <td className="px-6 py-4">
                            <div className="flex gap-2 w-32">
                              <button 
                                onClick={() => handleUpdateTrade(i, 'result', 'WIN')}
                                className={`flex-1 py-1.5 rounded-lg text-[10px] font-black transition-all ${trade.result === 'WIN' ? 'bg-green-500 text-white shadow-lg shadow-green-500/20' : 'bg-gray-800/50 text-gray-500 hover:text-gray-400'}`}
                              >
                                WIN
                              </button>
                              <button 
                                onClick={() => handleUpdateTrade(i, 'result', 'LOSS')}
                                className={`flex-1 py-1.5 rounded-lg text-[10px] font-black transition-all ${trade.result === 'LOSS' ? 'bg-red-500 text-white shadow-lg shadow-red-500/20' : 'bg-gray-800/50 text-gray-500 hover:text-gray-400'}`}
                              >
                                LOSS
                              </button>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <input 
                              type="number" 
                              value={trade.amount || ''}
                              onChange={(e) => handleUpdateTrade(i, 'amount', Number(e.target.value))}
                              placeholder="0.00"
                              className="w-24 bg-black/40 border border-gray-800 rounded-lg px-3 py-1.5 text-xs font-black text-white focus:border-[#D4AF37] outline-none"
                            />
                          </td>
                          <td className="px-6 py-4 text-right font-black text-xs">
                            {trade.result === 'WIN' ? (
                              <span className="text-green-400">+{trade.return.toFixed(2)}</span>
                            ) : trade.result === 'LOSS' ? (
                              <span className="text-red-400">-{trade.amount.toFixed(2)}</span>
                            ) : '-'}
                          </td>
                          <td className="px-6 py-4 text-right font-black text-xs text-[#D4AF37]">
                            {trade.balance === '-' ? '-' : `$${trade.balance}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Right: Sidebar Controls */}
            <div className="xl:col-span-4 space-y-8">
              
              {/* Session Config */}
              <div className="bg-[#0a0a0c] p-8 rounded-[2rem] border border-gray-800/50 space-y-6">
                <h3 className="text-sm font-black text-white uppercase tracking-widest mb-6">Configuration</h3>
                
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mb-2">Capital Initial</label>
                    <div className="relative">
                      <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600" />
                      <input 
                        type="number" 
                        value={initialCapital}
                        onChange={(e) => setInitialCapital(Number(e.target.value))}
                        className="w-full bg-black border border-gray-800 rounded-xl pl-10 pr-4 py-3 text-sm font-black text-white outline-none focus:border-[#D4AF37] transition-colors"
                      />
                    </div>
                  </div>
                  
                  <div>
                    <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mb-2">Payout Marché (%)</label>
                    <div className="relative">
                      <Zap className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-yellow-500" />
                      <input 
                        type="number" 
                        value={payout}
                        onChange={(e) => setPayout(Number(e.target.value))}
                        className="w-full bg-black border border-gray-800 rounded-xl pl-10 pr-4 py-3 text-sm font-black text-white outline-none focus:border-[#D4AF37] transition-colors"
                      />
                    </div>
                  </div>
                </div>

                <div className="pt-6 border-t border-gray-800/50">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-xs font-bold text-gray-400">Session Counter</span>
                    <div className="flex items-center gap-4 bg-black/40 p-1.5 rounded-xl border border-gray-800">
                      <button onClick={() => setSessionCounter(Math.max(0, sessionCounter - 1))} className="p-1 hover:bg-gray-800 rounded-lg text-gray-500 hover:text-white transition-colors">
                        <ChevronRight className="w-4 h-4 rotate-180" />
                      </button>
                      <span className="text-sm font-black text-white w-4 text-center">{sessionCounter}</span>
                      <button onClick={() => setSessionCounter(sessionCounter + 1)} className="p-1 hover:bg-gray-800 rounded-lg text-gray-500 hover:text-white transition-colors">
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Kelly Criterion Helper */}
              <div className="bg-gradient-to-br from-[#0a0a0c] to-[#D4AF37]/5 p-8 rounded-[2rem] border border-[#D4AF37]/20 relative overflow-hidden">
                <div className="absolute top-0 right-0 p-8 opacity-[0.05] pointer-events-none">
                  <Target className="w-32 h-32 text-[#D4AF37]" />
                </div>
                <h3 className="text-sm font-black text-white uppercase tracking-widest mb-4 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-yellow-500" />
                  Sniper Stake Helper
                </h3>
                <p className="text-xs text-gray-400 font-bold mb-6 leading-relaxed">
                  Basé sur un Winrate Assistant de <span className="text-green-400">99.99%</span>, la mise suggérée pour une croissance optimale :
                </p>
                <div className="bg-black/60 p-6 rounded-2xl border border-[#D4AF37]/30 text-center relative z-10">
                  <p className="text-[10px] font-black text-[#D4AF37] uppercase tracking-[0.2em] mb-1">Stake Conseillé</p>
                  <p className="text-3xl font-black text-white tracking-tighter">
                    ${(results.currentBalance * 0.05).toFixed(2)}
                  </p>
                  <p className="text-[9px] text-gray-500 font-bold mt-2 uppercase tracking-tighter">Growth Optimization (5% Capital)</p>
                </div>
              </div>

              {/* Risk Alert */}
              <div className="bg-red-500/5 p-6 rounded-[2rem] border border-red-500/20">
                <div className="flex items-start gap-4">
                  <ShieldAlert className="w-6 h-6 text-red-500 flex-shrink-0" />
                  <div>
                    <h4 className="text-xs font-black text-red-400 uppercase tracking-widest mb-1">Alerte Risk Management</h4>
                    <p className="text-[10px] text-gray-500 font-bold leading-relaxed">
                      Ne dépassez jamais 10% de votre capital sur un seul trade, même avec une précision sniper. La discipline est la clé du succès.
                    </p>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      );
    }
