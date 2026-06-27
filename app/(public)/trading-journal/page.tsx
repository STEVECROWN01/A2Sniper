'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, BarChart3, Target, DollarSign, Info, Trash2, ArrowUpRight, ArrowDownRight, AlertTriangle, Loader2, Download, Check } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useAppStore } from '@/lib/store';
import { toast } from 'sonner';
import { createBrandedPDF, drawSectionTitle, drawStatCard, drawTable, drawInfoRow, drawUserInfoCard, drawRiskBadge, savePDF, PAGE, checkPageBreak, PDFUserInfo, fetchAvatarBase64 } from '@/lib/pdf-export';

interface TradeEntry {
  result: string;
  amount: number;
  return: number;
}

interface SessionData {
  trades: TradeEntry[];
  payout: number;
  initialCapital: number;
  sessionCounter: number;
}

interface Stats {
  wins: number;
  losses: number;
  profit: number;
  balance: number;
  capital: number;
  totalTrades: number;
  winRate: number;
}

export default function TradingJournalPage() {
  useAuth();
  const { user } = useAppStore();
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [justExported, setJustExported] = useState(false);

  const loadSession = () => {
    const saved = localStorage.getItem('a2sniper_risk_session');
    if (saved) {
      try {
        setSessionData(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse trading journal session data', e);
      }
    } else {
      setSessionData(null);
    }
  };

  useEffect(() => {
    loadSession();
    // Listen to cross-tab localStorage changes
    window.addEventListener('storage', loadSession);
    // Also listen for same-tab custom dispatches from Risk Manager
    const handleCustomStorage = (e: StorageEvent) => {
      if (e.key === 'a2sniper_risk_session') {
        loadSession();
      }
    };
    window.addEventListener('storage', handleCustomStorage);
    // Poll every 2s as a fallback for same-tab updates
    const interval = setInterval(loadSession, 2000);
    return () => {
      window.removeEventListener('storage', loadSession);
      window.removeEventListener('storage', handleCustomStorage);
      clearInterval(interval);
    };
  }, []);

  const getStats = (): Stats => {
    if (!sessionData) return { wins: 0, losses: 0, profit: 0, balance: 0, capital: 0, totalTrades: 0, winRate: 0 };
    let wins = 0;
    let losses = 0;
    let profit = 0;
    
    sessionData.trades.forEach((t: TradeEntry) => {
      if (t.result === 'WIN' && t.amount > 0) {
        wins++;
        profit += t.amount * (sessionData.payout / 100);
      } else if (t.result === 'LOSS' && t.amount > 0) {
        losses++;
        profit -= t.amount;
      }
    });

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    return {
      wins,
      losses,
      profit,
      balance: sessionData.initialCapital + profit,
      capital: sessionData.initialCapital,
      totalTrades,
      winRate
    };
  };

  const stats = getStats();
  const validTrades = sessionData ? sessionData.trades.filter((t: TradeEntry) => t.result && t.amount > 0) : [];

  const handleResetJournal = () => {
    setShowResetConfirm(true);
  };

  const confirmResetJournal = () => {
    setIsResetting(true);
    setTimeout(() => {
      localStorage.removeItem('a2sniper_risk_session');
      localStorage.removeItem('a2sniper_risk_trades');
      setSessionData(null);
      setIsResetting(false);
      setShowResetConfirm(false);
      toast.success("Trading Journal réinitialisé avec succès.", { duration: 3000 });
    }, 800);
  };

  // ── Export PDF ──
  const handleExportPDF = async () => {
    if (!sessionData) return;

    // Pre-load user avatar if available
    if (user?.avatar) {
      await fetchAvatarBase64(user.avatar);
    }

    const pdfUser: PDFUserInfo = {
      name: user?.name,
      email: user?.email,
      plan: user?.plan,
      userId: user?.id,
      avatarUrl: user?.avatar,
    };

    const doc = createBrandedPDF('Trading Journal', 'Trading Journal et performances', pdfUser);
    let y = 58;

    // User info card
    y = drawUserInfoCard(doc, y, pdfUser);

    // Session Info Section
    y = drawSectionTitle(doc, 'Informations Session', y);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Session', `#${sessionData.sessionCounter}`);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Capital Initial', `$${sessionData.initialCapital.toFixed(2)}`);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Payout', `${sessionData.payout}%`, { valueColor: '#D4AF37' });
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Total Trades', `${stats.totalTrades}`);
    y += 2;

    // Performance Stats
    y = drawSectionTitle(doc, 'Performances', y);
    const cardW = 42;
    const gap = 3;
    y = drawStatCard(doc, PAGE.marginL, y, cardW, 'Capital Initial', `$${stats.capital.toFixed(2)}`);
    y = drawStatCard(doc, PAGE.marginL + cardW + gap, y - 21, cardW, 'Balance Actuelle', `$${stats.balance.toFixed(2)}`, { valueColor: '#D4AF37' });
    y = drawStatCard(doc, PAGE.marginL + (cardW + gap) * 2, y - 21, cardW, 'Net Profit / Loss', `${stats.profit >= 0 ? '+' : ''}$${stats.profit.toFixed(2)}`, { valueColor: stats.profit >= 0 ? '#22C55E' : '#EF4444' });
    y = drawStatCard(doc, PAGE.marginL + (cardW + gap) * 3, y - 21, cardW, 'Win Rate', `${stats.winRate.toFixed(1)}%`, { valueColor: '#D4AF37' });
    y += 3;

    // Win/Loss Breakdown
    y = drawSectionTitle(doc, 'Répartition des Trades', y);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Trades Réussis (WIN)', `${stats.wins}`, { valueColor: '#22C55E' });
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Trades Perdus (LOSS)', `${stats.losses}`, { valueColor: '#EF4444' });
    y += 2;

    // Risk Level
    const riskLevel = stats.totalTrades < 5 ? 'Medium' : stats.profit < -sessionData.initialCapital * 0.2 ? 'Critical' : stats.profit < -sessionData.initialCapital * 0.1 || stats.winRate < 45 ? 'High' : stats.profit < 0 || stats.winRate < 55 ? 'Medium' : 'Low';
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Niveau de Risque', '');
    drawRiskBadge(doc, PAGE.marginL + 50, y - 1, riskLevel);
    y += 6;

    // Trades Table
    if (validTrades.length > 0) {
      y = checkPageBreak(doc, y, 30);
      y = drawSectionTitle(doc, 'Historique Détaillé des Trades', y);

      const headers = [
        { label: '#', width: 12 },
        { label: 'Result', width: 22, align: 'center' as const },
        { label: 'Mise ($)', width: 28, align: 'right' as const },
        { label: 'Profit / Perte ($)', width: 35, align: 'right' as const },
        { label: 'Cumul ($)', width: 28, align: 'right' as const },
      ];

      let runningProfit = 0;
      const rows = validTrades.map((t: TradeEntry, i: number) => {
        const profitLoss = t.result === 'WIN' ? t.amount * (sessionData.payout / 100) : -t.amount;
        runningProfit += profitLoss;
        return [
          `#${i + 1}`,
          t.result,
          t.amount.toFixed(2),
          profitLoss >= 0 ? `+${profitLoss.toFixed(2)}` : `${profitLoss.toFixed(2)}`,
          runningProfit >= 0 ? `+${runningProfit.toFixed(2)}` : `${runningProfit.toFixed(2)}`,
        ];
      });
      y = drawTable(doc, PAGE.marginL, y, headers, rows);
    }

    const dateStr = new Date().toISOString().split('T')[0];
    savePDF(doc, `a2sniper-journal-${dateStr}.pdf`, pdfUser);
    setJustExported(true);
    setTimeout(() => setJustExported(false), 2500);
    toast.success('Rapport PDF du journal exporté avec succès !');
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black text-white uppercase tracking-tight">
            Trading Journal
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Analysisz vos performances et journal de trading basés sur votre session active.
          </p>
        </div>
        {sessionData && (
          <div className="flex items-center gap-3">
            <button
              onClick={handleExportPDF}
              className={`px-6 py-2.5 rounded-xl text-xs font-black flex items-center gap-2 transition-all ${justExported ? 'bg-green-500 shadow-lg shadow-green-500/20' : 'bg-[#D4AF37] hover:bg-[#c5a059] shadow-lg shadow-[#D4AF37]/20'} text-black`}
            >
              {justExported ? <Check className="w-4 h-4" /> : <Download className="w-4 h-4 text-black" />}
              {justExported ? 'EXPORTÉ !' : 'EXPORTER PDF'}
            </button>
            <button
              onClick={handleResetJournal}
              className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 rounded-xl text-xs font-black uppercase tracking-wider transition-all border border-red-500/20 active:scale-95"
            >
              <Trash2 className="w-4 h-4" />
              Réinitialiser
            </button>
          </div>
        )}
      </div>

      {!sessionData ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-[#0a0a0c]/80 border border-white/5 rounded-3xl p-12 text-center max-w-2xl mx-auto backdrop-blur-md"
        >
          <div className="w-16 h-16 bg-white/[0.02] border border-white/5 rounded-2xl flex items-center justify-center mx-auto mb-6 text-gray-500">
            <Calendar className="w-8 h-8" />
          </div>
          <h2 className="text-lg font-black text-white uppercase mb-2">Aucune session active</h2>
          <p className="text-sm text-gray-400 font-bold mb-6 max-w-md mx-auto leading-relaxed">
            Pour voir vos statistiques et historique de trades, veuillez d&apos;abord configurer et sauvegarder une session dans le Risk Manager (via le Bot Telegram ou l&apos;onglet Risk Manager).
          </p>
        </motion.div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Summary Cards */}
          <div className="lg:col-span-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { label: 'Capital Initial', value: `$${stats.capital.toFixed(2)}`, icon: DollarSign, color: 'text-gray-400 bg-white/[0.02]' },
              { label: 'Balance Actuelle', value: `$${stats.balance.toFixed(2)}`, icon: BarChart3, color: 'text-[#D4AF37] bg-[#D4AF37]/10' },
              { label: 'Net Profit / Loss', value: `${stats.profit >= 0 ? '+' : ''}$${stats.profit.toFixed(2)}`, icon: Target, color: stats.profit >= 0 ? 'text-green-500 bg-green-500/10' : 'text-red-500 bg-red-500/10' },
              { label: 'Win Rate Global', value: `${stats.winRate.toFixed(1)}%`, icon: Target, color: 'text-[#D4AF37] bg-[#D4AF37]/10' }
            ].map((stat, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.1 }}
                className="bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-2xl backdrop-blur-md flex items-center justify-between"
              >
                <div>
                  <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">{stat.label}</p>
                  <p className="text-2xl font-black text-white tracking-tight">{stat.value}</p>
                </div>
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${stat.color}`}>
                  <stat.icon className="w-5 h-5" />
                </div>
              </motion.div>
            ))}
          </div>

          {/* Left panel: Session details */}
          <div className="lg:col-span-4 space-y-6">
            <div className="bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-3xl backdrop-blur-md space-y-4">
              <h3 className="text-sm font-black text-white uppercase tracking-wider border-b border-white/5 pb-3">Informations Session</h3>
              <div className="space-y-3 font-bold text-xs">
                <div className="flex justify-between text-gray-400">
                  <span>Numéro Session :</span>
                  <span className="text-white">Session {sessionData.sessionCounter}</span>
                </div>
                <div className="flex justify-between text-gray-400">
                  <span>Payout Session :</span>
                  <span className="text-[#D4AF37]">{sessionData.payout}%</span>
                </div>
                <div className="flex justify-between text-gray-400">
                  <span>Total Trades :</span>
                  <span className="text-white">{stats.totalTrades}</span>
                </div>
                <div className="flex justify-between text-gray-400">
                  <span>Trades Réussis (WIN) :</span>
                  <span className="text-green-500">{stats.wins}</span>
                </div>
                <div className="flex justify-between text-gray-400">
                  <span>Trades Perdus (LOSS) :</span>
                  <span className="text-red-500">{stats.losses}</span>
                </div>
              </div>
            </div>

            <div className="bg-[#D4AF37]/5 border border-[#D4AF37]/10 p-5 rounded-2xl flex items-start gap-3">
              <Info className="w-5 h-5 text-[#D4AF37] flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-gray-400 font-bold leading-relaxed">
                Ce journal est directement synchronisé avec le Risk Manager. Vos trades saisis dans le simulateur ou le risk manager se reflètent automatiquement ici.
              </p>
            </div>
          </div>

          {/* Right panel: Detailed list */}
          <div className="lg:col-span-8 bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-3xl backdrop-blur-md space-y-6">
            <h3 className="text-sm font-black text-white uppercase tracking-wider">Historique Détaillé des Trades</h3>
            {validTrades.length === 0 ? (
              <p className="text-xs text-gray-500 font-bold italic text-center py-12 bg-[#050507]/40 rounded-2xl border border-white/5">
                Aucun trade enregistré dans cette session active.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {validTrades.map((t: TradeEntry, idx: number) => {
                  const isWin = t.result === 'WIN';
                  const profitLoss = isWin ? t.amount * (sessionData.payout / 100) : -t.amount;
                  return (
                    <motion.div
                      key={idx}
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      className={`flex items-center justify-between bg-[#050507]/60 border p-4 rounded-2xl hover:border-white/10 transition-colors ${
                        isWin ? 'border-green-500/10' : 'border-red-500/10'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-xs ${
                          isWin ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
                        }`}>
                          #{idx + 1}
                        </div>
                        <div>
                          <p className="text-xs font-black text-white">Mise: ${t.amount}</p>
                          <p className={`text-[9px] font-black uppercase tracking-wider ${isWin ? 'text-green-500' : 'text-red-500'}`}>
                            {t.result}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className={`text-base font-black ${isWin ? 'text-green-400' : 'text-red-400'}`}>
                          {isWin ? '+' : ''}${profitLoss.toFixed(2)}
                        </p>
                        {isWin ? (
                          <ArrowUpRight className="w-4 h-4 text-green-500" />
                        ) : (
                          <ArrowDownRight className="w-4 h-4 text-red-500" />
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      {/* Reset Confirmation Dialog */}
      <AnimatePresence>
        {showResetConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={() => !isResetting && setShowResetConfirm(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#0A0B0E] border border-red-500/30 rounded-2xl p-8 max-w-md w-full"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-4">
                <AlertTriangle className="w-6 h-6 text-red-500" />
                <h3 className="text-lg font-bold text-white">Réinitialiser le journal</h3>
              </div>
              <p className="text-sm text-gray-400 mb-6 leading-relaxed">
                Voulez-vous vraiment réinitialiser le journal de trading ? Toutes les données de session et l&apos;historique des trades seront définitivement effacés.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={confirmResetJournal}
                  disabled={isResetting}
                  className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-lg font-bold transition-colors flex items-center justify-center gap-2"
                >
                  {isResetting ? <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Réinitialisation...
                  </> : 'Confirmer'}
                </button>
                <button
                  onClick={() => setShowResetConfirm(false)}
                  disabled={isResetting}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 px-4 py-2.5 rounded-lg font-bold transition-colors"
                >
                  Annuler
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
