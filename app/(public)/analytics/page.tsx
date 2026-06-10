'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw, Download } from 'lucide-react';
import { AdvancedAnalytics } from '@/components/ui/advanced-analytics';
import { useAppStore } from '@/lib/store';
import { useAuth } from '@/hooks/use-auth';

export default function AnalyticsPage() {
  useAuth();
  const { signals, fetchSignals, fetchPerformance } = useAppStore();
  const [selectedTimeframe, setSelectedTimeframe] = useState('24H');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = () => {
    setIsRefreshing(true);
    fetchSignals();
    fetchPerformance();
    setTimeout(() => {
      setIsRefreshing(false);
    }, 1500);
  };

  const handleExport = () => {
    const data = {
      timeframe: selectedTimeframe,
      exportDate: new Date().toISOString(),
      totalSignals: signals.length,
      signals: signals.slice(0, 50).map(s => ({
        pair: s.pair,
        direction: s.direction,
        winrate: s.winrate,
        status: s.status,
        timestamp: s.timestamp
      }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `a2sniper-analytics-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8">
      {/* Header avec contrôles */}
      <div className="mb-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1 className="text-2xl font-black text-white uppercase tracking-tight mb-2">
            Analyses Avancées
          </h1>
          <p className="text-sm text-gray-400 font-bold">
            Analyses détaillées des performances et métriques en temps réel
          </p>
        </motion.div>
        
        <div className="flex items-center space-x-3">
          <select
            value={selectedTimeframe}
            onChange={(e) => setSelectedTimeframe(e.target.value)}
            className="px-4 py-2.5 bg-[#0a0a0c] border border-white/10 rounded-xl text-xs font-bold text-white focus:ring-2 focus:ring-[#D4AF37]/50 focus:border-[#D4AF37]/50 appearance-none cursor-pointer"
          >
            <option value="1H">1 Heure</option>
            <option value="24H">24 Heures</option>
            <option value="7D">7 Jours</option>
            <option value="30D">30 Jours</option>
          </select>
          
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-2.5 bg-[#0a0a0c] border border-white/10 text-white rounded-xl hover:border-[#D4AF37]/30 transition-all disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          
          <button
            onClick={handleExport}
            className="p-2.5 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black rounded-xl hover:from-[#C5A059] hover:to-[#D4AF37] transition-all active:scale-95"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
      </div>

      <AdvancedAnalytics timeframe={selectedTimeframe} />
    </div>
  );
}