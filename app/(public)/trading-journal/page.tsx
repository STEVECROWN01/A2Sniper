'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, BarChart3, Target, DollarSign, Info, Trash2, ArrowUpRight, ArrowDownRight, AlertTriangle, Loader2, Download, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useAppStore } from '@/lib/store';
import { toast } from 'sonner';
import { createBrandedPDF, drawSectionTitle, drawStatCard, drawTable, drawInfoRow, drawUserInfoCard, drawRiskBadge, savePDF, PAGE, checkPageBreak, PDFUserInfo, fetchAvatarBase64 } from '@/lib/pdf-export';

interface TradeEntry {
  result: string;
  amount: number;
  return: number;
  payout?: number;
}

interface SessionData {
  trades: TradeEntry[];
  payout: number;
  initialCapital: number;
  createdAt?: string;
  updatedAt?: string;
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
  const [allSessions, setAllSessions] = useState<SessionData[]>([]);
  const [currentSessionIdx, setCurrentSessionIdx] = useState(0);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [justExported, setJustExported] = useState(false);

  const loadSessions = () => {
    // Load ALL saved sessions from the array
    const savedAll = localStorage.getItem('a2sniper_risk_sessions');
    let arraySessions: SessionData[] = [];
    if (savedAll) {
      try {
        const parsed = JSON.parse(savedAll);
        if (Array.isArray(parsed) && parsed.length > 0) {
          arraySessions = parsed;
        }
      } catch (e) {
        console.error('Failed to parse trading journal sessions', e);
      }
    }

    // Also check the singular key for live (possibly unsaved) data from Risk Manager
    const savedSingle = localStorage.getItem('a2sniper_risk_session');
    let liveSession: SessionData | null = null;
    if (savedSingle) {
      try {
        liveSession = JSON.parse(savedSingle);
      } catch (e) {
        console.error('Failed to parse live session data', e);
      }
    }

    // If we have both, merge: use array sessions + check if live session is different from last saved
    if (arraySessions.length > 0 && liveSession) {
      // Check if live session matches the last saved session
      const lastSaved = arraySessions[arraySessions.length - 1];
      const isSame = lastSaved.sessionCounter === liveSession.sessionCounter &&
                     lastSaved.initialCapital === liveSession.initialCapital;
      if (isSame) {
        // Replace last saved with live data (has latest trade changes)
        arraySessions[arraySessions.length - 1] = liveSession;
      } else {
        // Live session is a NEW unsaved session — append it as a preview
        // But only if it has recorded trades
        const hasTrades = liveSession.trades && liveSession.trades.some((t: TradeEntry) => t.result && t.amount > 0);
        if (hasTrades) {
          arraySessions.push(liveSession);
        }
      }
      setAllSessions(arraySessions);
      setCurrentSessionIdx(prev => prev < arraySessions.length ? prev : arraySessions.length - 1);
      return;
    }

    // Only array sessions
    if (arraySessions.length > 0) {
      setAllSessions(arraySessions);
      setCurrentSessionIdx(prev => prev < arraySessions.length ? prev : arraySessions.length - 1);
      return;
    }

    // Only live session (no saved sessions)
    if (liveSession) {
      setAllSessions([liveSession]);
      setCurrentSessionIdx(0);
      return;
    }

    setAllSessions([]);
  };

  useEffect(() => {
    loadSessions();
    // Listen to cross-tab localStorage changes
    window.addEventListener('storage', loadSessions);
    // Also listen for same-tab custom dispatches from Risk Manager
    const handleCustomStorage = (e: StorageEvent) => {
      if (e.key === 'a2sniper_risk_session' || e.key === 'a2sniper_risk_sessions') {
        loadSessions();
      }
    };
    window.addEventListener('storage', handleCustomStorage);
    // Poll every 2s as a fallback for same-tab updates
    const interval = setInterval(loadSessions, 2000);
    return () => {
      window.removeEventListener('storage', loadSessions);
      window.removeEventListener('storage', handleCustomStorage);
      clearInterval(interval);
    };
  }, []);

  const sessionData = allSessions[currentSessionIdx] || null;

