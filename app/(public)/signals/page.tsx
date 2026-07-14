'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Search, Filter, TrendingUp, TrendingDown, Clock, Target, RefreshCw, Download, Settings, Link2, Check, Wifi, WifiOff, AlertTriangle, Zap, Award } from 'lucide-react';
import { SignalCard } from '@/components/ui/signal-card';
import { useAppStore } from '@/lib/store';
import { useAuth } from '@/hooks/use-auth';
import { tradingPairs } from '@/lib/mock-data';
import { validateSSID } from '@/lib/validate-ssid';
import { createBrandedPDF, drawSectionTitle, drawStatCard, drawTable, drawInfoRow, drawUserInfoCard, savePDF, PAGE, PDFUserInfo, fetchAvatarBase64 } from '@/lib/pdf-export';
import { toast } from 'sonner';

export default function SignalsPage() {
  useAuth();
  const { signals, totalSignals, totalActive, totalWon, totalLost, liveStatus, connectMarket, disconnectMarket, fetchMarketStatus, marketInfo, user, attemptReconnect, reconnectAttempts, maxReconnectAttempts } = useAppStore();
  // Persist SSID in localStorage so it survives page refreshes
  const [ssid, setSsidState] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  // ─── Persist filters in localStorage so they survive page navigation ───
  // When the user sets filters and leaves the page, then comes back, the
  // filters should still be there. Each filter has its own localStorage key.
  const [selectedPayout, setSelectedPayout] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('a2sniper_filter_payout') || 'ALL';
    }
    return 'ALL';
  });
  const [selectedPair, setSelectedPair] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('a2sniper_filter_pair') || 'ALL';
    }
    return 'ALL';
  });
  const [selectedStatus, setSelectedStatus] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('a2sniper_filter_status') || 'ALL';
    }
    return 'ALL';
  });
  const [selectedDirection, setSelectedDirection] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('a2sniper_filter_direction') || 'ALL';
    }
    return 'ALL';
  });
  const [minWinrate, setMinWinrate] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('a2sniper_filter_minWinrate');
      return saved ? Number(saved) : 0;
    }
    return 0;
  });

  // Load persisted SSID on mount
  useEffect(() => {
    const saved = localStorage.getItem('a2sniper_last_ssid');
    if (saved) setSsidState(saved);
  }, []);

  // Persist filters whenever they change
  useEffect(() => {
    localStorage.setItem('a2sniper_filter_payout', selectedPayout);
  }, [selectedPayout]);
  useEffect(() => {
    localStorage.setItem('a2sniper_filter_pair', selectedPair);
  }, [selectedPair]);
  useEffect(() => {
    localStorage.setItem('a2sniper_filter_status', selectedStatus);
  }, [selectedStatus]);
  useEffect(() => {
    localStorage.setItem('a2sniper_filter_direction', selectedDirection);
  }, [selectedDirection]);
  useEffect(() => {
    localStorage.setItem('a2sniper_filter_minWinrate', String(minWinrate));
  }, [minWinrate]);

  const setSsid = (val: string) => {
    setSsidState(val);
    localStorage.setItem('a2sniper_last_ssid', val);
  };
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [justExported, setJustExported] = useState(false);

  const filteredSignals = useMemo(() => {
    let result = signals.filter(signal => {
      const matchesPair = selectedPair === 'ALL' || signal.pair === selectedPair;
      const matchesStatus = selectedStatus === 'ALL' || 
                           (selectedStatus === 'EXPIRED' ? ['EXPIRED', 'WON', 'LOST'].includes(signal.status || 'EXPIRED') : signal.status === selectedStatus);
      const matchesDirection = selectedDirection === 'ALL' || signal.direction === selectedDirection;
      const matchesWinrate = signal.winrate >= minWinrate;
      
      let matchesPayout = true;
      if (selectedPayout !== 'ALL') {
        const payoutVal = signal.payout || 0;
        const minPayout = Number(selectedPayout);
        matchesPayout = payoutVal >= minPayout;
      }
      
      return matchesPair && matchesStatus && matchesDirection && matchesWinrate && matchesPayout;
    });

    if (selectedStatus === 'ACTIVE' || selectedStatus === 'ALL') {
      const latest12 = result
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, 50);
      
      return latest12.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }

    return result;
  }, [signals, selectedPayout, selectedPair, selectedStatus, selectedDirection, minWinrate]);

  // Global stats — sourced from backend SQL COUNT aggregates (accurate regardless
  // of pagination). Falls back to in-memory computation only if backend hasn't
  // returned totals yet (e.g., first render before fetch completes).
  const stats = useMemo(() => {
    const useBackend = totalSignals > 0 || totalWon > 0 || totalLost > 0 || totalActive > 0;
    const total = useBackend ? totalSignals : signals.length;
    const active = useBackend ? totalActive : signals.filter(s => s.status === 'ACTIVE').length;
    const won = useBackend ? totalWon : signals.filter(s => s.status === 'WON').length;
    const lost = useBackend ? totalLost : signals.filter(s => s.status === 'LOST').length;
    const settled = won + lost;
    const winrate = settled > 0 ? Math.round((won / settled) * 100) : 0;
    return {
      total,
      active,
      won,
      lost,
      settled,
      winrate,
      // How many signals are loaded in-memory vs. total in DB — for the "showing N of M" indicator
      loaded: signals.length,
      isPaginated: useBackend && total > signals.length,
    };
  }, [signals, totalSignals, totalActive, totalWon, totalLost]);

  // ─── Per-session stats ────────────────────────────────────────────────────
  // Groups all signals by session_id. The "current" session is whichever session
  // has at least one ACTIVE signal, or the most recent session if none are active.
  // Each session shows: trade count, won, lost, winrate, target gap (70-80%).
  const sessions = useMemo(() => {
    const byId = new Map<string, {
      id: string;
      total: number;
      active: number;
      won: number;
      lost: number;
      settled: number;
      winrate: number;
      firstTimestamp: Date;
      lastTimestamp: Date;
    }>();

    for (const s of signals) {
      const sid = s.session_id || 'LEGACY';
      let entry = byId.get(sid);
      if (!entry) {
        entry = {
          id: sid,
          total: 0, active: 0, won: 0, lost: 0, settled: 0, winrate: 0,
          firstTimestamp: s.timestamp,
          lastTimestamp: s.timestamp,
        };
        byId.set(sid, entry);
      }
      entry.total += 1;
      if (s.status === 'ACTIVE') entry.active += 1;
      if (s.status === 'WON') entry.won += 1;
      if (s.status === 'LOST') entry.lost += 1;
      if (s.timestamp < entry.firstTimestamp) entry.firstTimestamp = s.timestamp;
      if (s.timestamp > entry.lastTimestamp) entry.lastTimestamp = s.timestamp;
    }

    const arr = Array.from(byId.values()).map(e => {
      e.settled = e.won + e.lost;
      e.winrate = e.settled > 0 ? Math.round((e.won / e.settled) * 100) : 0;
      return e;
    });
    // Sort: sessions with active signals first, then by most recent timestamp
    arr.sort((a, b) => {
      if (a.active > 0 && b.active === 0) return -1;
      if (a.active === 0 && b.active > 0) return 1;
      return b.lastTimestamp.getTime() - a.lastTimestamp.getTime();
    });
    return arr;
  }, [signals]);

  const currentSession = sessions[0] || null;
  const [sessionFilter, setSessionFilter] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('a2sniper_filter_session') || 'CURRENT';
    }
    return 'CURRENT';
  });
  const handleSessionChange = (v: string) => {
    setSessionFilter(v);
    if (typeof window !== 'undefined') localStorage.setItem('a2sniper_filter_session', v);
  };
  const sessionFilterResolved = sessionFilter === 'CURRENT'
    ? (currentSession?.id || 'ALL')
    : sessionFilter;
  const sessionSignals = useMemo(() => {
    if (sessionFilterResolved === 'ALL') return signals;
    return signals.filter(s => (s.session_id || 'LEGACY') === sessionFilterResolved);
  }, [signals, sessionFilterResolved]);
  const sessionStats = useMemo(() => {
    const active = sessionSignals.filter(s => s.status === 'ACTIVE').length;
    const won = sessionSignals.filter(s => s.status === 'WON').length;
    const lost = sessionSignals.filter(s => s.status === 'LOST').length;
    const settled = won + lost;
    const winrate = settled > 0 ? Math.round((won / settled) * 100) : 0;
    return { total: sessionSignals.length, active, won, lost, settled, winrate };
  }, [sessionSignals]);

  useEffect(() => {
    const store = useAppStore.getState();
    if (store.fetchSignals) store.fetchSignals();
    if (store.fetchMarketStatus) store.fetchMarketStatus();

    // Real-time refresh every 1s (user requirement: never miss an update)
    const apiTimer = setInterval(() => {
      if (store.fetchSignals) store.fetchSignals();
      if (store.fetchMarketStatus) store.fetchMarketStatus();
    }, 1000);

    return () => clearInterval(apiTimer);
  }, []);

  const handleConnect = async () => {
    if (!ssid) return;

    const validation = validateSSID(ssid);
    if (validation.status === 'invalid') {
      setConnectError(validation.message);
      return;
    }

    // Use the normalized SSID (deep-cleaned: invisible chars stripped, format fixed)
    const normalizedSSID = validation.normalized || ssid;

    setIsConnecting(true);
    setConnectError('');
    const result = await connectMarket(normalizedSSID);
    if (!result.success) {
      setConnectError(result.message);
    } else {
      toast.success('Connected to Pocket Option market!');
    }
    // NOTE: We intentionally do NOT clear the SSID field on success or failure
    // so the user can see what they pasted and it survives a page refresh.
    setIsConnecting(false);
  };

  const handleReconnect = async () => {
    setIsConnecting(true);
    setConnectError('');
    const result = await attemptReconnect();
    if (result.success) {
      toast.success('Reconnection successful!');
    } else {
      setConnectError(result.message || 'Reconnection failed. Make sure your Pocket Option account is still connected, or paste a new SSID.');
    }
    setIsConnecting(false);
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    const store = useAppStore.getState();
    if (store.fetchSignals) {
      await store.fetchSignals();
    }
    setIsRefreshing(false);
  };

  const handleExportSignals = async () => {
    if (user?.avatar) await fetchAvatarBase64(user.avatar);
    const pdfUser: PDFUserInfo = {
      name: user?.name,
      email: user?.email,
      plan: user?.plan,
      userId: user?.id,
      avatarUrl: user?.avatar,
    };
    const doc = createBrandedPDF('Signals Report', 'Filtered trading signals and statistics', pdfUser);
    let y = 58;

    // User info card
    y = drawUserInfoCard(doc, y, pdfUser);

    // Filter info
    y = drawSectionTitle(doc, 'Filtres appliques', y);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Pair', selectedPair === 'ALL' ? 'All' : selectedPair);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Direction', selectedDirection === 'ALL' ? 'All' : selectedDirection);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Status', selectedStatus === 'ALL' ? 'All' : selectedStatus);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Payout', selectedPayout === 'ALL' ? 'All' : `>${selectedPayout}%`);
    y += 2;

    // Stats
    y = drawSectionTitle(doc, 'Statistiques', y);
    const cardW = 42;
    const gap = 3;
    y = drawStatCard(doc, PAGE.marginL, y, cardW, 'Total', String(stats.total));
    y = drawStatCard(doc, PAGE.marginL + cardW + gap, y - 21, cardW, 'Active', String(stats.active), { valueColor: '#3B82F6' });
    y = drawStatCard(doc, PAGE.marginL + (cardW + gap) * 2, y - 21, cardW, 'Gagnes', String(stats.won), { valueColor: '#22C55E' });
    y = drawStatCard(doc, PAGE.marginL + (cardW + gap) * 3, y - 21, cardW, 'Losts', String(stats.lost), { valueColor: '#EF4444' });
    y += 6;

    // Signals table
    y = drawSectionTitle(doc, 'Liste des signaux', y);
    if (filteredSignals.length > 0) {
      const headers = [
        { label: 'Pair', width: 28 },
        { label: 'Direction', width: 22, align: 'center' as const },
        { label: 'Winrate', width: 20, align: 'center' as const },
        { label: 'Status', width: 20, align: 'center' as const },
        { label: 'Payout', width: 18, align: 'right' as const },
        { label: 'Expiration', width: 35, align: 'right' as const },
      ];
      const rows = filteredSignals.slice(0, 50).map(s => [
        s.pair || '-',
        s.direction || '-',
        s.winrate ? `${s.winrate}%` : '-',
        s.status || '-',
        s.payout ? `${s.payout}%` : '-',
        s.timestamp ? new Date(s.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-',
      ]);
      y = drawTable(doc, PAGE.marginL, y, headers, rows);
    } else {
      doc.setFontSize(8);
      doc.setTextColor(107, 114, 128);
      doc.text('No signals found with these filters.', PAGE.marginL + 4, y + 4);
    }

    const dateStr = new Date().toISOString().split('T')[0];
    savePDF(doc, `a2sniper-signaux-${dateStr}.pdf`, pdfUser);
    setJustExported(true);
    setTimeout(() => setJustExported(false), 2500);
    toast.success('Rapport PDF exporte avec succes !');
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
                <h1 className="text-2xl font-black text-white uppercase tracking-tight">
                  A2Sniper Trading Signals
                </h1>
                <p className="text-gray-400 max-w-3xl text-xs font-bold leading-relaxed mt-1">
                  {liveStatus === 'LIVE' 
                    ? "Welcome to A2Sniper 3.0, the cutting-edge assistant for high-frequency trading. The system is successfully connected to the live market via WebSocket."
                    : "Welcome to A2Sniper 3.0, the cutting-edge assistant for high-frequency trading. Please configure the SSID below to connect the analyzer to the market."}
                </p>
              </div>
              
              <div className="flex items-center space-x-3">
                <div 
                  title={liveStatus === 'LIVE' ? "ANALYSIS BASED ON REAL DATA" : "SYSTEM DISCONNECTED FROM MARKET"}
                  className="flex items-center px-3 py-2 bg-[#0a0a0c] rounded-xl border border-white/5 shadow-sm cursor-help transition-all"
                >
                  <span className="relative flex h-3 w-3 mr-2">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${liveStatus === 'LIVE' ? 'bg-green-400' : 'bg-red-400'} opacity-75`}></span>
                    <span className={`relative inline-flex rounded-full h-3 w-3 ${liveStatus === 'LIVE' ? 'bg-green-500' : 'bg-red-500'}`}></span>
                  </span>
                  <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">
                    {liveStatus === 'LIVE' ? 'MARKET LIVE' : 'DISCONNECTED'}
                  </span>
                </div>

                {liveStatus === 'LIVE' && (
                  <button
                    onClick={() => disconnectMarket()}
                    className="px-3 py-2 bg-red-500/10 text-red-500 rounded-xl text-[10px] font-black uppercase tracking-wider hover:bg-red-500 hover:text-white transition-all border border-red-500/20"
                  >
                    Disconnect
                  </button>
                )}

                <button
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  className="p-2 bg-[#0a0a0c] text-[#D4AF37] border border-white/5 rounded-xl hover:bg-white/[0.03] transition-colors disabled:opacity-50"
                  title="Actualiser les signaux"
                >
                  <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
                </button>
                
                <button
                  onClick={handleExportSignals}
                  className={`p-2 rounded-xl transition-colors ${justExported ? 'bg-green-500 text-white border border-green-400' : 'bg-[#0a0a0c] text-green-500 border border-white/5 hover:bg-white/[0.03]'}`}
                  title={justExported ? 'PDF exported!' : 'Export signals'}
                >
                  {justExported ? <Check className="w-5 h-5" /> : <Download className="w-5 h-5" />}
                </button>
              </div>
            </motion.div>
          </div>

          {/* Connection Panel (if disconnected) */}
          {liveStatus === 'DISCONNECTED' && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-[#0a0a0c]/80 rounded-2xl shadow-xl border border-[#D4AF37]/20 p-8 mb-10 overflow-hidden relative backdrop-blur-md"
            >
              <div className="absolute top-0 right-0 p-4 opacity-[0.02] pointer-events-none">
                <RefreshCw className="w-40 h-40" />
              </div>
              
              <div className="flex flex-col lg:flex-row gap-10 items-start">
                <div className="flex-1">
                  <h2 className="text-lg font-black text-white uppercase tracking-wider mb-4 flex items-center gap-3">
                    <div className="w-10 h-10 bg-[#D4AF37]/10 border border-[#D4AF37]/20 rounded-xl flex items-center justify-center text-[#D4AF37]">
                      <Settings className="w-5 h-5" />
                    </div>
                    Market Login
                  </h2>
                  <p className="text-xs text-gray-400 mb-6 font-bold leading-relaxed">
                    For A2Sniper 3.0 to analyze the Pocket Option WebSocket stream in real time, you must enter the active authentication string (SSID) below.
                  </p>
                  
                  <div className="space-y-4 mb-8">
                    <h3 className="font-black text-xs text-white uppercase tracking-wider">Connection protocol:</h3>
                    <ul className="space-y-3 font-bold text-xs text-gray-400">
                      <li className="flex gap-3">
                        <span className="flex-shrink-0 w-5 h-5 bg-[#D4AF37]/10 border border-[#D4AF37]/20 text-[#D4AF37] rounded-full flex items-center justify-center font-bold text-[10px]">1</span>
                        <span>Log in to your account at <a href="https://pocketoption.com" target="_blank" rel="noopener noreferrer" className="text-[#D4AF37] hover:underline">pocketoption.com</a></span>
                      </li>
                      <li className="flex gap-3">
                        <span className="flex-shrink-0 w-5 h-5 bg-[#D4AF37]/10 border border-[#D4AF37]/20 text-[#D4AF37] rounded-full flex items-center justify-center font-bold text-[10px]">2</span>
                        <span>Open Developer Tools (F12) -&gt; Network tab</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="flex-shrink-0 w-5 h-5 bg-[#D4AF37]/10 border border-[#D4AF37]/20 text-[#D4AF37] rounded-full flex items-center justify-center font-bold text-[10px]">3</span>
                        <span>Filter by &apos;WS&apos; (WebSockets) and find the connection frame starting with &apos;42[&quot;auth&quot;...&apos;</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="flex-shrink-0 w-5 h-5 bg-[#D4AF37]/10 border border-[#D4AF37]/20 text-[#D4AF37] rounded-full flex items-center justify-center font-bold text-[10px]">4</span>
                        <span>Copy the entire frame text and paste it into the field on the right.</span>
                      </li>
                    </ul>
                  </div>

                  <div className="flex items-center gap-4 p-4 bg-[#D4AF37]/5 border border-[#D4AF37]/10 rounded-xl text-gray-400 text-xs font-bold leading-relaxed">
                    <Target className="w-5 h-5 text-[#D4AF37] flex-shrink-0" />
                    <p>The SSID remains active as long as you don't disconnect your Pocket Option account — even if you close the browser. It only changes if you log out and log back in to Pocket Option.</p>
                  </div>
                </div>

                <div className="w-full lg:w-96 space-y-6">
                  <div className="bg-[#050507] p-6 rounded-2xl border border-white/5">
                    <label className="block text-[10px] font-black text-gray-400 mb-2 uppercase tracking-widest">SSID (Auth Frame)</label>
                    <textarea
                      value={ssid}
                      onChange={(e) => { setSsid(e.target.value); setConnectError(''); }}
                      placeholder='Paste here the 42["auth",{...}] frame copied from F12 → Network → WS'
                      className={`w-full h-32 px-4 py-3 bg-white/[0.02] border rounded-xl focus:outline-none text-[10px] font-mono mb-2 resize-none text-white transition-colors overflow-auto ${
                        ssid && validateSSID(ssid).status === 'invalid'
                          ? 'border-red-500/50 focus:border-red-500'
                          : ssid && validateSSID(ssid).status === 'valid'
                          ? 'border-green-500/50 focus:border-green-500'
                          : 'border-white/10 focus:border-[#D4AF37]'
                      }`}
                    />
                    {(() => {
                      const validation = validateSSID(ssid);
                      if (validation.status === 'none') return null;
                      
                      const colorClass = 
                        validation.status === 'valid' ? 'text-green-500' :
                        validation.status === 'partial' ? 'text-yellow-500' :
                        'text-red-500';

                      const prefix = 
                        validation.status === 'valid' ? '✓ ' :
                        validation.status === 'partial' ? '⚠ ' :
                        '✗ ';

                      return (
                        <div className={`text-[10px] ${colorClass} mb-4 font-bold`}>
                          <p>{prefix}{validation.message}</p>
                          {validation.details?.isDemoAccount !== undefined && (
                            <p className="mt-1 text-gray-500">
                              Mode: <span className={validation.details.isDemoAccount ? 'text-yellow-400' : 'text-green-400'}>
                                {validation.details.isDemoAccount ? 'DEMO ACCOUNT' : 'REAL ACCOUNT'}
                              </span>
                              {validation.details.uid && <> · UID: {validation.details.uid}</>}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                    


                    <button
                      onClick={handleConnect}
                      disabled={isConnecting || !ssid}
                      className={`w-full py-4 rounded-xl font-black uppercase tracking-[0.2em] text-xs transition-all flex items-center justify-center gap-2 ${
                        isConnecting 
                          ? 'bg-gray-800 text-gray-500 cursor-not-allowed' 
                          : 'bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black hover:from-[#c5a059] hover:to-[#D4AF37] shadow-[0_0_20px_rgba(212,175,55,0.15)]'
                      }`}
                    >
                      {isConnecting ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          Login en cours...
                        </>
                      ) : (
                        <>
                          <Zap className="w-4 h-4" />
                          Connect to Market
                        </>
                      )}
                    </button>

                    {/* Quick Reconnect — uses saved SSID from localStorage */}
                    {ssid && !isConnecting && (
                      <button
                        onClick={handleReconnect}
                        className="w-full py-3 rounded-xl font-black uppercase tracking-[0.15em] text-[10px] transition-all flex items-center justify-center gap-2 bg-white/[0.03] text-gray-400 border border-white/5 hover:bg-white/[0.06] hover:text-white hover:border-[#D4AF37]/30"
                      >
                        <Wifi className="w-3.5 h-3.5" />
                        Reconnect with saved SSID
                      </button>
                    )}
                    
                    {connectError && (
                      <div className="mt-4 text-[10px] font-bold text-red-400 bg-red-500/10 p-4 rounded-xl border border-red-500/20 space-y-2">
                        <p className="font-black text-red-500 uppercase tracking-wider flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" /> Connection failed
                        </p>
                        <p className="leading-relaxed">{connectError}</p>
                        <a
                          href="https://pocketoption.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block mt-1 text-[#D4AF37] underline hover:text-yellow-300 transition-colors"
                        >
                          → Go to pocketoption.com (if you logged out of your account)
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
          {liveStatus === 'LIVE' && (
            <>
              {/* Stats Bar */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
                {[
                  {
                    label: 'Total Signals',
                    value: stats.total,
                    sub: stats.isPaginated
                      ? `${stats.settled} settled · showing ${stats.loaded} of ${stats.total}`
                      : `${stats.settled} settled`,
                    color: 'text-gray-400 bg-white/[0.02]',
                    icon: TrendingUp,
                  },
                  { label: 'Active', value: stats.active, sub: 'in progress', color: 'text-[#D4AF37] bg-[#D4AF37]/10', icon: Clock },
                  { label: 'Won', value: stats.won, sub: 'closed wins', color: 'text-green-500 bg-green-500/10', icon: Target },
                  { label: 'Lost', value: stats.lost, sub: 'closed losses', color: 'text-red-500 bg-red-500/10', icon: TrendingDown },
                  {
                    label: 'Winrate',
                    value: `${stats.winrate}%`,
                    sub: stats.winrate >= 70 ? 'on target' : stats.winrate >= 60 ? 'below target' : 'needs review',
                    color:
                      stats.winrate >= 70
                        ? 'text-green-500 bg-green-500/10'
                        : stats.winrate >= 60
                        ? 'text-yellow-500 bg-yellow-500/10'
                        : 'text-red-500 bg-red-500/10',
                    icon: Award,
                  },
                ].map((card, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: index * 0.1 }}
                    className="bg-[#0a0a0c]/80 border border-white/5 p-5 rounded-2xl backdrop-blur-md"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1 truncate">{card.label}</p>
                        <p className="text-2xl font-black text-white tracking-tight leading-none">{card.value}</p>
                        <p className="text-[9px] text-gray-600 font-bold uppercase tracking-wider mt-1.5 truncate">{card.sub}</p>
                      </div>
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${card.color}`}>
                        <card.icon className="w-4 h-4" />
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>

              {/* Per-Session Panel — 10 trades per session, target winrate 70-80% */}
              {sessions.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.5 }}
                  className="bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-2xl backdrop-blur-md mb-8"
                >
                  <div className="flex flex-col lg:flex-row gap-6 items-start lg:items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <Award className="w-4 h-4 text-[#D4AF37]" />
                        <h3 className="text-xs font-black text-white uppercase tracking-wider">Trading Session</h3>
                        <span className="text-[10px] text-gray-600 font-bold uppercase tracking-wider">10 trades per session · target 70-80%</span>
                      </div>
                      {currentSession ? (
                        <>
                          <p className="text-[10px] text-gray-500 font-mono mb-3 truncate">
                            {currentSession.id} · {currentSession.total}/10 trades ·{' '}
                            {currentSession.firstTimestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                            {' → '}
                            {currentSession.lastTimestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                          </p>
                          <div className="flex flex-wrap items-center gap-4 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="text-gray-500 font-bold uppercase text-[10px]">Won</span>
                              <span className="text-green-500 font-black">{currentSession.won}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-gray-500 font-bold uppercase text-[10px]">Lost</span>
                              <span className="text-red-500 font-black">{currentSession.lost}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-gray-500 font-bold uppercase text-[10px]">Active</span>
                              <span className="text-[#D4AF37] font-black">{currentSession.active}</span>
                            </div>
                            <div className="flex items-center gap-2 pl-3 border-l border-white/10">
                              <span className="text-gray-500 font-bold uppercase text-[10px]">Winrate</span>
                              <span className={`font-black text-lg ${
                                currentSession.winrate >= 70 ? 'text-green-500'
                                : currentSession.winrate >= 60 ? 'text-yellow-500'
                                : 'text-red-500'
                              }`}>
                                {currentSession.winrate}%
                              </span>
                              {currentSession.settled > 0 && (
                                <span className="text-[10px] text-gray-600 font-bold">
                                  ({currentSession.won}/{currentSession.settled} settled)
                                </span>
                              )}
                            </div>
                          </div>
                          {/* Session progress bar */}
                          <div className="mt-3 h-1.5 bg-white/[0.03] rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all ${
                                currentSession.winrate >= 70 ? 'bg-green-500'
                                : currentSession.winrate >= 60 ? 'bg-yellow-500'
                                : 'bg-red-500'
                              }`}
                              style={{ width: `${Math.min(currentSession.winrate, 100)}%` }}
                            />
                          </div>
                          {/* Trade dots — 10 circles, one per trade slot, filled by outcome */}
                          <div className="flex gap-1.5 mt-3">
                            {(() => {
                              // Compute session signals ONCE, then index into the array
                              const sessionSigs = signals
                                .filter(s => (s.session_id || 'LEGACY') === currentSession.id)
                                .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                              return Array.from({ length: 10 }).map((_, i) => {
                                const sig = sessionSigs[i];
                                const color = !sig
                                  ? 'bg-white/[0.04] border-white/5'
                                  : sig.status === 'WON' ? 'bg-green-500/20 border-green-500/40'
                                  : sig.status === 'LOST' ? 'bg-red-500/20 border-red-500/40'
                                  : sig.status === 'ACTIVE' ? 'bg-[#D4AF37]/20 border-[#D4AF37]/40'
                                  : 'bg-white/[0.04] border-white/5';
                                return (
                                  <div
                                    key={i}
                                    title={sig ? `Trade ${i + 1}: ${sig.pair} ${sig.direction} — ${sig.status}` : `Trade ${i + 1}: pending`}
                                    className={`w-6 h-6 rounded-md border ${color} flex items-center justify-center text-[9px] font-bold text-gray-600`}
                                  >
                                    {i + 1}
                                  </div>
                                );
                              });
                            })()}
                          </div>
                        </>
                      ) : (
                        <p className="text-xs text-gray-500 font-bold">No sessions yet. Sessions start when the first signal is emitted.</p>
                      )}
                    </div>

                    {/* Session picker */}
                    <div className="w-full lg:w-72 flex-shrink-0">
                      <label className="block text-[10px] font-black text-gray-500 mb-2 uppercase tracking-widest">View Session</label>
                      <select
                        value={sessionFilter}
                        onChange={(e) => handleSessionChange(e.target.value)}
                        className="w-full px-4 py-2.5 bg-[#050507] border border-white/5 rounded-xl focus:outline-none focus:border-[#D4AF37] text-xs font-bold text-white"
                      >
                        <option value="CURRENT">
                          {currentSession ? `Current (${currentSession.id.slice(-6)})` : 'Current'}
                        </option>
                        <option value="ALL">All Sessions (overview)</option>
                        {sessions.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.id === 'LEGACY' ? 'Legacy (pre-session)' : s.id.slice(-12)} — {s.winrate}% ({s.total}/10)
                          </option>
                        ))}
                      </select>
                      <p className="text-[10px] text-gray-600 font-bold mt-2 leading-relaxed">
                        {sessionFilter === 'ALL'
                          ? 'Showing aggregate stats across all sessions.'
                          : sessionFilter === 'CURRENT'
                          ? 'Auto-follows the active session. Stats below reflect this session only.'
                          : 'Stats below reflect the selected session only.'}
                      </p>
                    </div>
                  </div>

                  {/* Per-session mini-stats (filtered) */}
                  {sessionFilter !== 'ALL' && (
                    <div className="grid grid-cols-4 gap-3 mt-5 pt-5 border-t border-white/5">
                      {[
                        { label: 'Trades', value: sessionStats.total, color: 'text-white' },
                        { label: 'Won', value: sessionStats.won, color: 'text-green-500' },
                        { label: 'Lost', value: sessionStats.lost, color: 'text-red-500' },
                        {
                          label: 'Winrate',
                          value: `${sessionStats.winrate}%`,
                          color: sessionStats.winrate >= 70 ? 'text-green-500'
                            : sessionStats.winrate >= 60 ? 'text-yellow-500'
                            : 'text-red-500',
                        },
                      ].map((m, i) => (
                        <div key={i} className="text-center">
                          <p className="text-[9px] text-gray-600 font-black uppercase tracking-widest mb-1">{m.label}</p>
                          <p className={`text-xl font-black ${m.color}`}>{m.value}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </motion.div>
              )}

              {/* Filters Panel */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.4 }}
                className="bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-2xl backdrop-blur-md mb-8"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                  {/* Pair Filter */}
                  <select
                    value={selectedPair}
                    onChange={(e) => setSelectedPair(e.target.value)}
                    className="w-full px-4 py-2.5 bg-[#050507] border border-white/5 rounded-xl focus:outline-none focus:border-[#D4AF37] text-xs font-bold text-white"
                  >
                    <option value="ALL">All Pairs</option>
                    {tradingPairs.map(pair => (
                      <option key={pair.symbol} value={pair.symbol}>
                        {pair.symbol}
                      </option>
                    ))}
                  </select>

                  {/* Status Filter */}
                  <select
                    value={selectedStatus}
                    onChange={(e) => setSelectedStatus(e.target.value)}
                    className="w-full px-4 py-2.5 bg-[#050507] border border-white/5 rounded-xl focus:outline-none focus:border-[#D4AF37] text-xs font-bold text-white"
                  >
                    <option value="ALL">All Statuses</option>
                    <option value="ACTIVE">Active</option>
                    <option value="WON">Won</option>
                    <option value="LOST">Lost</option>
                    <option value="EXPIRED">Expired</option>
                  </select>

                  {/* Direction Filter */}
                  <select
                    value={selectedDirection}
                    onChange={(e) => setSelectedDirection(e.target.value)}
                    className="w-full px-4 py-2.5 bg-[#050507] border border-white/5 rounded-xl focus:outline-none focus:border-[#D4AF37] text-xs font-bold text-white"
                  >
                    <option value="ALL">All Directions</option>
                    <option value="CALL">CALL</option>
                    <option value="PUT">PUT</option>
                  </select>

                  {/* Winrate Filter */}
                  <select
                    value={minWinrate}
                    onChange={(e) => setMinWinrate(Number(e.target.value))}
                    className="w-full px-4 py-2.5 bg-[#050507] border border-white/5 rounded-xl focus:outline-none focus:border-[#D4AF37] text-xs font-bold text-white"
                  >
                    <option value="0">All Winrates</option>
                    <option value="70">70%+</option>
                    <option value="75">75%+</option>
                    <option value="80">80%+</option>
                    <option value="85">85%+</option>
                    <option value="90">90%+</option>
                    <option value="95">95%+</option>
                  </select>

                  {/* Payout Filter */}
                  <select
                    value={selectedPayout}
                    onChange={(e) => setSelectedPayout(e.target.value)}
                    className="w-full px-4 py-2.5 bg-[#050507] border border-[#D4AF37]/20 focus:border-[#D4AF37] rounded-xl focus:outline-none text-xs font-bold text-white transition-colors"
                  >
                    <option value="ALL">All Payouts</option>
                    <option value="70">&ge; 70% Payout</option>
                    <option value="75">&ge; 75% Payout</option>
                    <option value="80">&ge; 80% Payout</option>
                    <option value="85">&ge; 85% Payout</option>
                    <option value="90">&ge; 90% Payout</option>
                    <option value="92">&ge; 92% Payout</option>
                    <option value="95">&ge; 95% Payout</option>
                  </select>
                </div>
              </motion.div>

              {/* Signals Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredSignals.map((signal, index) => (
                  <motion.div
                    key={signal.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: index * 0.1 }}
                  >
                    <SignalCard signal={signal} />
                  </motion.div>
                ))}
              </div>

              {/* Empty State */}
              {filteredSignals.length === 0 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5 }}
                  className="text-center py-16"
                >
                  <div className="w-16 h-16 bg-white/[0.02] border border-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Filter className="w-6 h-6 text-gray-500" />
                  </div>
                  <h3 className="text-sm font-black text-white uppercase mb-2">No signals found</h3>
                  <p className="text-xs text-gray-500 font-bold">Adjust your filter settings to refresh the stream.</p>
                </motion.div>
              )}
            </>
          )}
    </div>
  );
}