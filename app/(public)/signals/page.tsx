'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Search, Filter, TrendingUp, TrendingDown, Clock, Target, Settings, Link2, Wifi, WifiOff, AlertTriangle, Zap, Award, RotateCcw, Loader2 } from 'lucide-react';
import { SignalCard } from '@/components/ui/signal-card';
import { useAppStore } from '@/lib/store';
import { useAuth } from '@/hooks/use-auth';
import { tradingPairs } from '@/lib/mock-data';
import { validateSSID } from '@/lib/validate-ssid';
import { toast } from 'sonner';

export default function SignalsPage() {
  useAuth();
  const { signals, totalSignals, totalActive, totalWon, totalLost, liveStatus, connectMarket, disconnectMarket, fetchMarketStatus, marketInfo, user, connectWithSaved, hasSavedSsid, reconnectAttempts, maxReconnectAttempts } = useAppStore();
  // SSID textarea — for one-time paste only. NOT persisted to localStorage.
  // After successful connect, the textarea is cleared and the SSID lives only
  // on the server (encrypted at rest). The "Reconnect" button uses the
  // server-side saved SSID via connectWithSaved().
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

  // NOTE: SSID is no longer loaded from localStorage on mount.
  // The server stores it (encrypted); the frontend only knows whether one
  // exists (via hasSavedSsid from the store, populated by fetchSsidStatus).

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
    // SSID textarea is for one-time paste only — do NOT persist to localStorage.
    setSsidState(val);
  };
  const [isRefreshing] = useState(false);

  // Track which signals have been client-side expired (countdown hit 0).
  // These are removed from the ACTIVE list immediately — no need to wait
  // for the backend's resolution_loop (which takes up to 10s).
  const [expiredSignalIds, setExpiredSignalIds] = useState<Set<string>>(new Set());

  // This function is called by the SignalCard when its countdown hits 0.
  // We expose it via the store so the card can trigger removal.
  useEffect(() => {
    // Listen for client-side expiry events from signal cards
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.signalId) {
        setExpiredSignalIds(prev => new Set(prev).add(detail.signalId));
      }
    };
    window.addEventListener('signal-expired', handler);
    return () => window.removeEventListener('signal-expired', handler);
  }, []);

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

      // If filtering for ACTIVE signals, HIDE signals that have been
      // client-side expired (countdown hit 0). These signals are waiting
      // for the backend to resolve them as WON/LOST, but the user should
      // not see them in the ACTIVE list anymore.
      if (selectedStatus === 'ACTIVE' && expiredSignalIds.has(signal.id)) {
        return false;
      }
      
      return matchesPair && matchesStatus && matchesDirection && matchesWinrate && matchesPayout;
    });

    // Always sort NEWEST FIRST (newest signals at the top of the list).
    if (selectedStatus === 'ACTIVE' || selectedStatus === 'ALL') {
      return result
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, 50);
    }

    return result.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }, [signals, selectedPayout, selectedPair, selectedStatus, selectedDirection, minWinrate, expiredSignalIds]);

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

  useEffect(() => {
    const store = useAppStore.getState();
    if (store.fetchSignals) store.fetchSignals();
    if (store.fetchMarketStatus) store.fetchMarketStatus();

    // Real-time refresh every 5s (was 1s — caused event-loop contention
    // with the backend trading loop, delaying signal delivery by 60+s).
    // 5s is fast enough for countdown accuracy (the card itself ticks
    // every 1s client-side) while keeping the backend responsive.
    const apiTimer = setInterval(() => {
      if (store.fetchSignals) store.fetchSignals();
      if (store.fetchMarketStatus) store.fetchMarketStatus();
    }, 5000);

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
      // SECURITY: clear the SSID textarea immediately after successful connect.
      // The SSID has been sent to the server (one-time transit) and is now
      // stored encrypted at rest. Keeping it in the textarea would leave it
      // visible in the DOM and accessible to any XSS.
      setSsidState('');
    }
    setIsConnecting(false);
  };

  const handleReconnect = async () => {
    setIsConnecting(true);
    setConnectError('');
    // Use the server-side saved SSID — no SSID transits the browser.
    const result = await connectWithSaved();
    if (result.success) {
      toast.success('Reconnection successful!');
    } else {
      setConnectError(result.message || 'Reconnection failed. The saved SSID may have expired — paste a new one from Pocket Option.');
    }
    setIsConnecting(false);
  };

  const handleReset = () => {
    // Set resetTimestamp — all signals older than NOW will be filtered out
    // by fetchSignals on every subsequent poll. This persists across the 5s
    // polling cycle — only NEW signals emitted after this moment will appear.
    const now = Date.now();
    useAppStore.setState({
      resetTimestamp: now,
      signals: [],
      totalSignals: 0,
      totalActive: 0,
      totalWon: 0,
      totalLost: 0,
    });
    setExpiredSignalIds(new Set());
    toast.success('Stats reset to zero. Fresh start!');
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
              
              <div className="flex items-center space-x-3 flex-wrap">
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
                  onClick={handleReset}
                  className="p-2 bg-[#0a0a0c] text-red-400 border border-white/5 rounded-xl hover:bg-red-500/10 hover:border-red-500/30 transition-colors"
                  title="Reset stats to zero"
                >
                  <RotateCcw className="w-5 h-5" />
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
                <Loader2 className="w-40 h-40 animate-spin text-[#D4AF37]" />
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
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Login en cours...
                        </>
                      ) : (
                        <>
                          <Zap className="w-4 h-4" />
                          Connect to Market
                        </>
                      )}
                    </button>

                    {/* Reconnect — uses the server-side saved SSID (no SSID transits the browser) */}
                    {hasSavedSsid && !isConnecting && (
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