  const getStats = (): Stats => {
    if (!sessionData) return { wins: 0, losses: 0, profit: 0, balance: 0, capital: 0, totalTrades: 0, winRate: 0 };
    let wins = 0;
    let losses = 0;
    let profit = 0;
    
    sessionData.trades.forEach((t: TradeEntry) => {
      if (t.result === 'WIN' && t.amount > 0) {
        wins++;
        // Use per-row payout if set, otherwise fall back to session payout
        const rowPayout = (t.payout && t.payout > 0) ? t.payout : sessionData.payout;
        profit += t.amount * (rowPayout / 100);
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

  // Enter key support: when the Delete confirmation modal is open, pressing
  // Enter triggers the Delete action (same as clicking the Delete button).
  useEffect(() => {
    if (!showResetConfirm) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !isResetting) {
        e.preventDefault();
        confirmResetJournal();
      } else if (e.key === 'Escape' && !isResetting) {
        e.preventDefault();
        setShowResetConfirm(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showResetConfirm, isResetting]); // eslint-disable-line react-hooks/exhaustive-deps

  const confirmResetJournal = () => {
    setIsResetting(true);
    setTimeout(() => {
      // Remove current session from the sessions array
      if (currentSessionIdx >= 0 && currentSessionIdx < allSessions.length) {
        const updated = allSessions.filter((_, i) => i !== currentSessionIdx);
        setAllSessions(updated);
        localStorage.setItem('a2sniper_risk_sessions', JSON.stringify(updated));
        // Update legacy key
        if (updated.length > 0) {
          localStorage.setItem('a2sniper_risk_session', JSON.stringify(updated[updated.length - 1]));
        } else {
          localStorage.removeItem('a2sniper_risk_session');
        }
        setCurrentSessionIdx(Math.max(0, updated.length - 1));
      } else {
        localStorage.removeItem('a2sniper_risk_session');
      }
      setIsResetting(false);
      setShowResetConfirm(false);
      toast.success("Session removed from Trading Journal.", { duration: 3000 });
    }, 800);
  };

  // ── Export PDF ──
  const handleExportPDF = async () => {
    try {
      if (!sessionData) return;

      // Read the LATEST user from the store directly (not from the React closure
      // which may be stale if the component hasn't re-rendered after a store update).
      const currentUser = useAppStore.getState().user;

      // Pre-load user avatar if available (with safety timeout)
      if (currentUser?.avatar) {
        try {
          await fetchAvatarBase64(currentUser.avatar);
        } catch (avatarErr) {
          console.warn('[PDF EXPORT] Avatar pre-processing failed, using fallback:', avatarErr);
        }
      }

      const pdfUser: PDFUserInfo = {
        name: currentUser?.name || currentUser?.email?.split('@')[0] || 'User',
        email: currentUser?.email || '',
        plan: currentUser?.plan,
        userId: currentUser?.id,
        avatarUrl: currentUser?.avatar,
      };

      const doc = createBrandedPDF('Trading Journal', 'Trading Journal et performances', pdfUser);
      let y = 58;

      // User info card
      y = drawUserInfoCard(doc, y, pdfUser);

      // Session Info Section
      y = drawSectionTitle(doc, 'Session Information', y);
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Session', `#${sessionData.sessionCounter}`);
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Initial Capital', `$${sessionData.initialCapital.toFixed(2)}`);
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Payout', `${sessionData.payout}%`, { valueColor: '#D4AF37' });
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Total Trades', `${stats.totalTrades}`);
      if (sessionData.createdAt) {
        y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Created at', new Date(sessionData.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }));
      }
      if (sessionData.updatedAt && sessionData.updatedAt !== sessionData.createdAt) {
        y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Updated', new Date(sessionData.updatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }), { valueColor: '#D4AF37' });
      }
      y += 2;

      // Performance Stats
      y = drawSectionTitle(doc, 'Performances', y);
      const cardW = 42;
      const gap = 3;
      y = drawStatCard(doc, PAGE.marginL, y, cardW, 'Initial Capital', `$${stats.capital.toFixed(2)}`);
      y = drawStatCard(doc, PAGE.marginL + cardW + gap, y - 21, cardW, 'Current Balance', `$${stats.balance.toFixed(2)}`, { valueColor: '#D4AF37' });
      y = drawStatCard(doc, PAGE.marginL + (cardW + gap) * 2, y - 21, cardW, 'Net Profit / Loss', `${stats.profit >= 0 ? '+' : ''}$${stats.profit.toFixed(2)}`, { valueColor: stats.profit >= 0 ? '#22C55E' : '#EF4444' });
      y = drawStatCard(doc, PAGE.marginL + (cardW + gap) * 3, y - 21, cardW, 'Win Rate', `${stats.winRate.toFixed(1)}%`, { valueColor: '#D4AF37' });
      y += 3;

      // Win/Loss Breakdown
      y = drawSectionTitle(doc, 'Trade Distribution', y);
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Successful Trades (WIN)', `${stats.wins}`, { valueColor: '#22C55E' });
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Lost Trades (LOSS)', `${stats.losses}`, { valueColor: '#EF4444' });
      y += 2;

      // Risk Level
      const riskLevel = stats.totalTrades < 5 ? 'Medium' : stats.profit < -sessionData.initialCapital * 0.2 ? 'Critical' : stats.profit < -sessionData.initialCapital * 0.1 || stats.winRate < 45 ? 'High' : stats.profit < 0 || stats.winRate < 55 ? 'Medium' : 'Low';
      const riskBadgeY = y; // capture baseline BEFORE drawInfoRow advances y
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Niveau de Risque', '');
      drawRiskBadge(doc, PAGE.marginL + 30, riskBadgeY, riskLevel);
      y += 6;

      // Trades Table
      if (validTrades.length > 0) {
        y = checkPageBreak(doc, y, 30);
        y = drawSectionTitle(doc, 'Detailed Trades History', y);

        // Table structure matches the Risk Manager PDF exactly:
        // 6 columns: #, Result, Stake ($), Ret ($), Bal ($), Pay (%)
        const headers = [
          { label: '#', width: 10 },
          { label: 'Result', width: 18, align: 'center' as const },
          { label: 'Stake ($)', width: 22, align: 'right' as const },
          { label: 'Ret ($)', width: 22, align: 'right' as const },
          { label: 'Bal ($)', width: 24, align: 'right' as const },
          { label: 'Pay (%)', width: 18, align: 'center' as const },
        ];

        // Compute running balance starting from initial capital.
        // Each WIN adds amount*payout/100; each LOSS subtracts amount.
        let runningBalance = sessionData.initialCapital;
        const rows = validTrades.map((t: TradeEntry, i: number) => {
          const rowPayout = (t.payout && t.payout > 0) ? t.payout : sessionData.payout;
          const ret = t.result === 'WIN' ? t.amount * (rowPayout / 100) : -t.amount;
          runningBalance += ret;
          return [
            `#${i + 1}`,
            t.result || '-',
            t.amount && t.amount > 0 ? t.amount.toFixed(2) : '-',
            t.result === 'WIN' ? `+${(t.return?.toFixed(2) || Math.abs(ret).toFixed(2))}` : t.result === 'LOSS' ? `-${(t.amount?.toFixed(2) || '0.00')}` : '-',
            `$${runningBalance.toFixed(2)}`,
            `${rowPayout}%`,
          ];
        });
        y = drawTable(doc, PAGE.marginL, y, headers, rows);
      }

      const dateStr = new Date().toISOString().split('T')[0];
      savePDF(doc, `a2sniper-journal-${dateStr}.pdf`, pdfUser);
      setJustExported(true);
      setTimeout(() => setJustExported(false), 2500);
      toast.success('Journal PDF report exported successfully!');
    } catch (err) {
      console.error('[PDF EXPORT] Failed:', err);
      toast.error('PDF export failed. Please try again or contact support.');
    }
  };

  return (
    <div className="space-y-8">
      {/* Session navigation + action buttons */}
      {sessionData && (
        <div className="flex justify-between items-center gap-3 flex-wrap">
          {/* Session navigation arrows — always show when sessions exist */}
          {allSessions.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCurrentSessionIdx(Math.max(0, currentSessionIdx - 1))}
                disabled={currentSessionIdx === 0}
                className={`w-8 h-8 rounded-lg flex items-center justify-center border transition-all ${
                  currentSessionIdx === 0
                    ? 'bg-gray-800/30 border-gray-700/30 text-gray-600 cursor-not-allowed opacity-50'
                    : 'bg-[#1a1a1e] border-[#D4AF37]/30 text-[#D4AF37] hover:bg-[#D4AF37]/20 active:scale-95'
                }`}
                title="Previous session"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-bold text-gray-500 min-w-[80px] text-center">
                Session {currentSessionIdx + 1} / {allSessions.length}
              </span>
              <button
                onClick={() => setCurrentSessionIdx(Math.min(allSessions.length - 1, currentSessionIdx + 1))}
                disabled={currentSessionIdx === allSessions.length - 1}
                className={`w-8 h-8 rounded-lg flex items-center justify-center border transition-all ${
                  currentSessionIdx === allSessions.length - 1
                    ? 'bg-gray-800/30 border-gray-700/30 text-gray-600 cursor-not-allowed opacity-50'
                    : 'bg-[#1a1a1e] border-[#D4AF37]/30 text-[#D4AF37] hover:bg-[#D4AF37]/20 active:scale-95'
                }`}
                title="Next session"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
          <div className="flex items-center gap-3 ml-auto">
            <button
              onClick={handleExportPDF}
              className={`px-6 py-2.5 rounded-xl text-xs font-black flex items-center gap-2 transition-all ${justExported ? 'bg-green-500 shadow-lg shadow-green-500/20' : 'bg-[#D4AF37] hover:bg-[#c5a059] shadow-lg shadow-[#D4AF37]/20'} text-black`}
            >
              {justExported ? <Check className="w-4 h-4" /> : <Download className="w-4 h-4 text-black" />}
              {justExported ? 'EXPORTED!' : 'EXPORT PDF'}
            </button>
            <button
              onClick={handleResetJournal}
              className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 rounded-xl text-xs font-black uppercase tracking-wider transition-all border border-red-500/20 active:scale-95"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          </div>
        </div>
      )}

      {!sessionData ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-[#0a0a0c]/80 border border-white/5 rounded-3xl p-12 text-center max-w-2xl mx-auto backdrop-blur-md"
        >
          <div className="w-16 h-16 bg-white/[0.02] border border-white/5 rounded-2xl flex items-center justify-center mx-auto mb-6 text-gray-500">
            <Calendar className="w-8 h-8" />
          </div>
          <h2 className="text-lg font-black text-white uppercase mb-2">No active session</h2>
          <p className="text-sm text-gray-400 font-bold mb-6 max-w-md mx-auto leading-relaxed">
            Pour voir vos statistiques et historique de trades, veuillez d&apos;abord configurer et sauvegarder une session dans le Risk Manager (via le Bot Telegram ou l&apos;onglet Risk Manager).
          </p>
        </motion.div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Summary Cards */}
          <div className="lg:col-span-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { label: 'Initial Capital', value: `$${stats.capital.toFixed(2)}`, icon: DollarSign, color: 'text-gray-400 bg-white/[0.02]' },
              { label: 'Current Balance', value: `$${stats.balance.toFixed(2)}`, icon: BarChart3, color: 'text-[#D4AF37] bg-[#D4AF37]/10' },
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
              <h3 className="text-sm font-black text-white uppercase tracking-wider border-b border-white/5 pb-3">Session Information</h3>
              <div className="space-y-3 font-bold text-xs">
                <div className="flex justify-between text-gray-400">
                  <span>Session Number:</span>
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
                  <span>Successful Trades (WIN) :</span>
                  <span className="text-green-500">{stats.wins}</span>
                </div>
                <div className="flex justify-between text-gray-400">
                  <span>Lost Trades (LOSS) :</span>
                  <span className="text-red-500">{stats.losses}</span>
                </div>
                {sessionData.createdAt && (
                  <div className="flex justify-between text-gray-400 pt-2 border-t border-white/5">
                    <span>Created at :</span>
                    <span className="text-gray-300">{new Date(sessionData.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  </div>
                )}
                {sessionData.updatedAt && sessionData.updatedAt !== sessionData.createdAt && (
                  <div className="flex justify-between text-gray-400">
                    <span>Updated :</span>
                    <span className="text-[#D4AF37]">{new Date(sessionData.updatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-[#D4AF37]/5 border border-[#D4AF37]/10 p-5 rounded-2xl flex items-start gap-3">
              <Info className="w-5 h-5 text-[#D4AF37] flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-gray-400 font-bold leading-relaxed">
                This journal is directly synchronized with the Risk Manager. Your trades entered in the simulator or risk manager are automatically reflected here.
              </p>
            </div>
          </div>

          {/* Right panel: Detailed list */}
          <div className="lg:col-span-8 bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-3xl backdrop-blur-md space-y-6">
            <h3 className="text-sm font-black text-white uppercase tracking-wider">Detailed Trade History</h3>
            {validTrades.length === 0 ? (
              <p className="text-xs text-gray-500 font-bold italic text-center py-12 bg-[#050507]/40 rounded-2xl border border-white/5">
                No trades recorded in this active session.
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
                          <p className="text-xs font-black text-white">Stake: ${t.amount}</p>
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
      {/* Delete Confirmation Dialog */}
      <AnimatePresence>
        {showResetConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={() => !isResetting && setShowResetConfirm(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isResetting) {
                e.preventDefault();
                confirmResetJournal();
              }
            }}
            tabIndex={-1}
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
                <h3 className="text-lg font-bold text-white">Delete Trading Journal Session</h3>
              </div>
              <p className="text-sm text-gray-400 mb-6 leading-relaxed">
                This will permanently delete the current session from the Trading Journal. Other saved sessions will be kept. Are you sure?
              </p>
              <div className="flex gap-3">
                <button
                  onClick={confirmResetJournal}
                  disabled={isResetting}
                  autoFocus
                  className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-lg font-bold transition-colors flex items-center justify-center gap-2"
                >
                  {isResetting ? <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Deleting...
                  </> : 'Delete'}
                </button>
                <button
                  onClick={() => setShowResetConfirm(false)}
                  disabled={isResetting}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 px-4 py-2.5 rounded-lg font-bold transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
