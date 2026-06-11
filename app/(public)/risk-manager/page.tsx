'use client';

import { useState, useMemo, useEffect } from 'react';
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
  DollarSign,
  Loader2,
  AlertTriangle
} from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '@/lib/store';
import { useAuth } from '@/hooks/use-auth';

type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';

function calculateRiskLevel(winRate: number, totalTrades: number, accountGain: number): RiskLevel {
  if (totalTrades < 5) return 'Medium'; // Not enough data
  if (accountGain < -20) return 'Critical';
  if (accountGain < -10 || winRate < 45) return 'High';
  if (accountGain < 0 || winRate < 55) return 'Medium';
  return 'Low';
}

function getRiskLevelStyle(level: RiskLevel) {
  switch (level) {
    case 'Low': return { text: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/20' };
    case 'Medium': return { text: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/20' };
    case 'High': return { text: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20' };
    case 'Critical': return { text: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' };
  }
}

export default function RiskManagerPage() {
  useAuth();
  const { userStats, fetchPerformance } = useAppStore();
  const [initialCapital, setInitialCapital] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('a2sniper_risk_capital');
      if (saved) { try { return Number(saved); } catch {} }
    }
    return 1000;
  });
  const [payout, setPayout] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('a2sniper_risk_payout');
      if (saved) { try { return Number(saved); } catch {} }
    }
    return 80;
  });
  const [trades, setTrades] = useState<any[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('a2sniper_risk_trades');
      if (saved) { try { return JSON.parse(saved); } catch {} }
    }
    return Array(10).fill({ result: '', amount: 0, return: 0 });
  });
  const [sessionCounter, setSessionCounter] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [apiWinRate, setApiWinRate] = useState<number | null>(null);

  // Fetch performance data for real winrate
  useEffect(() => {
    const loadData = async () => {
      try {
        await fetchPerformance();
        if (userStats?.winRate && userStats.winRate > 0) {
          setApiWinRate(userStats.winRate);
        }
      } catch {}
    };
    loadData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    const accountGain = initialCapital > 0 ? ((currentBalance - initialCapital) / initialCapital) * 100 : 0;

    return { computedTrades, wins, losses, totalProfit, currentBalance, winRate, accountGain, totalStake };
  }, [trades, initialCapital, payout]);

  // Use API winrate if available, otherwise fall back to local calculation
  const displayWinRate = apiWinRate !== null && apiWinRate > 0 ? apiWinRate : results.winRate;
  const riskLevel = calculateRiskLevel(displayWinRate, results.wins + results.losses, results.accountGain);
  const riskStyle = getRiskLevelStyle(riskLevel);

  const handleUpdateTrade = (idx: number, field: string, val: string | number | boolean) => {
    const newTrades = [...trades];
    // Validate negative amounts
    if (field === 'amount' && typeof val === 'number' && val < 0) {
      toast.error('Le montant ne peut pas être négatif.');
      return;
    }
    newTrades[idx] = { ...newTrades[idx], [field]: val };
    setTrades(newTrades);
    localStorage.setItem('a2sniper_risk_trades', JSON.stringify(newTrades));
  };

  const addTradeRow = () => {
    const newTrades = [...trades, { result: '', amount: 0, return: 0 }];
    setTrades(newTrades);
    localStorage.setItem('a2sniper_risk_trades', JSON.stringify(newTrades));
  };

  const clearSession = () => {
    toast.custom((t) => (
      <div className="bg-[#0a0a0c] border border-red-500/30 p-6 rounded-2xl shadow-xl max-w-sm">
        <p className="text-white font-bold mb-4">Voulez-vous vraiment réinitialiser la session actuelle ?</p>
        <div className="flex gap-3">
          <button
            onClick={() => {
              setTrades(Array(10).fill({ result: '', amount: 0, return: 0 }));
              setSessionCounter(0);
              localStorage.removeItem('a2sniper_risk_trades');
              toast.success("Session réinitialisée");
              toast.dismiss(t);
            }}
            className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-bold text-xs hover:bg-red-700 transition-colors"
          >
            Confirmer
          </button>
          <button
            onClick={() => toast.dismiss(t)}
            className="flex-1 px-4 py-2 bg-gray-800 text-gray-300 rounded-lg font-bold text-xs hover:bg-gray-700 transition-colors"
          >
            Annuler
          </button>
        </div>
      </div>
    ), { duration: Infinity });
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const res = await fetch(`${apiUrl}/api/risk/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          initial_capital: initialCapital,
          payout,
          trades: trades.filter(t => t.result && t.amount > 0),
          session_counter: sessionCounter,
        }),
      });
      if (res.ok) {
        toast.success('Paramètres sauvegardés avec succès !');
      } else {
        // Save locally even if API fails
        localStorage.setItem('a2sniper_risk_capital', String(initialCapital));
        localStorage.setItem('a2sniper_risk_payout', String(payout));
        localStorage.setItem('a2sniper_risk_trades', JSON.stringify(trades));
        toast.success('Paramètres sauvegardés localement.');
      }
    } catch {
      // Save locally when API is unavailable
      localStorage.setItem('a2sniper_risk_capital', String(initialCapital));
      localStorage.setItem('a2sniper_risk_payout', String(payout));
      localStorage.setItem('a2sniper_risk_trades', JSON.stringify(trades));
      toast.success('Paramètres sauvegardés localement (API indisponible).');
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportJSON = () => {
    const exportData = {
      exportDate: new Date().toISOString(),
      settings: { initialCapital, payout, sessionCounter },
      riskAnalysis: {
        winRate: displayWinRate,
        riskLevel,
        totalProfit: results.totalProfit,
        accountGain: results.accountGain,
        wins: results.wins,
        losses: results.losses,
      },
      trades: results.computedTrades.filter(t => t.result),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `a2sniper-risk-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Données exportées en JSON.');
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
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="px-4 py-2 bg-[#121216] hover:bg-[#1a1a1f] border border-gray-800 rounded-xl text-xs font-black text-white flex items-center gap-2 transition-all disabled:opacity-50"
              >
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4 text-[#D4AF37]" />}
                SAUVEGARDER
              </button>
              <button
                onClick={handleExportJSON}
                className="px-6 py-2 bg-[#D4AF37] hover:bg-[#c5a059] rounded-xl text-xs font-black text-black flex items-center gap-2 transition-all shadow-lg shadow-[#D4AF37]/20"
              >
                <Download className="w-4 h-4 text-black" /> EXPORTER JSON
              </button>
            </div>
          </div>

          {/* Main Grid */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">

            {/* Left: Tracker */}
            <div className="xl:col-span-8 space-y-6">

              {/* Stats Bar */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
                  <p className="text-2xl font-black text-[#D4AF37] tracking-tight">
                    {displayWinRate > 0 ? `${displayWinRate.toFixed(1)}%` : 'N/A'}
                  </p>
                </div>
                <div className="bg-[#0a0a0c] p-6 rounded-3xl border border-gray-800/50">
                  <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">Gain Compte</p>
                  <p className={`text-2xl font-black tracking-tight ${results.accountGain >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {results.accountGain >= 0 ? '+' : ''}{results.accountGain.toFixed(2)}%
                  </p>
                </div>
                <div className={`bg-[#0a0a0c] p-6 rounded-3xl border border-gray-800/50`}>
                  <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">Niveau de Risque</p>
                  <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-lg ${riskStyle.bg} ${riskStyle.border} border`}>
                    {riskLevel === 'High' || riskLevel === 'Critical' ? (
                      <AlertTriangle className={`w-4 h-4 ${riskStyle.text}`} />
                    ) : (
                      <ShieldAlert className={`w-4 h-4 ${riskStyle.text}`} />
                    )}
                    <span className={`text-lg font-black ${riskStyle.text}`}>
                      {riskLevel === 'Low' ? 'Faible' : riskLevel === 'Medium' ? 'Moyen' : riskLevel === 'High' ? 'Élevé' : 'Critique'}
                    </span>
                  </div>
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
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setInitialCapital(val);
                          localStorage.setItem('a2sniper_risk_capital', String(val));
                        }}
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
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setPayout(val);
                          localStorage.setItem('a2sniper_risk_payout', String(val));
                        }}
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
                  Basé sur votre Winrate actuel de <span className="text-green-400">{displayWinRate > 0 ? displayWinRate.toFixed(1) : 'N/A'}%</span>, la mise suggérée pour une croissance optimale :
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
              <div className={`p-6 rounded-[2rem] border ${riskStyle.border} ${riskStyle.bg}`}>
                <div className="flex items-start gap-4">
                  <ShieldAlert className={`w-6 h-6 ${riskStyle.text} flex-shrink-0`} />
                  <div>
                    <h4 className={`text-xs font-black ${riskStyle.text} uppercase tracking-widest mb-1`}>
                      Alerte Risk Management — Niveau: {riskLevel === 'Low' ? 'Faible' : riskLevel === 'Medium' ? 'Moyen' : riskLevel === 'High' ? 'Élevé' : 'Critique'}
                    </h4>
                    <p className="text-[10px] text-gray-500 font-bold leading-relaxed">
                      {riskLevel === 'Critical'
                        ? 'Votre compte est en perte significative. Réduisez immédiatement la taille de vos positions et envisagez de faire une pause.'
                        : riskLevel === 'High'
                        ? 'Votre winrate ou votre gain est négatif. Réduisez la taille des mises et respectez le plan de gestion du risque.'
                        : riskLevel === 'Medium'
                        ? 'Données insuffisantes ou performances mitigées. La discipline est essentielle — ne dépassez pas 5% du capital par trade.'
                        : 'Ne dépassez jamais 10% de votre capital sur un seul trade, même avec une précision sniper. La discipline est la clé du succès.'
                      }
                    </p>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
  );
}
