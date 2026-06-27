'use client';

import { getApiUrl } from '@/lib/api-config';

import { useState, useMemo, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Search, Filter, TrendingUp, Clock, Target, RefreshCw, Download, Settings, Link2, Trash2, Check } from 'lucide-react';
import { SignalCard } from '@/components/ui/signal-card';
import { useAppStore } from '@/lib/store';
import { tradingPairs } from '@/lib/mock-data';
import { toast } from 'sonner';
import { validateSSID } from '@/lib/validate-ssid';
import { createBrandedPDF, drawSectionTitle, drawStatCard, drawTable, drawInfoRow, drawUserInfoCard, savePDF, PAGE, PDFUserInfo, fetchAvatarBase64 } from '@/lib/pdf-export';
import { useAuth } from '@/hooks/use-auth';

export default function AdminSignalsPage() {
  useAuth(true);
  const { signals, liveStatus, connectMarket, disconnectMarket, fetchMarketStatus, marketInfo, user } = useAppStore();
  const [ssid, setSsid] = useState('');

  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPair, setSelectedPair] = useState('ALL');
  const [selectedStatus, setSelectedStatus] = useState('ALL');
  const [selectedDirection, setSelectedDirection] = useState('ALL');
  const [minWinrate, setMinWinrate] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [justExported, setJustExported] = useState(false);

  const filteredSignals = useMemo(() => {
    let result = signals.filter(signal => {
      const matchesSearch = signal.pair.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesPair = selectedPair === 'ALL' || signal.pair === selectedPair;
      const matchesStatus = selectedStatus === 'ALL' || 
                           (selectedStatus === 'EXPIRED' ? (new Date(signal.timestamp).getTime() < Date.now() && signal.status === 'ACTIVE') : signal.status === selectedStatus);
      const matchesDirection = selectedDirection === 'ALL' || signal.direction === selectedDirection;
      const matchesWinrate = signal.winrate >= minWinrate;
      
      return matchesSearch && matchesPair && matchesStatus && matchesDirection && matchesWinrate;
    });

    if (selectedStatus === 'ACTIVE' || selectedStatus === 'ALL') {
      const latest12 = result
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, 12);
      return latest12.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }

    return result;
  }, [signals, searchTerm, selectedPair, selectedStatus, selectedDirection, minWinrate]);

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

    const validation = validateSSID(ssid.trim());
    if (validation.status === 'invalid') {
      setConnectError(validation.message);
      return;
    }

    // Use the normalized SSID (fixes doubled prefix like 42["auth",42["auth",...)
    const normalizedSSID = validation.normalized || ssid.trim();

    setIsConnecting(true);
    setConnectError('');
    const result = await connectMarket(normalizedSSID);
    if (!result.success) {
      setConnectError(result.message);
    } else {
      setSsid('');
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
    const doc = createBrandedPDF('Admin - Signaux', 'Administration des signaux de trading', pdfUser);
    let y = 58;

    // User info card
    y = drawUserInfoCard(doc, y, pdfUser);

    // Filter info
    y = drawSectionTitle(doc, 'Filtres appliques', y);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Recherche', searchTerm || 'Aucune');
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Pair', selectedPair === 'ALL' ? 'Toutes' : selectedPair);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Status', selectedStatus === 'ALL' ? 'Tous' : selectedStatus);
    y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Direction', selectedDirection === 'ALL' ? 'Toutes' : selectedDirection);
    y += 2;

    // Stats
    y = drawSectionTitle(doc, 'Statistiques', y);
    const cardW = 42;
    const gap = 3;
    y = drawStatCard(doc, PAGE.marginL, y, cardW, 'Total', String(stats.total));
    y = drawStatCard(doc, PAGE.marginL + cardW + gap, y - 21, cardW, 'Active', String(stats.active), { valueColor: '#3B82F6' });
    y = drawStatCard(doc, PAGE.marginL + (cardW + gap) * 2, y - 21, cardW, 'Gagnes', String(stats.won), { valueColor: '#22C55E' });
    y = drawStatCard(doc, PAGE.marginL + (cardW + gap) * 3, y - 21, cardW, 'Perdus', String(stats.lost), { valueColor: '#EF4444' });
    y += 6;

    // Signals table
    y = drawSectionTitle(doc, 'Liste des signaux', y);
    if (filteredSignals.length > 0) {
      const headers = [
        { label: 'Pair', width: 28 },
        { label: 'Direction', width: 22, align: 'center' as const },
        { label: 'Winrate', width: 22, align: 'center' as const },
        { label: 'Status', width: 22, align: 'center' as const },
        { label: 'Payout', width: 20, align: 'right' as const },
        { label: 'Date', width: 35, align: 'right' as const },
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
      doc.text('No signals found.', PAGE.marginL + 4, y + 4);
    }

    const dateStr = new Date().toISOString().split('T')[0];
    savePDF(doc, `a2sniper-admin-signaux-${dateStr}.pdf`, pdfUser);
    setJustExported(true);
    setTimeout(() => setJustExported(false), 2500);
    toast.success('Rapport PDF exporte avec succes !');
  };

  const handleDeleteSignal = async (id: string) => {
    toast.custom((t) => (
      <div className="bg-white rounded-lg shadow-lg p-4 flex flex-col gap-3">
        <p className="text-sm font-bold text-gray-900">Delete signal {id}?</p>
        <div className="flex gap-2">
          <button
            className="px-3 py-1.5 bg-red-600 text-white rounded-md text-xs font-bold hover:bg-red-700"
            onClick={() => { toast.dismiss(t); confirmDelete(id); }}
          >Delete</button>
          <button
            className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded-md text-xs font-bold hover:bg-gray-300"
            onClick={() => toast.dismiss(t)}
          >Cancel</button>
        </div>
      </div>
    ));
  };

  const confirmDelete = async (id: string) => {
    try {
      const url = getApiUrl();
      const res = await fetch(`${url}/api/admin/signals/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        toast.success("Signal deleted successfully.");
        const store = useAppStore.getState();
        if (store.fetchSignals) await store.fetchSignals();
      }
    } catch (err) {
      toast.error("Failed to delete signal.");
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">
            Admin Signals Management
          </h1>
          <p className="text-xs text-gray-500 uppercase tracking-widest font-bold">
            FOUNDERS EXCLUSIVE MATRIX — REAL-TIME KERNEL
          </p>
        </div>
        
        <div className="flex items-center space-x-3">
          <div 
            title={liveStatus === 'LIVE' ? "ANALYSE BASÉE SUR LES DONNÉES RÉELLES" : "SYSTÈME DÉCONNECTÉ DU MARCHÉ"}
            className="flex items-center px-3 py-2 bg-white rounded-lg border border-gray-200 shadow-sm cursor-help transition-all hover:border-blue-200"
          >
            <span className="relative flex h-3 w-3 mr-2">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${liveStatus === 'LIVE' ? 'bg-green-400' : 'bg-red-400'} opacity-75`}></span>
              <span className={`relative inline-flex rounded-full h-3 w-3 ${liveStatus === 'LIVE' ? 'bg-green-500' : 'bg-red-500'}`}></span>
            </span>
            <span className="text-xs font-bold text-gray-700">
              {liveStatus === 'LIVE' ? 'MARKET LIVE' : 'DÉCONNECTÉ'}
            </span>
          </div>

          {liveStatus === 'LIVE' && (
            <button
              onClick={() => disconnectMarket()}
              className="px-3 py-2 bg-red-50 text-red-600 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors border border-red-200"
            >
              DÉCONNECTER
            </button>
          )}

          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          
          <button
            onClick={handleExportSignals}
            className={`p-2 rounded-lg transition-colors ${justExported ? 'bg-green-500 text-white' : 'bg-green-600 text-white hover:bg-green-700'}`}
          >
            {justExported ? <Check className="w-5 h-5" /> : <Download className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Connection Panel (if disconnected) */}
      {liveStatus === 'DISCONNECTED' && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white rounded-2xl shadow-xl border-2 border-blue-500/20 p-8 mb-10 overflow-hidden relative"
        >
          <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
            <RefreshCw className="w-40 h-40" />
          </div>
          
          <div className="flex flex-col lg:flex-row gap-10 items-start">
            <div className="flex-1">
              <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white">
                  <Settings className="w-6 h-6" />
                </div>
                Login au Marché Pocket Option (ADMIN)
              </h2>
              <p className="text-gray-600 mb-6">
                Pour générer des signaux sniper 100% réels, le système doit se connecter à votre session Pocket Option.
              </p>
              
              <div className="space-y-4 mb-8">
                <h3 className="font-bold text-sm text-gray-900 uppercase tracking-wider">Comment se connecter ?</h3>
                <ul className="space-y-3">
                  <li className="flex gap-3 text-sm text-gray-600">
                    <span className="flex-shrink-0 w-6 h-6 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center font-bold text-xs">1</span>
                    <span>Ouvrez votre compte sur <a href="https://pocketoption.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 font-bold hover:underline">pocketoption.com</a></span>
                  </li>
                  <li className="flex gap-3 text-sm text-gray-600">
                    <span className="flex-shrink-0 w-6 h-6 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center font-bold text-xs">2</span>
                    <span>Appuyez sur F12 (Inspecter) -&gt; onglet Network</span>
                  </li>
                  <li className="flex gap-3 text-sm text-gray-600">
                    <span className="flex-shrink-0 w-6 h-6 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center font-bold text-xs">3</span>
                    <span>Filtrez par &apos;WS&apos; et cherchez le message commençant par &apos;42[&quot;auth&quot;...&apos;</span>
                  </li>
                  <li className="flex gap-3 text-sm text-gray-600">
                    <span className="flex-shrink-0 w-6 h-6 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center font-bold text-xs">4</span>
                    <span>Copiez le message entier et collez-le ci-dessous.</span>
                  </li>
                </ul>
              </div>

              <div className="flex items-center gap-4 p-4 bg-yellow-50 border border-yellow-200 rounded-xl text-yellow-800 text-sm">
                <Target className="w-5 h-5 flex-shrink-0" />
                <p>Votre SSID reste valide tant que vous ne vous déconnectez pas de votre compte Pocket Option.</p>
              </div>
            </div>

            <div className="w-full lg:w-96 space-y-6">
              <div className="bg-gray-50 p-6 rounded-2xl border border-gray-100">
                <label className="block text-sm font-bold text-gray-700 mb-2 uppercase tracking-wide">SSID (Auth Message)</label>
                <textarea
                  value={ssid}
                  onChange={(e) => setSsid(e.target.value)}
                  placeholder='42["auth",{"session":"...", ...}]'
                  className="w-full h-32 px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent text-xs font-mono mb-4 resize-none overflow-auto"
                />
                {(() => {
                  const validation = validateSSID(ssid);
                  if (validation.status === 'none') return null;
                  
                  const colorClass = 
                    validation.status === 'valid' ? 'text-green-600' :
                    validation.status === 'partial' ? 'text-yellow-600' :
                    'text-red-600';

                  const prefix = 
                    validation.status === 'valid' ? '✓ ' :
                    validation.status === 'partial' ? '⚠ ' :
                    '✗ ';

                  return (
                    <p className={`text-xs ${colorClass} mb-4 font-bold`}>
                      {prefix}{validation.message}
                    </p>
                  );
                })()}
                 <button
                  onClick={handleConnect}
                  disabled={isConnecting || !ssid}
                  className={`w-full py-4 rounded-xl text-white font-bold transition-all shadow-lg flex items-center justify-center gap-2 ${
                    isConnecting ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  {isConnecting ? (
                    <>
                      <RefreshCw className="w-5 h-5 animate-spin" />
                      CONNEXION EN COURS...
                    </>
                  ) : (
                    <>
                      <Link2 className="w-5 h-5" />
                      CONNECTER AU MARCHÉ
                    </>
                  )}
                </button>
                
                {connectError && (
                  <p className="mt-3 text-center text-xs font-bold text-red-600 bg-red-50 p-2 rounded-lg border border-red-100 italic">
                    ⚠️ {connectError}
                  </p>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 mb-1">Total signaux</p>
              <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
            </div>
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-blue-600" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 mb-1">Active</p>
              <p className="text-2xl font-bold text-blue-600">{stats.active}</p>
            </div>
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
              <Clock className="w-6 h-6 text-blue-600" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 mb-1">Won</p>
              <p className="text-2xl font-bold text-green-600">{stats.won}</p>
            </div>
            <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
              <Target className="w-6 h-6 text-green-600" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 mb-1">Lost</p>
              <p className="text-2xl font-bold text-red-600">{stats.lost}</p>
            </div>
            <div className="w-12 h-12 bg-red-100 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-red-600 transform rotate-180" />
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-6 mb-8">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              type="text"
              placeholder="Rechercher..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <select
            value={selectedPair}
            onChange={(e) => setSelectedPair(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="ALL">All Pairs</option>
            {tradingPairs.map(pair => (
              <option key={pair.symbol} value={pair.symbol}>{pair.symbol}</option>
            ))}
          </select>

          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="ALL">Tous les statuts</option>
            <option value="ACTIVE">Active</option>
            <option value="WON">Gagné</option>
            <option value="LOST">Perdu</option>
          </select>

          <select
            value={selectedDirection}
            onChange={(e) => setSelectedDirection(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="ALL">All Directions</option>
            <option value="CALL">CALL</option>
            <option value="PUT">PUT</option>
          </select>

          <select
            value={minWinrate}
            onChange={(e) => setMinWinrate(Number(e.target.value))}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="0">All Winrates</option>
            <option value="85">85%+</option>
            <option value="90">90%+</option>
            <option value="95">95%+</option>
          </select>
        </div>
      </div>

      {/* Signals Grid (with Admin Delete Button Overlay) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredSignals.map((signal, index) => (
          <div key={signal.id} className="relative group">
            <SignalCard signal={signal} />
            <button 
              onClick={() => handleDeleteSignal(signal.id)}
              className="absolute top-2 right-2 p-2 bg-red-600 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-lg hover:bg-red-700 z-10"
              title="Supprimer ce signal (Admin)"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      {/* Empty State */}
      {filteredSignals.length === 0 && (
        <div className="text-center py-12">
          <Filter className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900">No signals found</h3>
        </div>
      )}
    </div>
  );
}
