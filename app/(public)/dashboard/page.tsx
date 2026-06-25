'use client';

import { getApiUrl } from '@/lib/api-config';
import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Bell, TrendingUp, TrendingDown, RefreshCw, Download, BarChart3, Target, DollarSign, Zap, AlertCircle, Loader2, Check } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { useAuth } from '@/hooks/use-auth';
import { createBrandedPDF, drawSectionTitle, drawStatCard, drawTable, drawUserInfoCard, savePDF, PAGE, PDFUserInfo, fetchAvatarBase64 } from '@/lib/pdf-export';
import { toast } from 'sonner';

export default function DashboardPage() {
  useAuth();
  const { user, signals, fetchSignals, fetchPerformance, liveStatus, userStats } = useAppStore();
  const [gaugeValue, setGaugeValue] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [justExported, setJustExported] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [systemStatus, setSystemStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [connectionStatus, setConnectionStatus] = useState<'Connected' | 'Disconnected' | 'Checking...'>('Checking...');

  const totalTrades = signals.filter(s => s.is_win !== null).length;
  const wonTrades = signals.filter(s => s.is_win === true).length;
  const winRate = userStats?.winRate > 0 ? userStats.winRate : (totalTrades > 0 ? (wonTrades / totalTrades) * 100 : 0);

  const todaySignals = signals.filter(s => {
    const d = new Date(s.timestamp);
    return d.toDateString() === new Date().toDateString();
  });

  const activeSignals = signals.filter(s => s.is_win === null).length;
  const todayProfit = todaySignals.reduce((sum, s) => sum + (s.profit_loss || 0), 0);

  const avgWinrate = signals.length > 0
    ? signals.slice(0, 10).reduce((sum, s) => sum + s.winrate, 0) / Math.min(10, signals.length)
    : 0;

  // Update gauge dynamically when winRate changes
  useEffect(() => {
    setGaugeValue(winRate > 0 ? winRate : 0);
  }, [winRate]);

  // Initial data fetch with loading/error states
  useEffect(() => {
    let cancelled = false;

    const loadDashboard = async () => {
      setIsLoading(true);
      setApiError(null);
      try {
        await Promise.all([fetchSignals(), fetchPerformance()]);
        if (!cancelled) {
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setIsLoading(false);
          setApiError('Impossible de charger les données. Vérifiez votre connexion.');
        }
      }
    };

    loadDashboard();

    const apiTimer = setInterval(() => {
      fetchSignals().catch(() => {});
      fetchPerformance().catch(() => {});
    }, 2000); // Real-time refresh every 2s (was 30s)

    return () => {
      cancelled = true;
      clearInterval(apiTimer);
    };
  }, [fetchSignals, fetchPerformance]);

  // Check system status from /api/status
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const apiUrl = getApiUrl();
        const res = await fetch(`${apiUrl}/api/status`, {
          credentials: 'include',
        });
        if (res.ok) {
          setSystemStatus('online');
          setConnectionStatus('Connected');
        } else {
          setSystemStatus('offline');
          setConnectionStatus('Disconnected');
        }
      } catch {
        setSystemStatus('offline');
        setConnectionStatus('Disconnected');
      }
    };

    checkStatus();
    setConnectionStatus('Checking...');
    const statusTimer = setInterval(() => {
      setConnectionStatus('Checking...');
      checkStatus();
    }, 30000);
    return () => clearInterval(statusTimer);
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setApiError(null);
    try {
      await Promise.all([fetchSignals(), fetchPerformance()]);
    } catch {
      setApiError('Erreur lors du rafraîchissement.');
    }
    setTimeout(() => {
      setIsRefreshing(false);
    }, 800);
  };

  const handleExport = async () => {
    if (user?.avatar) await fetchAvatarBase64(user.avatar);
    const pdfUser: PDFUserInfo = {
      name: user?.name,
      email: user?.email,
      plan: user?.plan,
      userId: user?.id,
      avatarUrl: user?.avatar,
    };
    const doc = createBrandedPDF('Rapport Dashboard', 'Vue d\'ensemble des performances et signaux', pdfUser);
    let y = 58;

    // User info card
    y = drawUserInfoCard(doc, y, pdfUser);

    // Metrics Section
    y = drawSectionTitle(doc, 'Metriques en direct', y);
    const cardW = 42;
    const cardGap = 3;
    const startX = PAGE.marginL;
    y = drawStatCard(doc, startX, y, cardW, 'Total Trades', String(totalTrades));
    y = drawStatCard(doc, startX + cardW + cardGap, y - 21, cardW, 'Trades Gagnes', String(wonTrades), { valueColor: '#22C55E' });
    y = drawStatCard(doc, startX + (cardW + cardGap) * 2, y - 21, cardW, 'Win Rate', `${winRate.toFixed(1)}%`, { valueColor: '#D4AF37' });
    y = drawStatCard(doc, startX + (cardW + cardGap) * 3, y - 21, cardW, 'Signaux Actifs', String(activeSignals), { valueColor: '#3B82F6' });
    y += 3;
    y = drawStatCard(doc, startX, y, cardW, 'Profit Aujourd\'hui', `$${todayProfit.toFixed(2)}`, { valueColor: todayProfit >= 0 ? '#22C55E' : '#EF4444' });
    y = drawStatCard(doc, startX + cardW + cardGap, y - 21, cardW, 'Winrate Moyen', `${(avgWinrate || 0).toFixed(1)}%`, { valueColor: '#D4AF37' });

    // Signals Table
    y += 6;
    y = drawSectionTitle(doc, 'Derniers Signaux', y);
    if (signals.length > 0) {
      const headers = [
        { label: 'Paire', width: 30 },
        { label: 'Direction', width: 22, align: 'center' as const },
        { label: 'Winrate', width: 22, align: 'center' as const },
        { label: 'Statut', width: 22, align: 'center' as const },
        { label: 'Payout', width: 20, align: 'right' as const },
      ];
      const rows = signals.slice(0, 20).map(s => [
        s.pair || '-',
        s.direction || '-',
        s.winrate ? `${s.winrate}%` : '-',
        s.status || '-',
        s.payout ? `${s.payout}%` : '-',
      ]);
      y = drawTable(doc, PAGE.marginL, y, headers, rows);
    } else {
      doc.setFontSize(8);
      doc.setTextColor(107, 114, 128);
      doc.text('Aucun signal disponible.', PAGE.marginL + 4, y + 4);
      y += 10;
    }

    const dateStr = new Date().toISOString().split('T')[0];
    savePDF(doc, `a2sniper-dashboard-${dateStr}.pdf`, pdfUser);
    setJustExported(true);
    setTimeout(() => setJustExported(false), 2500);
    toast.success('Rapport PDF exporte avec succes !');
  };

  const TechnicalGauge = ({ value }: { value: number }) => {
    const displayValue = value > 0 ? value : 0;
    const radius = 80;
    const strokeWidth = 12;
    const normalizedRadius = radius - strokeWidth * 2;
    const circumference = normalizedRadius * 2 * Math.PI;
    const strokeDashoffset = circumference - (displayValue / 100) * circumference;

    return (
      <div className="relative flex flex-col items-center">
        <div className="relative">
          <svg height={radius * 2} width={radius * 2} className="transform -rotate-90">
            <defs>
              <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#C5A059" />
                <stop offset="100%" stopColor="#D4AF37" />
              </linearGradient>
            </defs>
            <circle
              stroke="#1a1a22"
              fill="transparent"
              strokeWidth={strokeWidth}
              r={normalizedRadius}
              cx={radius}
              cy={radius}
            />
            <motion.circle
              stroke="url(#gaugeGradient)"
              fill="transparent"
              strokeWidth={strokeWidth}
              strokeDasharray={circumference + ' ' + circumference}
              style={{ strokeDashoffset }}
              strokeLinecap="round"
              r={normalizedRadius}
              cx={radius}
              cy={radius}
              animate={{ strokeDashoffset }}
              transition={{ duration: 1 }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
             <span className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB]">
              {isLoading ? '...' : displayValue > 0 ? `${Math.round(displayValue)}%` : 'N/A'}
             </span>
          </div>
        </div>
        <div className="mt-4 text-center">
          <div className="bg-[#D4AF37]/10 text-[#D4AF37] border border-[#D4AF37]/30 px-5 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest">
            Signal Fort
          </div>
        </div>
      </div>
    );
  };

  // Loading skeleton
  if (isLoading) {
    return (
      <div className="space-y-10">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-10">
          <div>
            <div className="h-8 w-48 bg-white/5 rounded-lg animate-pulse" />
            <div className="h-4 w-64 bg-white/5 rounded-lg mt-2 animate-pulse" />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 mb-10">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-2xl animate-pulse">
              <div className="flex items-center justify-between mb-4">
                <div className="w-10 h-10 rounded-xl bg-white/5" />
              </div>
              <div className="h-3 w-24 bg-white/5 rounded mb-2" />
              <div className="h-7 w-16 bg-white/5 rounded" />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 text-[#D4AF37] animate-spin" />
          <span className="ml-3 text-gray-400 font-bold">Chargement des données...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10">

        {/* Error Banner */}
        {apiError && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-red-500/10 border border-red-500/30 p-4 rounded-xl flex items-center gap-3"
          >
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
            <p className="text-sm text-red-300 font-medium">{apiError}</p>
            <button onClick={handleRefresh} className="ml-auto text-red-400 hover:text-red-300">
              <RefreshCw className="w-4 h-4" />
            </button>
          </motion.div>
        )}

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-10">
          <div>
            <h1 className="text-3xl font-black text-white uppercase tracking-tight">
              Tableau de Bord
            </h1>
            <p className="text-sm text-gray-400 mt-1">Surveillance en temps réel du flux de signaux neuronaux.</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="p-3 bg-[#0a0a0c] border border-white/5 rounded-xl hover:bg-white/[0.03] text-gray-400 hover:text-white transition-all"
              title="Actualiser les flux"
            >
              <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={handleExport}
              className={`p-3 rounded-xl transition-all ${justExported ? 'bg-green-500 text-white' : 'bg-[#0a0a0c] border border-white/5 hover:bg-white/[0.03] text-gray-400 hover:text-white'}`}
              title={justExported ? 'PDF exporté !' : 'Exporter en PDF'}
            >
              {justExported ? <Check className="w-5 h-5" /> : <Download className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 mb-10">
          {[
            { label: 'Win Rate Global', value: winRate > 0 ? `${winRate.toFixed(1)}%` : 'N/A', icon: Target, color: 'text-[#D4AF37] bg-[#D4AF37]/10' },
            { label: 'Signaux Actifs', value: activeSignals, icon: Zap, color: 'text-yellow-500 bg-yellow-500/10' },
            { label: 'Profit Jour', value: `$${todayProfit.toFixed(0)}`, icon: DollarSign, color: 'text-green-500 bg-green-500/10' },
            { label: 'Volume 24h', value: todaySignals.length, icon: BarChart3, color: 'text-purple-500 bg-purple-500/10' }
          ].map((stat, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
              className="bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-2xl backdrop-blur-md"
            >
              <div className="flex items-center justify-between mb-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${stat.color}`}>
                  <stat.icon className="w-5 h-5" />
                </div>
                <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Réel</span>
              </div>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">{stat.label}</p>
              <p className="text-2xl font-black text-white mt-1 tracking-tight">{stat.value}</p>
            </motion.div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

          {/* Main Area */}
          <div className="lg:col-span-2 space-y-8">

            {/* Market Analysis */}
            <div className="bg-[#0a0a0c]/80 border border-white/5 p-8 rounded-3xl relative overflow-hidden backdrop-blur-md">
               <div className="absolute top-0 right-0 p-8 opacity-[0.02] pointer-events-none">
                 <TrendingUp className="w-64 h-64 text-white" />
               </div>
               <h2 className="text-lg font-black text-white uppercase tracking-wider mb-8 flex items-center gap-3">
                 <BarChart3 className="w-5 h-5 text-[#D4AF37]" />
                 Analyse Technique du Marché
               </h2>
                <div className="flex flex-col md:flex-row items-center gap-12">
                  <TechnicalGauge value={gaugeValue} />
                  <div className="flex-1 space-y-6 w-full">
                    <div className="bg-[#050507] p-4 rounded-2xl border border-white/5">
                      <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">Winrate Moyen (Analyse)</p>
                      <p className="text-md font-black text-transparent bg-clip-text bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB]">
                        {avgWinrate > 0 ? `${avgWinrate.toFixed(1)}%` : 'Données insuffisantes'}
                      </p>
                    </div>
                    <div className="bg-[#050507] p-4 rounded-2xl border border-white/5">
                      <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">Intégrité des Données</p>
                      <p className={`text-md font-black ${liveStatus === 'LIVE' ? 'text-green-500' : 'text-gray-500'}`}>
                        {liveStatus === 'LIVE' ? 'WebSocket Pocket Option Connecté' : 'WebSocket Déconnecté'}
                      </p>
                    </div>
                  </div>
                </div>
            </div>

            {/* Recent Signals Summary */}
            <div className="bg-[#0a0a0c]/80 border border-white/5 p-8 rounded-3xl backdrop-blur-md">
              <h2 className="text-lg font-black text-white uppercase tracking-wider mb-6">Flux de Signaux Sniper</h2>
              <div className="space-y-4">
                {signals.length > 0 ? (
                  signals.slice(0, 5).map((signal, i) => (
                    <div key={i} className="flex items-center justify-between p-4 bg-[#050507] rounded-xl border border-white/5 hover:border-[#D4AF37]/30 transition-all cursor-pointer">
                      <div className="flex items-center gap-4">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                          signal.direction === 'CALL' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'
                        }`}>
                          {signal.direction === 'CALL' ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
                        </div>
                        <div>
                          <p className="font-bold text-white tracking-tight">{signal.pair}</p>
                          <p className="text-[10px] text-gray-500 font-bold uppercase">{signal.smc_structure || 'Analyse en cours'}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-black text-[#D4AF37]">{signal.winrate}%</p>
                        <p className="text-[10px] text-gray-500 font-bold uppercase">{signal.status}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-gray-500 font-bold text-center py-6">Aucun signal récent détecté.</p>
                )}
              </div>
            </div>
          </div>

          {/* Right Sidebar - System Stats */}
          <div className="space-y-8">

            {/* Account Info */}
            <div className="bg-gradient-to-br from-[#0a0a0c] to-[#050507] border border-[#D4AF37]/30 p-8 rounded-3xl text-white shadow-xl shadow-[#D4AF37]/5 relative overflow-hidden">
               <div className="absolute top-0 right-0 p-8 opacity-[0.03] pointer-events-none">
                 <Zap className="w-64 h-64 text-white" />
               </div>
               <h3 className="font-black text-lg uppercase tracking-wider mb-2 text-transparent bg-clip-text bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB]">Compte Founders</h3>
               <p className="text-xs text-gray-400 font-bold mb-6">Tous les moteurs de sniping sont pleinement opérationnels.</p>
               <div className="space-y-4">
                 <div className="flex justify-between text-xs font-bold text-gray-400">
                   <span>Statut Système:</span>
                   <span className={connectionStatus === 'Connected' ? 'text-green-400' : connectionStatus === 'Disconnected' ? 'text-red-400' : 'text-yellow-400'}>
                     {connectionStatus === 'Connected' ? 'Connecté' : connectionStatus === 'Disconnected' ? 'Déconnecté' : 'Vérification...'}
                   </span>
                 </div>
                 <div className="flex justify-between text-xs font-bold text-gray-400">
                   <span>Uptime Système:</span>
                   <span className="text-white">N/A</span>
                 </div>
                 <div className="flex justify-between text-xs font-bold text-gray-400">
                   <span>Délai Exécution:</span>
                   <span className="text-white">N/A</span>
                 </div>
                 <div className="flex justify-between text-xs font-bold text-gray-400">
                   <span>Version Moteur:</span>
                   <span className="text-[#D4AF37]">N/A</span>
                 </div>
               </div>
            </div>

            {/* System Alerts */}
            <div className="bg-[#0a0a0c]/80 border border-white/5 p-8 rounded-3xl backdrop-blur-md">
              <h3 className="font-black text-white uppercase tracking-wider mb-6 flex items-center gap-2">
                <Bell className="w-4 h-4 text-[#D4AF37]" />
                Alertes Système
              </h3>
              <div className="space-y-4 text-xs font-bold">
                <div className={`p-3 border-l-2 ${liveStatus === 'LIVE' ? 'border-green-500 bg-green-500/5' : 'border-red-500 bg-red-500/5'} text-gray-400 rounded-r-xl`}>
                  <p className={`font-black mb-1 ${liveStatus === 'LIVE' ? 'text-green-400' : 'text-red-400'}`}>
                    {liveStatus === 'LIVE' ? 'WebSocket Connecté' : 'WebSocket Déconnecté'}
                  </p>
                  {liveStatus === 'LIVE'
                    ? 'Connexion WebSocket sécurisée établie.'
                    : 'Aucune connexion au flux de marché. Connectez-vous via la page Signaux.'}
                </div>
                {systemStatus === 'offline' && (
                  <div className="p-3 border-l-2 border-red-500 bg-red-500/5 text-gray-400 rounded-r-xl">
                    <p className="text-red-400 font-black mb-1">Serveur API indisponible</p>
                    Le serveur backend ne répond pas. Veuillez réessayer plus tard.
                  </div>
                )}
              </div>
            </div>
          </div>

        </div>
    </div>
  );
}
