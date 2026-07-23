'use client';

import { getApiUrl } from '@/lib/api-config';
import { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

import {
  Calculator,
  TrendingUp,
  RefreshCw,
  Save,
  Download,
  Target,
  ShieldAlert,
  Plus,
  ChevronRight,
  ChevronLeft,
  Zap,
  DollarSign,
  Loader2,
  AlertTriangle,
  Check,
  Trash2
} from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '@/lib/store';
import { useAuth } from '@/hooks/use-auth';
import { createBrandedPDF, drawSectionTitle, drawStatCard, drawTable, drawInfoRow, drawRiskBadge, drawUserInfoCard, savePDF, PAGE, checkPageBreak, PDFUserInfo, fetchAvatarBase64 } from '@/lib/pdf-export';

type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';

function calculateRiskLevel(winRate: number, totalTrades: number, accountGain: number): RiskLevel {
  if (totalTrades < 5) return 'Medium';
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
  const { userStats, fetchPerformance, user, marketInfo, fetchMarketStatus } = useAppStore();

  // ─── Session state (persisted to localStorage) ───
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
    return Array(10).fill({ result: '', amount: 0, return: 0, payout: 0 });
  });

  // Session counter — persisted to localStorage so it survives page navigation.
  // Starts at 1 (not 0). Loaded from localStorage on mount.
  const [sessionCounter, setSessionCounter] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('a2sniper_risk_session_counter');
      if (saved) { try { return Math.max(1, Number(saved)); } catch {} }
    }
    return 1;
  });

  const [isSaving, setIsSaving] = useState(false);
  const [justExported, setJustExported] = useState(false);
  // justSaved: UI-only flag for the "Saved!" badge (auto-resets after 2s).
  // Does NOT track whether the session is actually saved — for that we use savedSnapshot.
  const [justSaved, setJustSaved] = useState(false);
  // savedSnapshot: JSON string of {trades, initialCapital, payout, sessionCounter}
  // captured at the moment of save. We compare current state to this snapshot
  // to detect REAL unsaved changes (like VS Code's tab dot).
  const [savedSnapshot, setSavedSnapshot] = useState<string>('');
  const [apiWinRate, setApiWinRate] = useState<number | null>(null);
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  // Modal for session counter correction — appears when user tries to save
  // with a duplicate or wrong session counter. Shows the correct number and
  // lets them confirm to auto-correct and save.
  const [showCounterModal, setShowCounterModal] = useState(false);
  const [counterModalInfo, setCounterModalInfo] = useState<{ entered: number; expected: number; error: string }>({ entered: 0, expected: 0, error: '' });

  // Multi-session support
  const [allSessions, setAllSessions] = useState<any[]>([]);
  const [currentEditingIdx, setCurrentEditingIdx] = useState(-1);

  // Check if any trades are recorded
  const hasRecordedTrades = trades.some(t => t.result && t.amount > 0);

  // ─── INTELLIGENT UNSAVED-CHANGES DETECTION ───
  // Snapshot-based: same approach VS Code/IntelliJ use for the tab dot.
  // hasUnsavedChanges is TRUE only when:
  //   1. There are recorded trades (something worth losing), AND
  //   2. The current state differs from the last saved snapshot
  //      (or no snapshot exists yet — trades entered but never saved)
  const currentSnapshot = useMemo(
    () => JSON.stringify({ trades, initialCapital, payout, sessionCounter }),
    [trades, initialCapital, payout, sessionCounter]
  );
  const hasUnsavedChanges = hasRecordedTrades && currentSnapshot !== savedSnapshot;

  // ─── Session counter validation helper ───
  // Returns { valid: boolean, expected: number, error: string | null }
  const validateSessionCounter = (counter: number, editingIdx: number, sessions: any[]) => {
    // When editing an existing session (currentEditingIdx >= 0), the counter
    // should match the session being edited. We don't re-validate.
    if (editingIdx >= 0) {
      return { valid: true, expected: counter, error: null };
    }
    // For new sessions: counter must be the next sequential number.
    const savedCounters = sessions
      .map(s => s.sessionCounter || 0)
      .filter(c => c > 0);
    const expected = savedCounters.length > 0 ? Math.max(...savedCounters) + 1 : 1;
    if (counter < 1) {
      return { valid: false, expected, error: `Session counter must be at least 1. Please set it to ${expected}.` };
    }
    if (savedCounters.includes(counter)) {
      return { valid: false, expected, error: `Session #${counter} already exists. The correct next session number is ${expected}.` };
    }
    if (counter !== expected) {
      return { valid: false, expected, error: `Session counter should be ${expected} (you have ${savedCounters.length} saved session${savedCounters.length > 1 ? 's' : ''}: #${savedCounters.sort((a, b) => a - b).join(', #')}). Please correct it to ${expected}.` };
    }
    return { valid: true, expected, error: null };
  };

  // ─── Persist session counter to localStorage whenever it changes ───
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('a2sniper_risk_session_counter', String(sessionCounter));
    }
  }, [sessionCounter]);

  // Fetch performance + market status (for PO balance).
  // Poll every 10s (was 2s — too aggressive, caused unnecessary load).
  // These calls are SAFE when PO is disconnected — the backend returns
  // is_connected: false and the frontend handles it gracefully.
  // The Risk Manager works fully offline (manual balance entry) —
  // PO connection is ONLY used to auto-detect the balance.
  useEffect(() => {
    const loadData = async () => {
      try {
        await fetchPerformance();
      } catch {}
      try {
        await fetchMarketStatus();
      } catch {}
    };
    loadData();
    const pollInterval = setInterval(async () => {
      try { await fetchMarketStatus(); } catch {}
    }, 10000); // 10s — less aggressive
    return () => clearInterval(pollInterval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fill initial capital from PO balance (ONLY when PO is connected).
  // If PO is NOT connected, the user sets the balance manually — the Risk
  // Manager still works perfectly, just without auto-detected balance.
  // Only auto-fills if the current balance is the default ($1000) or empty —
  // never overwrites a user-entered balance.
  useEffect(() => {
    if (marketInfo?.account_balance && marketInfo.account_balance > 0) {
      const currentCap = localStorage.getItem('a2sniper_risk_capital');
      if (!currentCap || currentCap === '1000') {
        setInitialCapital(marketInfo.account_balance);
        localStorage.setItem('a2sniper_risk_capital', String(marketInfo.account_balance));
      }
    }
    // If PO is not connected, do nothing — user enters balance manually.
    // The Risk Manager still works: stake auto-fill, WIN/LOSS tracking,
    // delete trade, etc. all function without PO connection.
  }, [marketInfo?.account_balance]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => {
    let currentBalance = initialCapital;
    let wins = 0;
    let losses = 0;
    let totalProfit = 0;
    let totalStake = 0;

    const computedTrades = trades.map(trade => {
      if (!trade.result || trade.amount <= 0) return { ...trade, balance: '-' };
      // Use per-row payout if set, otherwise fall back to global payout
      const rowPayout = (trade.payout && trade.payout > 0) ? trade.payout : payout;
      totalStake += trade.amount;
      let res = 0;
      if (trade.result === 'WIN') {
        res = trade.amount * (rowPayout / 100);
        currentBalance += res;
        wins++;
        totalProfit += res;
      } else {
        res = -trade.amount;
        currentBalance += res;
        losses++;
        totalProfit += res;
      }
      return { ...trade, return: Math.abs(res), balance: currentBalance.toFixed(2), payout: rowPayout };
    });

    const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;
    const accountGain = initialCapital > 0 ? ((currentBalance - initialCapital) / initialCapital) * 100 : 0;
    return { computedTrades, wins, losses, totalProfit, currentBalance, winRate, accountGain, totalStake };
  }, [trades, initialCapital, payout]);

  const displayWinRate = apiWinRate !== null && apiWinRate > 0 ? apiWinRate : results.winRate;
  const riskLevel = calculateRiskLevel(displayWinRate, results.wins + results.losses, results.accountGain);
  const riskStyle = getRiskLevelStyle(riskLevel);

  // ─── RECOMMENDED STAKE CALCULATION ────────────────────────────────────────
  // Computes the suggested stake for a given trade index based on:
  //   1. The balance BEFORE that trade (sum of all prior WIN/LOSS results)
  //   2. The current winrate (higher WR = higher stake %, lower WR = defensive)
  //
  // Stake percentage tiers:
  //   WR >= 70%  → 5% of balance (aggressive — proven edge)
  //   WR >= 60%  → 4% of balance (moderate)
  //   WR >= 50%  → 3% of balance (conservative)
  //   WR <  50%  → 2% of balance (defensive — protect capital)
  //
  // Minimum stake: $1 (PO minimum trade size)
  const getBalanceBeforeTrade = (idx: number): number => {
    if (idx === 0) return initialCapital;
    let balance = initialCapital;
    for (let i = 0; i < idx; i++) {
      const t = trades[i];
      if (t.result === 'WIN' && t.amount > 0) {
        balance += t.amount * (payout / 100);
      } else if (t.result === 'LOSS' && t.amount > 0) {
        balance -= t.amount;
      }
    }
    return balance;
  };

  const getRecommendedStake = (idx: number): number => {
    const balance = getBalanceBeforeTrade(idx);
    if (balance <= 0) return 0;
    const wr = displayWinRate || 0;
    let percentage = 0.05; // default 5%
    if (wr >= 70) percentage = 0.05;
    else if (wr >= 60) percentage = 0.04;
    else if (wr >= 50) percentage = 0.03;
    else percentage = 0.02;
    const stake = balance * percentage;
    return Math.max(1, parseFloat(stake.toFixed(2))); // min $1, 2 decimal places
  };

  // Live validation status for the session counter (shown in UI)
  const counterValidation = validateSessionCounter(sessionCounter, currentEditingIdx, allSessions);

  // ─── Helper: fill the first empty trade's stake with the recommended amount ─
  // Called from: balance change, new session, WIN/LOSS click.
  // Does NOT use useEffect — useEffect caused a conflict where it would
  // overwrite the stake set by handleUpdateTrade (both fired on the same
  // render cycle, and the useEffect's setTrades won, resetting to $1).
  //
  // IMPORTANT: Matches the Sniper Stake Helper on the right side of the page,
  // which always uses 5% of the current balance. We use the same 5% here
  // so the table stake matches the helper stake exactly.
  const fillFirstEmptyTradeStake = (tradesArr: any[], capital: number, wr: number, payoutPct: number) => {
    const newTrades = [...tradesArr];
    const firstEmptyIdx = newTrades.findIndex(t => !t.result);
    if (firstEmptyIdx === -1) return newTrades;

    // Calculate balance before this trade
    let balance = capital;
    for (let i = 0; i < firstEmptyIdx; i++) {
      const t = newTrades[i];
      if (t.result === 'WIN' && t.amount > 0) {
        balance += t.amount * (payoutPct / 100);
      } else if (t.result === 'LOSS' && t.amount > 0) {
        balance -= t.amount;
      }
    }
    if (balance <= 0) return newTrades;

    // Always use 5% of balance — matches the Sniper Stake Helper on the right.
    // (Previous winrate-based tiers caused the table to show $1 while the
    // helper showed the correct 5% amount — confusing and inconsistent.)
    const recStake = Math.max(1, parseFloat((balance * 0.05).toFixed(2)));

    // Fill the first empty row with the recommended stake and current payout
    newTrades[firstEmptyIdx] = { ...newTrades[firstEmptyIdx], amount: recStake, payout: payoutPct };

    // Clear ALL other empty rows (set amount to 0) so they show $1 grayed
    for (let i = firstEmptyIdx + 1; i < newTrades.length; i++) {
      const t = newTrades[i];
      if (!t.result && t.amount !== 0) {
        newTrades[i] = { ...t, amount: 0 };
      }
    }

    return newTrades;
  };

  const handleUpdateTrade = (idx: number, field: string, val: string | number | boolean) => {
    const newTrades = [...trades];
    if (field === 'amount' && typeof val === 'number' && val < 0) {
      toast.error('Amount cannot be negative.');
      return;
    }
    newTrades[idx] = { ...newTrades[idx], [field]: val };

    // ─── AUTO-FILL NEXT ROW STAKE ON WIN/LOSS ──────────────────────────────
    // When the user clicks WIN or LOSS on trade N, auto-fill the recommended
    // stake for trade N+1 (based on the updated balance after trade N).
    // Uses the shared helper to ensure consistency with the balance-change
    // auto-fill. This is the ONLY place stakes are auto-filled — no useEffect.
    if (field === 'result' && (val === 'WIN' || val === 'LOSS')) {
      const filledTrades = fillFirstEmptyTradeStake(newTrades, initialCapital, displayWinRate || 0, payout);
      // Copy the filled values back to newTrades
      for (let i = 0; i < newTrades.length; i++) {
        newTrades[i] = filledTrades[i];
      }
    }

    setTrades(newTrades);
    localStorage.setItem('a2sniper_risk_trades', JSON.stringify(newTrades));
  };

  // ─── DELETE TRADE ROW ─────────────────────────────────────────────────────
  // Removes a trade from the array. If the user accidentally added a trade
  // they didn't actually take, they can delete it. Subsequent trades shift up.
  // Ensures at least 10 rows remain (the default table size).
  const deleteTrade = (idx: number) => {
    const newTrades = trades.filter((_, i) => i !== idx);
    // Ensure at least 10 rows
    while (newTrades.length < 10) {
      newTrades.push({ result: '', amount: 0, return: 0 });
    }
    setTrades(newTrades);
    localStorage.setItem('a2sniper_risk_trades', JSON.stringify(newTrades));
    toast.success(`Trade #${idx + 1} deleted`);
  };

  const addTradeRow = () => {
    const newTrades = [...trades, { result: '', amount: 0, return: 0 }];
    setTrades(newTrades);
    localStorage.setItem('a2sniper_risk_trades', JSON.stringify(newTrades));
  };

  // ─── Sync current (possibly unsaved) session to localStorage for Trading Journal live preview ───
  // Writes ONLY to the singular key — the plural array is only modified by SAVE/RESET/NEW SESSION.
  const syncSessionToJournal = () => {
    const sessionData = {
      trades,
      payout,
      initialCapital,
      sessionCounter,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem('a2sniper_risk_session', JSON.stringify(sessionData));
    window.dispatchEvent(new StorageEvent('storage', { key: 'a2sniper_risk_session' }));
  };

  // Auto-sync whenever trades, capital, payout, or sessionCounter change
  useEffect(() => {
    if (typeof window !== 'undefined') {
      syncSessionToJournal();
    }
  }, [trades, initialCapital, payout, sessionCounter]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Load all sessions on mount (SINGLE useEffect — was duplicated) ───
  // Key fix: if the user is on a NEW (unsaved) session, DON'T overwrite it
  // with the last saved session. We detect this by checking if the current
  // session counter is HIGHER than the max saved counter (meaning the user
  // clicked "New Session" but hasn't saved yet).
  useEffect(() => {
    const savedAll = localStorage.getItem('a2sniper_risk_sessions');
    if (savedAll) {
      try {
        const parsed = JSON.parse(savedAll);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setAllSessions(parsed);

          // Check if the user is on a NEW unsaved session.
          // We detect this by checking if the current session counter
          // (from localStorage) is higher than the max saved counter.
          const currentCounterStr = localStorage.getItem('a2sniper_risk_session_counter');
          const currentCounter = currentCounterStr ? parseInt(currentCounterStr, 10) : 0;
          const maxSavedCounter = Math.max(...parsed.map((s: any) => s.sessionCounter || 0));

          if (currentCounter > maxSavedCounter) {
            // User is on a NEW unsaved session — DON'T overwrite it.
            // Just set currentEditingIdx to -1 (new session) and keep
            // the current trades/capital/counter as-is.
            setCurrentEditingIdx(-1);
            return;
          }

          // User is NOT on a new session — load the last saved session.
          setCurrentEditingIdx(parsed.length - 1);
          const last = parsed[parsed.length - 1];
          const currentTrades = localStorage.getItem('a2sniper_risk_trades');
          const hasCurrentTrades = currentTrades && JSON.parse(currentTrades).some((t: any) => t.result && t.amount > 0);
          if (!hasCurrentTrades) {
            setInitialCapital(last.initialCapital || 1000);
            setPayout(last.payout || 92);
            setTrades(last.trades || Array(10).fill({ result: '', amount: 0, return: 0 }));
            setSessionCounter(Math.max(1, last.sessionCounter || 1));
            // Set snapshot so hasUnsavedChanges is FALSE (session is already saved)
            setSavedSnapshot(JSON.stringify({
              trades: last.trades || Array(10).fill({ result: '', amount: 0, return: 0 }),
              initialCapital: last.initialCapital || 1000,
              payout: last.payout || 92,
              sessionCounter: last.sessionCounter || 1,
            }));
          } else {
            // User has trades loaded — check if they match the last saved session
            const lastSaved = parsed[parsed.length - 1];
            const currentCapital = parseFloat(localStorage.getItem('a2sniper_risk_capital') || '0') || 1000;
            const currentPayout = parseFloat(localStorage.getItem('a2sniper_risk_payout') || '0') || 92;
            const currentTradesParsed = currentTrades ? JSON.parse(currentTrades) : [];
            const matchesLastSaved = lastSaved &&
              JSON.stringify(lastSaved.trades) === JSON.stringify(currentTradesParsed) &&
              lastSaved.initialCapital === currentCapital &&
              lastSaved.payout === currentPayout;
            if (matchesLastSaved) {
              setSavedSnapshot(JSON.stringify({
                trades: currentTradesParsed,
                initialCapital: currentCapital,
                payout: currentPayout,
                sessionCounter: lastSaved.sessionCounter || 1,
              }));
            }
          }
        }
      } catch {}
    }
  }, []);

  // ─── CLEAR / RESET ───
  const clearSession = () => setShowResetConfirm(true);

  const confirmClearSession = () => {
    // CRITICAL: Reset does NOT delete saved sessions. It only clears the
    // current view and starts a fresh empty session. Saved sessions in
    // allSessions are NEVER removed by Reset — only by an explicit Delete
    // action (which doesn't exist yet — sessions are permanent).
    const emptyTrades = Array(10).fill({ result: '', amount: 0, return: 0 });
    setTrades(emptyTrades);
    // Use the LATEST marketInfo from the store (not stale closure)
    const latestMarketInfo = useAppStore.getState().marketInfo;
    const poBalance = latestMarketInfo?.account_balance && latestMarketInfo.account_balance > 0
      ? latestMarketInfo.account_balance
      : (parseFloat(localStorage.getItem('a2sniper_risk_capital') || '0') || 1000);
    setInitialCapital(poBalance);
    setPayout(92);
    // Reset session counter to the NEXT available number (1 if no sessions, else max+1)
    const savedCounters = allSessions.map(s => s.sessionCounter || 0).filter(c => c > 0);
    const nextCounter = savedCounters.length > 0 ? Math.max(...savedCounters) + 1 : 1;
    setSessionCounter(nextCounter);
    setCurrentEditingIdx(-1);
    setJustSaved(false);
    setSavedSnapshot('');

    // DO NOT remove the current session from allSessions — that was causing
    // saved sessions to disappear. Reset only clears the current view.

    localStorage.removeItem('a2sniper_risk_trades');
    localStorage.removeItem('a2sniper_risk_session');
    localStorage.setItem('a2sniper_risk_capital', String(poBalance));

    const emptySession = { trades: emptyTrades, payout: 92, initialCapital: poBalance, sessionCounter: nextCounter };
    localStorage.setItem('a2sniper_risk_session', JSON.stringify(emptySession));
    window.dispatchEvent(new StorageEvent('storage', { key: 'a2sniper_risk_session' }));

    setShowResetConfirm(false);
    toast.success(
      latestMarketInfo?.is_demo
        ? `Session reset. PO balance loaded (DEMO): $${poBalance.toFixed(2)}`
        : latestMarketInfo?.account_balance && latestMarketInfo.account_balance > 0
          ? `Session reset. PO balance loaded (REAL): $${poBalance.toFixed(2)}`
          : `Session reset. Balance: $${poBalance.toFixed(2)}`
    );
  };

  // ─── NEW SESSION ───
  const handleNewSession = () => {
    // If the current session is already empty (no trades recorded), inform
    // the user that they're already on a new session — don't create another
    // one. The toast tells them to fill the current session and save before
    // creating a new one.
    if (!hasRecordedTrades) {
      toast.info("You're already on a new session. Record some trades and save before creating another.", { duration: 4000 });
      return;
    }
    // Intelligent: only show modal if there are REAL unsaved changes.
    // After saving → hasUnsavedChanges = FALSE → goes straight to new session.
    if (hasUnsavedChanges) {
      setShowNewSessionModal(true);
      return;
    }
    doNewSession();
  };

  const doNewSession = () => {
    // Use the EXISTING marketInfo from the store — don't await a fresh fetch.
    // The store is already polled every 10s, so marketInfo is fresh enough.
    // This makes the New Session button INSTANT (no API call delay).
    // The background poll will update the balance later if PO reconnects.
    const latestMarketInfo = useAppStore.getState().marketInfo;
    const liveBalance = latestMarketInfo?.account_balance && latestMarketInfo.account_balance > 0
      ? latestMarketInfo.account_balance : null;

    // Fallback chain: live PO balance → localStorage saved balance → $1000
    const savedCapital = parseFloat(localStorage.getItem('a2sniper_risk_capital') || '0');
    const poBalance = liveBalance
      ?? (savedCapital > 0 ? savedCapital : null)
      ?? 1000;

    // Reset apiWinRate to null so a new session starts with N/A winrate
    setApiWinRate(null);

    setInitialCapital(poBalance);
    setPayout(92);
    // Next session counter = max saved + 1 (or 1 if no saved sessions)
    const savedCounters = allSessions.map(s => s.sessionCounter || 0).filter(c => c > 0);
    const nextCounter = savedCounters.length > 0 ? Math.max(...savedCounters) + 1 : (sessionCounter + 1);
    setSessionCounter(nextCounter);
    setCurrentEditingIdx(-1);
    setJustSaved(false);
    setSavedSnapshot('');
    setShowNewSessionModal(false);

    localStorage.setItem('a2sniper_risk_capital', String(poBalance));

    // ─── AUTO-FILL FIRST TRADE STAKE IMMEDIATELY ──────────────────────────
    // Use the shared helper to fill the first empty trade's stake based on
    // the new balance. This works whether PO is connected or not — the stake
    // is calculated from whatever balance we have (live, saved, or $1000).
    const emptyTrades = Array(10).fill({ result: '', amount: 0, return: 0 });
    const filledTrades = fillFirstEmptyTradeStake(emptyTrades, poBalance, 0, 92);
    setTrades(filledTrades);
    localStorage.setItem('a2sniper_risk_trades', JSON.stringify(filledTrades));

    const accountTypeLabel = liveBalance
      ? (latestMarketInfo?.is_demo ? 'DEMO account balance' : 'REAL account balance')
      : (savedCapital > 0 ? 'last saved balance (PO not connected)' : 'default balance (PO not connected)');
    toast.info(`New session — ${accountTypeLabel}: $${poBalance.toFixed(2)}`, { duration: 4000 });

    // Fire-and-forget: refresh market status in the background so the next
    // new session has the freshest balance. Don't await — UI is already updated.
    fetchMarketStatus().catch(() => {});
  };

  const saveAndNewSession = async () => {
    if (!hasRecordedTrades) {
      toast.error("Please record at least 1 trade before saving.", { duration: 3000 });
      return;
    }
    // Validate session counter BEFORE saving
    const validation = validateSessionCounter(sessionCounter, currentEditingIdx, allSessions);
    if (!validation.valid) {
      // Show modal with the correct counter — user must confirm
      setCounterModalInfo({
        entered: sessionCounter,
        expected: validation.expected,
        error: validation.error || `Session #${sessionCounter} already exists.`,
      });
      setShowCounterModal(true);
      return;
    }

    await performSave(sessionCounter);
    toast.success("Session saved! Opening new session...", { duration: 2000 });
    // No delay — doNewSession is now instant (no API call)
    doNewSession();
  };

  const handleLoadSession = (idx: number) => {
    if (idx < 0 || idx >= allSessions.length) return;
    const s = allSessions[idx];
    setInitialCapital(s.initialCapital || 1000);
    setPayout(s.payout || 92);
    setTrades(s.trades || Array(10).fill({ result: '', amount: 0, return: 0 }));
    setSessionCounter(Math.max(1, s.sessionCounter || 1));
    setCurrentEditingIdx(idx);
    setJustSaved(false);
    setSavedSnapshot(JSON.stringify({
      trades: s.trades || Array(10).fill({ result: '', amount: 0, return: 0 }),
      initialCapital: s.initialCapital || 1000,
      payout: s.payout || 92,
      sessionCounter: s.sessionCounter || 1,
    }));
    toast.info(`Loaded session #${s.sessionCounter || 1}`);
  };

  // ─── SAVE ───
  // ─── Perform the actual save (called after validation passes) ────────────
  // Extracted so both handleSave and the counter-correction modal can call it.
  const performSave = async (counterToUse: number) => {
    setIsSaving(true);
    localStorage.setItem('a2sniper_risk_capital', String(initialCapital));
    localStorage.setItem('a2sniper_risk_payout', String(payout));
    localStorage.setItem('a2sniper_risk_trades', JSON.stringify(trades));
    localStorage.setItem('a2sniper_risk_session_counter', String(counterToUse));

    // Save to sessions array (multi-session support)
    // Track createdAt (first save) and updatedAt (subsequent saves)
    const now = new Date().toISOString();
    const existing = (currentEditingIdx >= 0 && currentEditingIdx < allSessions.length) ? allSessions[currentEditingIdx] : null;
    const dataToSave = {
      initialCapital, payout, trades, sessionCounter: counterToUse,
      savedAt: now,
      createdAt: existing?.createdAt || now,  // Preserve original creation time
      updatedAt: now,  // Always update to current save time
    };
    const updated = [...allSessions];
    if (currentEditingIdx >= 0 && currentEditingIdx < updated.length) {
      updated[currentEditingIdx] = dataToSave;
    } else {
      updated.push(dataToSave);
      setCurrentEditingIdx(updated.length - 1);
    }
    setAllSessions(updated);
    localStorage.setItem('a2sniper_risk_sessions', JSON.stringify(updated));
    syncSessionToJournal();

    // Capture the saved state as a snapshot so hasUnsavedChanges is FALSE
    setSavedSnapshot(JSON.stringify({ trades, initialCapital, payout, sessionCounter: counterToUse }));

    try {
      const apiUrl = getApiUrl();
      const res = await fetch(`${apiUrl}/api/risk/settings`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initial_capital: initialCapital,
          payout,
          trades: trades.filter(t => t.result === 'WIN' || t.result === 'LOSS'),
          session_counter: counterToUse,
        }),
      });
      if (res.ok) {
        toast.success('Session saved successfully!');
      } else {
        toast.success('Saved locally.');
      }
    } catch {
      toast.success('Saved locally.');
    } finally {
      setIsSaving(false);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    }
  };

  // ─── SAVE (with modal for duplicate session counter) ─────────────────────
  // If the user tries to save with a duplicate or wrong session counter,
  // show a modal explaining the issue and offering to auto-correct.
  // Only saves after the user confirms the correct counter.
  const handleSave = async () => {
    // Validation 1: can't save without at least 1 recorded trade
    if (!hasRecordedTrades) {
      toast.error("Please record at least 1 trade before saving.", { duration: 3000 });
      return;
    }

    // Validation 2: session counter must be correct (no duplicates, no skips)
    const validation = validateSessionCounter(sessionCounter, currentEditingIdx, allSessions);
    if (!validation.valid) {
      // Show modal with the correct counter — user must confirm
      setCounterModalInfo({
        entered: sessionCounter,
        expected: validation.expected,
        error: validation.error || `Session #${sessionCounter} already exists.`,
      });
      setShowCounterModal(true);
      return;
    }

    // Validation passed — save directly
    await performSave(sessionCounter);
  };

  // Called when user clicks "OK" in the counter-correction modal
  const confirmCounterCorrection = async () => {
    setSessionCounter(counterModalInfo.expected);
    setShowCounterModal(false);
    // Save with the corrected counter
    await performSave(counterModalInfo.expected);
  };

  // ─── Enter key support for all modals ────────────────────────────────────
  // When any modal is open, pressing Enter triggers the primary action
  // (Confirm/Save/Delete), and Escape closes the modal.
  useEffect(() => {
    const anyModalOpen = showResetConfirm || showNewSessionModal || showCounterModal;
    if (!anyModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (showResetConfirm) confirmClearSession();
        else if (showNewSessionModal) saveAndNewSession();
        else if (showCounterModal) confirmCounterCorrection();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowResetConfirm(false);
        setShowNewSessionModal(false);
        setShowCounterModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showResetConfirm, showNewSessionModal, showCounterModal]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleExportPDF = async () => {
    if (user?.avatar) { await fetchAvatarBase64(user.avatar); }
    const pdfUser: PDFUserInfo = {
      name: user?.name, email: user?.email, plan: user?.plan, userId: user?.id, avatarUrl: user?.avatar,
    };
    const doc = createBrandedPDF('Risk Manager', 'A2Sniper 3.0 Professional Capital Manager', pdfUser);
    let y = 58;
    y = drawUserInfoCard(doc, y, pdfUser);
    y = drawSectionTitle(doc, 'Configuration', y);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Initial Capital', `$${initialCapital.toFixed(2)}`);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Market Payout', `${payout}%`, { valueColor: '#D4AF37' });
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Session', `#${sessionCounter}`);
    y += 2;
    y = drawSectionTitle(doc, 'Risk Analysis', y);
    const cardW = 42, gap = 3;
    y = drawStatCard(doc, PAGE.marginL, y, cardW, 'Balance', `$${results.currentBalance.toFixed(2)}`);
    y = drawStatCard(doc, PAGE.marginL + cardW + gap, y - 21, cardW, 'Net Profit', `${results.totalProfit >= 0 ? '+' : ''}$${results.totalProfit.toFixed(2)}`, { valueColor: results.totalProfit >= 0 ? '#22C55E' : '#EF4444' });
    y = drawStatCard(doc, PAGE.marginL + (cardW + gap) * 2, y - 21, cardW, 'Win Rate', displayWinRate > 0 ? `${displayWinRate.toFixed(1)}%` : 'N/A', { valueColor: '#D4AF37' });
    y = drawStatCard(doc, PAGE.marginL + (cardW + gap) * 3, y - 21, cardW, 'Gain', `${results.accountGain >= 0 ? '+' : ''}${results.accountGain.toFixed(2)}%`, { valueColor: results.accountGain >= 0 ? '#22C55E' : '#EF4444' });
    y += 3;
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Risk Level', '');
    drawRiskBadge(doc, PAGE.marginL + 28, y - 1, riskLevel);
    y += 6;
    // Include ALL trades with a result (WIN or LOSS), even if amount is 0.
    // Previous filter (t.result) was too loose — included empty strings.
    // The t.result && t.amount > 0 filter was too strict — excluded empty-stake trades.
    const validTrades = results.computedTrades.filter(t => t.result === 'WIN' || t.result === 'LOSS');
    if (validTrades.length > 0) {
      y = checkPageBreak(doc, y, 30);
      y = drawSectionTitle(doc, 'Trading Journal', y);
      const headers = [
        { label: '#', width: 10 },
        { label: 'Result', width: 18, align: 'center' as const },
        { label: 'Stake ($)', width: 22, align: 'right' as const },
        { label: 'Ret ($)', width: 22, align: 'right' as const },
        { label: 'Bal ($)', width: 24, align: 'right' as const },
        { label: 'Pay (%)', width: 18, align: 'center' as const },
      ];
      const rows = validTrades.map((t) => {
        const origIdx = results.computedTrades.indexOf(t);
        const rowPayout = (t.payout && t.payout > 0) ? t.payout : payout;
        return [
          `#${origIdx + 1}`,
          t.result || '-',
          t.amount && t.amount > 0 ? t.amount.toFixed(2) : '-',
          t.result === 'WIN' ? `+${(t.return?.toFixed(2) || '0.00')}` : t.result === 'LOSS' ? `-${(t.amount?.toFixed(2) || '0.00')}` : '-',
          t.balance === '-' ? '-' : `$${t.balance}`,
          `${rowPayout}%`,
        ];
      });
      y = drawTable(doc, PAGE.marginL, y, headers, rows);
    }
    const dateStr = new Date().toISOString().split('T')[0];
    savePDF(doc, `a2sniper-risk-${dateStr}.pdf`, pdfUser);
    setJustExported(true);
    setTimeout(() => setJustExported(false), 2500);
    toast.success('PDF report exported successfully!');
  };

  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-12">
        <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}>
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-[#D4AF37]/10 p-2 rounded-lg border border-[#D4AF37]/20">
              <Calculator className="w-5 h-5 text-[#D4AF37]" />
            </div>
            <h1 className="text-2xl font-black text-white uppercase tracking-tight">Risk Manager</h1>
          </div>
          <p className="text-gray-400 font-medium">A2Sniper 3.0 Professional Capital Manager</p>
        </motion.div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleNewSession}
            className={`px-3 py-2 border rounded-xl text-xs font-black flex items-center gap-1.5 transition-all ${
              hasUnsavedChanges
                ? 'bg-orange-500/10 hover:bg-orange-500/20 border-orange-500/40 text-orange-400'
                : 'bg-[#121216] hover:bg-[#1a1a1f] border-[#D4AF37]/30 text-[#D4AF37]'
            }`}
            title={hasUnsavedChanges ? "You have unsaved changes — confirmation required" : "Start a new session"}
          >
            <Plus className="w-3.5 h-3.5" /> NEW SESSION
            {hasUnsavedChanges && <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />}
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className={`px-4 py-2 border rounded-xl text-xs font-black flex items-center gap-1.5 transition-all disabled:opacity-50 ${justSaved ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-[#121216] hover:bg-[#1a1a1f] border-gray-800 text-white'}`}
          >
            {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : justSaved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5 text-[#D4AF37]" />}
            {isSaving ? 'Saving...' : justSaved ? 'Saved!' : 'SAVE'}
          </button>
          <button
            onClick={handleExportPDF}
            className={`px-4 py-2 rounded-xl text-xs font-black flex items-center gap-1.5 transition-all ${justExported ? 'bg-green-500 shadow-lg shadow-green-500/20' : 'bg-[#D4AF37] hover:bg-[#c5a059] shadow-lg shadow-[#D4AF37]/20'} text-black`}
          >
            {justExported ? <Check className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5 text-black" />}
            {justExported ? 'EXPORTED!' : 'EXPORT PDF'}
          </button>
          <button
            onClick={clearSession}
            className="px-3 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-xl text-xs font-black text-red-400 flex items-center gap-1.5 transition-all"
          >
            <Trash2 className="w-3.5 h-3.5" /> DELETE
          </button>
        </div>
      </div>

      {/* Saved Sessions Navigator */}
      {allSessions.length > 0 && (
        <div className="bg-[#0a0a0c] p-4 rounded-2xl border border-gray-800/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Saved Sessions</span>
            <span className="text-xs font-black text-[#D4AF37]">{allSessions.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleLoadSession(Math.max(0, currentEditingIdx - 1))}
              disabled={currentEditingIdx <= 0}
              className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-500 hover:text-white transition-colors disabled:opacity-30"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-black text-white min-w-[80px] text-center">
              {currentEditingIdx >= 0 && currentEditingIdx < allSessions.length
                ? `Session #${allSessions[currentEditingIdx].sessionCounter || 1}`
                : 'New Session'}
            </span>
            <button
              onClick={() => handleLoadSession(Math.min(allSessions.length - 1, currentEditingIdx + 1))}
              disabled={currentEditingIdx >= allSessions.length - 1}
              className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-500 hover:text-white transition-colors disabled:opacity-30"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">

        {/* Left: Tracker */}
        <div className="xl:col-span-8 space-y-6">

          {/* Stats Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="bg-[#0a0a0c] px-4 py-3 rounded-xl border border-gray-800/50">
              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mb-1">Balance</p>
              <p className="text-lg font-black text-white">${results.currentBalance.toFixed(2)}</p>
            </div>
            <div className="bg-[#0a0a0c] px-4 py-3 rounded-xl border border-gray-800/50">
              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mb-1">Net Profit</p>
              <p className={`text-lg font-black ${results.totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {results.totalProfit >= 0 ? '+' : ''}${results.totalProfit.toFixed(2)}
              </p>
            </div>
            <div className="bg-[#0a0a0c] px-4 py-3 rounded-xl border border-gray-800/50">
              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mb-1">Win Rate</p>
              <p className="text-lg font-black text-[#D4AF37]">
                {displayWinRate > 0 ? `${displayWinRate.toFixed(1)}%` : 'N/A'}
              </p>
            </div>
            <div className="bg-[#0a0a0c] px-4 py-3 rounded-xl border border-gray-800/50">
              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mb-1">Gain</p>
              <p className={`text-lg font-black ${results.accountGain >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {results.accountGain >= 0 ? '+' : ''}{results.accountGain.toFixed(2)}%
              </p>
            </div>
            <div className="bg-[#0a0a0c] px-4 py-3 rounded-xl border border-gray-800/50 col-span-2 sm:col-span-1">
              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mb-1">Risk</p>
              <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md ${riskStyle.bg} ${riskStyle.border} border`}>
                {riskLevel === 'High' || riskLevel === 'Critical' ? (
                  <AlertTriangle className={`w-3.5 h-3.5 ${riskStyle.text}`} />
                ) : (
                  <ShieldAlert className={`w-3.5 h-3.5 ${riskStyle.text}`} />
                )}
                <span className={`text-xs font-black ${riskStyle.text}`}>{riskLevel}</span>
              </div>
            </div>
          </div>

          {/* Trade Table */}
          <div className="bg-[#0a0a0c] rounded-[2rem] border border-gray-800/50 overflow-hidden">
            <div className="p-6 border-b border-gray-800/50 flex justify-between items-center bg-[#0d0d0f]">
              <h3 className="text-sm font-black text-white uppercase tracking-widest flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-[#D4AF37]" />
                Trading Journal
              </h3>
              <button
                onClick={addTradeRow}
                className="p-2 bg-[#D4AF37]/10 hover:bg-[#D4AF37]/20 border border-[#D4AF37]/20 rounded-lg text-[#D4AF37] transition-all"
              >
                <Plus className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full table-fixed border-collapse">
                <colgroup>
                  <col className="w-[5%]" />
                  <col className="w-[22%]" />
                  <col className="w-[18%]" />
                  <col className="w-[18%]" />
                  <col className="w-[20%]" />
                  <col className="w-[17%]" />
                </colgroup>
                <thead>
                  <tr className="bg-black/40 text-[10px] font-black text-gray-600 uppercase tracking-[0.1em] sm:tracking-[0.2em]">
                    <th className="px-2 sm:px-4 py-3 text-left">#</th>
                    <th className="px-2 sm:px-4 py-3 text-left">Result</th>
                    <th className="px-2 sm:px-4 py-3 text-left">Stake ($)</th>
                    <th className="px-2 sm:px-4 py-3 text-right">Return ($)</th>
                    <th className="px-2 sm:px-4 py-3 text-right">Balance ($)</th>
                    <th className="px-2 sm:px-4 py-3 text-center">Payout (%)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/30">
                  {results.computedTrades.map((trade, i) => (
                    <tr key={i} className="hover:bg-white/[0.02] transition-colors group relative">
                      {/* Delete button — floats on hover, top-right of row */}
                      <button
                        onClick={() => deleteTrade(i)}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-1 sm:p-1.5 text-gray-700 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all opacity-0 group-hover:opacity-100 z-10"
                        title="Delete this trade"
                      >
                        <Trash2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                      </button>
                      <td className="px-2 sm:px-4 py-3 text-xs font-black text-gray-600">{i + 1}</td>
                      <td className="px-2 sm:px-4 py-3">
                        <div className="flex gap-1 sm:gap-2">
                          <button
                            onClick={() => handleUpdateTrade(i, 'result', 'WIN')}
                            className={`flex-1 py-1.5 rounded-lg text-[9px] sm:text-[10px] font-black transition-all ${trade.result === 'WIN' ? 'bg-green-500 text-white shadow-lg shadow-green-500/20' : 'bg-gray-800/50 text-gray-500 hover:text-gray-400'}`}
                          >
                            WIN
                          </button>
                          <button
                            onClick={() => handleUpdateTrade(i, 'result', 'LOSS')}
                            className={`flex-1 py-1.5 rounded-lg text-[9px] sm:text-[10px] font-black transition-all ${trade.result === 'LOSS' ? 'bg-red-500 text-white shadow-lg shadow-red-500/20' : 'bg-gray-800/50 text-gray-500 hover:text-gray-400'}`}
                          >
                            LOSS
                          </button>
                        </div>
                      </td>
                      <td className="px-2 sm:px-4 py-3">
                        <input
                          type="number"
                          value={trade.amount || ''}
                          onChange={(e) => handleUpdateTrade(i, 'amount', Number(e.target.value))}
                          placeholder="1.00"
                          className={`w-full max-w-[80px] bg-black/40 border border-gray-800 rounded-lg px-2 sm:px-3 py-1.5 text-xs font-black focus:border-[#D4AF37] outline-none ${
                            trade.amount > 0 ? 'text-white' : 'text-gray-600'
                          }`}
                        />
                      </td>
                      <td className="px-2 sm:px-4 py-3 text-right font-black text-xs">
                        {trade.result === 'WIN' ? (
                          <span className="text-green-400">+{trade.return.toFixed(2)}</span>
                        ) : trade.result === 'LOSS' ? (
                          <span className="text-red-400">-{trade.amount.toFixed(2)}</span>
                        ) : '-'}
                      </td>
                      <td className="px-2 sm:px-4 py-3 text-right font-black text-xs text-[#D4AF37]">
                        {trade.balance === '-' ? '-' : `$${trade.balance}`}
                      </td>
                      <td className="px-2 sm:px-4 py-3 text-center">
                        <input
                          type="number"
                          value={trade.payout || ''}
                          onChange={(e) => handleUpdateTrade(i, 'payout', Number(e.target.value))}
                          placeholder={String(payout)}
                          className={`w-full max-w-[60px] mx-auto bg-black/40 border border-gray-800 rounded-lg px-2 py-1.5 text-xs font-black text-center focus:border-[#D4AF37] outline-none ${
                            trade.payout > 0 ? 'text-white' : 'text-gray-600'
                          }`}
                        />
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
                <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mb-2 flex items-center justify-between">
                  <span>Initial Capital</span>
                  {marketInfo?.account_balance && marketInfo.account_balance > 0 ? (
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider ${
                      marketInfo.is_demo
                        ? 'bg-orange-500/10 border border-orange-500/30 text-orange-400'
                        : 'bg-green-500/10 border border-green-500/30 text-green-400'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${marketInfo.is_demo ? 'bg-orange-400' : 'bg-green-400'} animate-pulse`} />
                      {marketInfo.is_demo ? 'DEMO' : 'REAL'} • PO SYNC
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-gray-500/10 border border-gray-500/30 text-gray-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                      MANUAL
                    </span>
                  )}
                </label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600" />
                  <input
                    type="number"
                    value={initialCapital}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setInitialCapital(val);
                      localStorage.setItem('a2sniper_risk_capital', String(val));
                      // Reset all empty-row stakes to 0, then fill the first
                      // empty row with the recommended stake based on new balance.
                      const resetTrades = trades.map(t => {
                        if (!t.result) return { ...t, amount: 0 };
                        return t;
                      });
                      const filledTrades = fillFirstEmptyTradeStake(resetTrades, val, displayWinRate || 0, payout);
                      setTrades(filledTrades);
                      localStorage.setItem('a2sniper_risk_trades', JSON.stringify(filledTrades));
                    }}
                    className="w-full bg-black border border-gray-800 rounded-xl pl-10 pr-4 py-3 text-sm font-black text-white outline-none focus:border-[#D4AF37] transition-colors"
                  />
                </div>
                {marketInfo?.balance_last_updated && (
                  <div className="mt-1.5 text-[9px] text-gray-600 font-bold">
                    Last PO sync: {new Date(marketInfo.balance_last_updated).toLocaleTimeString()} • Source: {marketInfo.balance_source || 'unknown'}
                  </div>
                )}
              </div>

              <div>
                <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mb-2">Market Payout (%)</label>
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
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-gray-400">Session Counter</span>
                <div className="flex items-center gap-4 bg-black/40 p-1.5 rounded-xl border border-gray-800">
                  <button
                    onClick={() => setSessionCounter(Math.max(1, sessionCounter - 1))}
                    className="p-1 hover:bg-gray-800 rounded-lg text-gray-500 hover:text-white transition-colors"
                  >
                    <ChevronRight className="w-4 h-4 rotate-180" />
                  </button>
                  <span className="text-sm font-black text-white w-4 text-center">{sessionCounter}</span>
                  <button
                    onClick={() => setSessionCounter(sessionCounter + 1)}
                    className="p-1 hover:bg-gray-800 rounded-lg text-gray-500 hover:text-white transition-colors"
                  >
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
              Based on your current Winrate of <span className="text-green-400">{displayWinRate > 0 ? displayWinRate.toFixed(1) : 'N/A'}%</span>, the suggested stake for optimal growth:
            </p>
            <div className="bg-black/60 p-6 rounded-2xl border border-[#D4AF37]/30 text-center relative z-10">
              <p className="text-[10px] font-black text-[#D4AF37] uppercase tracking-[0.2em] mb-1">Suggested Stake</p>
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
                  Risk Management Alert — Level: {riskLevel}
                </h4>
                <p className="text-[10px] text-gray-500 font-bold leading-relaxed">
                  {riskLevel === 'Critical'
                    ? 'Your account is in significant loss. Immediately reduce your position sizes and consider taking a break.'
                    : riskLevel === 'High'
                    ? 'Your winrate or gain is negative. Reduce your stake sizes and stick to your risk management plan.'
                    : riskLevel === 'Medium'
                    ? 'Insufficient data or mixed performance. Discipline is essential — never exceed 5% of capital per trade.'
                    : 'Never exceed 10% of your capital on a single trade, even with sniper precision. Discipline is the key to success.'
                  }
                </p>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Reset Confirmation Dialog */}
      <AnimatePresence>
        {showResetConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
            onClick={() => setShowResetConfirm(false)}
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
                <h3 className="text-lg font-bold text-white">Delete Session</h3>
              </div>
              <p className="text-sm text-gray-400 mb-6">
                Are you sure you want to delete the current session? All trading data will be cleared and the session will be removed from the Trading Journal.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={confirmClearSession}
                  autoFocus
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-bold transition-colors"
                >
                  Delete
                </button>
                <button
                  onClick={() => setShowResetConfirm(false)}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-2 rounded-lg font-bold transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* New Session Confirmation Modal */}
      <AnimatePresence>
        {showNewSessionModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-6"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#121216] border border-[#D4AF37]/30 rounded-2xl p-6 max-w-sm w-full space-y-4"
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-orange-400" />
                <h3 className="text-white font-black text-sm uppercase tracking-widest">Unsaved Changes</h3>
              </div>
              <p className="text-xs text-gray-400 leading-relaxed">
                Your current session has unsaved trades that will be lost. Do you want to <span className="text-[#D4AF37] font-bold">save</span> this session before starting a new one, or <span className="text-red-400 font-bold">discard</span> it?
              </p>
              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  onClick={() => doNewSession()}
                  className="py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-[10px] font-black text-red-400 hover:bg-red-500/20 transition-all"
                >
                  Discard & New
                </button>
                <button
                  onClick={saveAndNewSession}
                  autoFocus
                  className="py-3 bg-[#D4AF37] border border-[#D4AF37] rounded-xl text-[10px] font-black text-black hover:bg-[#c5a059] transition-all flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" /> Save & New
                </button>
              </div>
              <button
                onClick={() => setShowNewSessionModal(false)}
                className="w-full text-[10px] text-gray-500 hover:text-white transition-colors py-1"
              >
                Cancel
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Session Counter Correction Modal */}
      <AnimatePresence>
        {showCounterModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-6"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0a0a0c] border border-[#D4AF37]/30 rounded-2xl p-6 max-w-md w-full space-y-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-[#D4AF37]/10 border border-[#D4AF37]/20 rounded-xl flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-[#D4AF37]" />
                </div>
                <h3 className="text-sm font-black text-white uppercase tracking-wider">Session Number Conflict</h3>
              </div>

              <p className="text-xs text-gray-400 font-bold leading-relaxed">
                {counterModalInfo.error}
              </p>

              <div className="bg-black/40 rounded-xl p-4 border border-white/5">
                <p className="text-[10px] text-gray-500 font-black uppercase tracking-widest mb-2">Correct Session Number</p>
                <p className="text-3xl font-black text-[#D4AF37]">#{counterModalInfo.expected}</p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowCounterModal(false)}
                  className="flex-1 py-3 rounded-xl text-xs font-black uppercase tracking-wider bg-white/[0.03] text-gray-400 border border-white/5 hover:bg-white/[0.06] hover:text-white transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmCounterCorrection}
                  autoFocus
                  className="flex-1 py-3 rounded-xl text-xs font-black uppercase tracking-wider bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black hover:from-[#c5a059] hover:to-[#D4AF37] transition-all"
                >
                  Save as #{counterModalInfo.expected}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
