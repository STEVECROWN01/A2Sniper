'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Search, Filter, TrendingUp, Clock, Target, RefreshCw, Download, Settings, Link2, Check, Wifi, WifiOff, AlertTriangle, Zap } from 'lucide-react';
import { SignalCard } from '@/components/ui/signal-card';
import { useAppStore } from '@/lib/store';
import { useAuth } from '@/hooks/use-auth';
import { tradingPairs } from '@/lib/mock-data';
import { validateSSID } from '@/lib/validate-ssid';
import { createBrandedPDF, drawSectionTitle, drawStatCard, drawTable, drawInfoRow, drawUserInfoCard, savePDF, PAGE, PDFUserInfo, fetchAvatarBase64 } from '@/lib/pdf-export';
import { toast } from 'sonner';

export default function SignalsPage() {
  useAuth();
  const { signals, liveStatus, connectMarket, disconnectMarket, fetchMarketStatus, marketInfo, user, attemptReconnect, reconnectAttempts, maxReconnectAttempts } = useAppStore();
  // Persist SSID in localStorage so it survives page refreshes
  const [ssid, setSsidState] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [selectedPayout, setSelectedPayout] = useState('ALL');

  // Load persisted SSID on mount
  useEffect(() => {
    const saved = localStorage.getItem('a2sniper_last_ssid');
    if (saved) setSsidState(saved);
  }, []);

  const setSsid = (val: string) => {
    setSsidState(val);
    localStorage.setItem('a2sniper_last_ssid', val);
  };
  const [selectedPair, setSelectedPair] = useState('ALL');
  const [selectedStatus, setSelectedStatus] = useState('ALL');
  const [selectedDirection, setSelectedDirection] = useState('ALL');
  const [minWinrate, setMinWinrate] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [justExported, setJustExported] = useState(false);

  const filteredSignals = useMemo(() => {
    let result = signals.filter(signal => {
      const matchesPair = selectedPair === 'ALL' || signal.pair === selectedPair;
      const matchesStatus = selectedStatus === 'ALL' || 
                           (selectedStatus === 'EXPIRED' ? (new Date(signal.timestamp).getTime() < Date.now() && signal.status === 'ACTIVE') : signal.status === selectedStatus);
      const matchesDirection = selectedDirection === 'ALL' || signal.direction === selectedDirection;
      const matchesWinrate = signal.winrate >= minWinrate;
      
      let matchesPayout = true;
      if (selectedPayout !== 'ALL') {
        const payoutVal = signal.payout || 0;
        if (selectedPayout === '75') matchesPayout = payoutVal > 75;
        else if (selectedPayout === '80') matchesPayout = payoutVal > 80;
        else if (selectedPayout === '85') matchesPayout = payoutVal > 85;
        else if (selectedPayout === '90') matchesPayout = payoutVal > 90;
        else if (selectedPayout === '92') matchesPayout = payoutVal >= 92;
      }
      
      return matchesPair && matchesStatus && matchesDirection && matchesWinrate && matchesPayout;
    });

    if (selectedStatus === 'ACTIVE' || selectedStatus === 'ALL') {
      const latest12 = result
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, 12);
      
      return latest12.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }

    return result;
  }, [signals, selectedPayout, selectedPair, selectedStatus, selectedDirection, minWinrate]);

  const stats = {
    total: signals.length,
    active: signals.filter(s => s.status === 'ACTIVE').length,
    won: signals.filter(s => s.status === 'WON').length,
    lost: signals.filter(s => s.status === 'LOST').length
  };

  useEffect(() => {
    const store = useAppStore.getState();
    if (store.fetchSignals) store.fetchSignals();
    if (store.fetchMarketStatus) store.fetchMarketStatus();

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
      toast.success('Connecté au marché Pocket Option !');
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
      toast.success('Reconnexion réussie !');
    } else {
      setConnectError(result.message || 'Reconnexion échouée. Vérifiez que votre compte Pocket Option est toujours connecté, ou collez un nouveau SSID.');
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
    const doc = createBrandedPDF('Rapport Signaux', 'Signaux de trading filtrés et statistiques', pdfUser);
    let y = 58;

    // User info card
    y = drawUserInfoCard(doc, y, pdfUser);

    // Filter info
    y = drawSectionTitle(doc, 'Filtres appliques', y);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Paire', selectedPair === 'ALL' ? 'Toutes' : selectedPair);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Direction', selectedDirection === 'ALL' ? 'Toutes' : selectedDirection);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Statut', selectedStatus === 'ALL' ? 'Tous' : selectedStatus);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Payout', selectedPayout === 'ALL' ? 'Tous' : `>${selectedPayout}%`);
    y += 2;

    // Stats
    y = drawSectionTitle(doc, 'Statistiques', y);
    const cardW = 42;
    const gap = 3;
    y = drawStatCard(doc, PAGE.marginL, y, cardW, 'Total', String(stats.total));
    y = drawStatCard(doc, PAGE.marginL + cardW + gap, y - 21, cardW, 'Actifs', String(stats.active), { valueColor: '#3B82F6' });
    y = drawStatCard(doc, PAGE.marginL + (cardW + gap) * 2, y - 21, cardW, 'Gagnes', String(stats.won), { valueColor: '#22C55E' });
    y = drawStatCard(doc, PAGE.marginL + (cardW + gap) * 3, y - 21, cardW, 'Perdus', String(stats.lost), { valueColor: '#EF4444' });
    y += 6;

    // Signals table
    y = drawSectionTitle(doc, 'Liste des signaux', y);
    if (filteredSignals.length > 0) {
      const headers = [
        { label: 'Paire', width: 28 },
        { label: 'Direction', width: 22, align: 'center' as const },
        { label: 'Winrate', width: 20, align: 'center' as const },
        { label: 'Statut', width: 20, align: 'center' as const },
        { label: 'Payout', width: 18, align: 'right' as const },
        { label: 'Expiration', width: 35, align: 'right' as const },
      ];
      const rows = filteredSignals.slice(0, 50).map(s => [
        s.pair || '-',
        s.direction || '-',
        s.winrate ? `${s.winrate}%` : '-',
        s.status || '-',
        s.payout ? `${s.payout}%` : '-',
        s.timestamp ? new Date(s.timestamp).toLocaleString('fr-FR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-',
      ]);
      y = drawTable(doc, PAGE.marginL, y, headers, rows);
    } else {
      doc.setFontSize(8);
      doc.setTextColor(107, 114, 128);
      doc.text('Aucun signal trouve avec ces filtres.', PAGE.marginL + 4, y + 4);
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
                  Signaux de Trading A2Sniper
                </h1>
                <p className="text-gray-400 max-w-3xl text-xs font-bold leading-relaxed mt-1">
                  {liveStatus === 'LIVE' 
                    ? "Bienvenue sur A2Sniper 3.0, l'Assistant de pointe pour le trading haute fréquence. Le système est connecté avec succès au marché réel via WebSocket."
                    : "Bienvenue sur A2Sniper 3.0, l'Assistant de pointe pour le trading haute fréquence. Veuillez configurer le SSID ci-dessous pour connecter l'analyseur au marché."}
                </p>
              </div>
              
              <div className="flex items-center space-x-3">
                <div 
                  title={liveStatus === 'LIVE' ? "ANALYSE BASÉE SUR LES DONNÉES RÉELLES" : "SYSTÈME DÉCONNECTÉ DU MARCHÉ"}
                  className="flex items-center px-3 py-2 bg-[#0a0a0c] rounded-xl border border-white/5 shadow-sm cursor-help transition-all"
                >
                  <span className="relative flex h-3 w-3 mr-2">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${liveStatus === 'LIVE' ? 'bg-green-400' : 'bg-red-400'} opacity-75`}></span>
                    <span className={`relative inline-flex rounded-full h-3 w-3 ${liveStatus === 'LIVE' ? 'bg-green-500' : 'bg-red-500'}`}></span>
                  </span>
                  <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">
                    {liveStatus === 'LIVE' ? 'MARKET LIVE' : 'DÉCONNECTÉ'}
                  </span>
                </div>

                {liveStatus === 'LIVE' && (
                  <button
                    onClick={() => disconnectMarket()}
                    className="px-3 py-2 bg-red-500/10 text-red-500 rounded-xl text-[10px] font-black uppercase tracking-wider hover:bg-red-500 hover:text-white transition-all border border-red-500/20"
                  >
                    Déconnecter
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
                  title={justExported ? 'PDF exporté !' : 'Exporter les signaux'}
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
                    Connexion au Marché
                  </h2>
                  <p className="text-xs text-gray-400 mb-6 font-bold leading-relaxed">
                    Afin que A2Sniper 3.0 analyse en direct le flux WebSocket Pocket Option, vous devez entrer la chaîne d'authentification active (SSID) ci-dessous.
                  </p>
                  
                  <div className="space-y-4 mb-8">
                    <h3 className="font-black text-xs text-white uppercase tracking-wider">Protocole de connexion :</h3>
                    <ul className="space-y-3 font-bold text-xs text-gray-400">
                      <li className="flex gap-3">
                        <span className="flex-shrink-0 w-5 h-5 bg-[#D4AF37]/10 border border-[#D4AF37]/20 text-[#D4AF37] rounded-full flex items-center justify-center font-bold text-[10px]">1</span>
                        <span>Connectez-vous sur votre compte <a href="https://pocketoption.com" target="_blank" rel="noopener noreferrer" className="text-[#D4AF37] hover:underline">pocketoption.com</a></span>
                      </li>
                      <li className="flex gap-3">
                        <span className="flex-shrink-0 w-5 h-5 bg-[#D4AF37]/10 border border-[#D4AF37]/20 text-[#D4AF37] rounded-full flex items-center justify-center font-bold text-[10px]">2</span>
                        <span>Ouvrez les Outils de développement (F12) -&gt; onglet Network (Réseau)</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="flex-shrink-0 w-5 h-5 bg-[#D4AF37]/10 border border-[#D4AF37]/20 text-[#D4AF37] rounded-full flex items-center justify-center font-bold text-[10px]">3</span>
                        <span>Filtrez par &apos;WS&apos; (WebSockets) et cherchez la trame de connexion commençant par &apos;42[&quot;auth&quot;...&apos;</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="flex-shrink-0 w-5 h-5 bg-[#D4AF37]/10 border border-[#D4AF37]/20 text-[#D4AF37] rounded-full flex items-center justify-center font-bold text-[10px]">4</span>
                        <span>Copiez l'intégralité du texte de la trame et collez-le dans le champ ci-contre.</span>
                      </li>
                    </ul>
                  </div>

                  <div className="flex items-center gap-4 p-4 bg-[#D4AF37]/5 border border-[#D4AF37]/10 rounded-xl text-gray-400 text-xs font-bold leading-relaxed">
                    <Target className="w-5 h-5 text-[#D4AF37] flex-shrink-0" />
                    <p>Le SSID reste actif tant que vous ne déconnectez pas votre compte Pocket Option — même si vous fermez le navigateur. Il change uniquement si vous vous déconnectez puis reconnectez sur Pocket Option.</p>
                  </div>
                </div>

                <div className="w-full lg:w-96 space-y-6">
                  <div className="bg-[#050507] p-6 rounded-2xl border border-white/5">
                    <label className="block text-[10px] font-black text-gray-400 mb-2 uppercase tracking-widest">Chaîne SSID (Trame d'auth)</label>
                    <textarea
                      value={ssid}
                      onChange={(e) => { setSsid(e.target.value); setConnectError(''); }}
                      placeholder='Collez ici la trame 42["auth",{...}] copiée depuis F12 → Network → WS'
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
                                {validation.details.isDemoAccount ? 'COMPTE DÉMO' : 'COMPTE RÉEL'}
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
                          Connexion en cours...
                        </>
                      ) : (
                        <>
                          <Zap className="w-4 h-4" />
                          Connecter au Marché
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
                        Reconnecter avec le SSID sauvegardé
                      </button>
                    )}
                    
                    {connectError && (
                      <div className="mt-4 text-[10px] font-bold text-red-400 bg-red-500/10 p-4 rounded-xl border border-red-500/20 space-y-2">
                        <p className="font-black text-red-500 uppercase tracking-wider flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" /> Échec de la connexion
                        </p>
                        <p className="leading-relaxed">{connectError}</p>
                        <a
                          href="https://pocketoption.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block mt-1 text-[#D4AF37] underline hover:text-yellow-300 transition-colors"
                        >
                          → Aller sur pocketoption.com (si vous vous êtes déconnecté de votre compte)
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
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                {[
                  { label: 'Total Signaux', value: stats.total, color: 'text-gray-400 bg-white/[0.02]', icon: TrendingUp },
                  { label: 'Actifs', value: stats.active, color: 'text-[#D4AF37] bg-[#D4AF37]/10', icon: Clock },
                  { label: 'Gagnants', value: stats.won, color: 'text-green-500 bg-green-500/10', icon: Target },
                  { label: 'Perdants', value: stats.lost, color: 'text-red-500 bg-red-500/10', icon: TrendingUp }
                ].map((card, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: index * 0.1 }}
                    className="bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-2xl backdrop-blur-md"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">{card.label}</p>
                        <p className="text-2xl font-black text-white tracking-tight">{card.value}</p>
                      </div>
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${card.color}`}>
                        <card.icon className="w-5 h-5" />
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
                    <option value="ALL">Toutes les paires</option>
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
                    <option value="ALL">Tous les statuts</option>
                    <option value="ACTIVE">Actif</option>
                    <option value="WON">Gagné</option>
                    <option value="LOST">Perdu</option>
                    <option value="EXPIRED">Expiré</option>
                  </select>

                  {/* Direction Filter */}
                  <select
                    value={selectedDirection}
                    onChange={(e) => setSelectedDirection(e.target.value)}
                    className="w-full px-4 py-2.5 bg-[#050507] border border-white/5 rounded-xl focus:outline-none focus:border-[#D4AF37] text-xs font-bold text-white"
                  >
                    <option value="ALL">Toutes les directions</option>
                    <option value="CALL">CALL</option>
                    <option value="PUT">PUT</option>
                  </select>

                  {/* Winrate Filter */}
                  <select
                    value={minWinrate}
                    onChange={(e) => setMinWinrate(Number(e.target.value))}
                    className="w-full px-4 py-2.5 bg-[#050507] border border-white/5 rounded-xl focus:outline-none focus:border-[#D4AF37] text-xs font-bold text-white"
                  >
                    <option value="0">Tous les Winrates</option>
                    <option value="75">75%+</option>
                    <option value="85">85%+</option>
                    <option value="90">90%+</option>
                    <option value="95">95%+</option>
                    <option value="99">99%+</option>
                  </select>

                  {/* Payout Filter */}
                  <select
                    value={selectedPayout}
                    onChange={(e) => setSelectedPayout(e.target.value)}
                    className="w-full px-4 py-2.5 bg-[#050507] border border-[#D4AF37]/20 focus:border-[#D4AF37] rounded-xl focus:outline-none text-xs font-bold text-white transition-colors"
                  >
                    <option value="ALL">Tout Payout</option>
                    <option value="75">&gt; 75% Payout</option>
                    <option value="80">&gt; 80% Payout</option>
                    <option value="85">&gt; 85% Payout</option>
                    <option value="90">&gt; 90% Payout</option>
                    <option value="92">≥ 92% Payout</option>
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
                  <h3 className="text-sm font-black text-white uppercase mb-2">Aucun signal trouvé</h3>
                  <p className="text-xs text-gray-500 font-bold">Modifiez vos paramètres de filtrage pour rafraîchir le flux.</p>
                </motion.div>
              )}
            </>
          )}
    </div>
  );
}