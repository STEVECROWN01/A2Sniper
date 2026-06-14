'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw, Download, Check } from 'lucide-react';
import { AdvancedAnalytics } from '@/components/ui/advanced-analytics';
import { useAppStore } from '@/lib/store';
import { useAuth } from '@/hooks/use-auth';
import { createBrandedPDF, drawSectionTitle, drawStatCard, drawTable, drawInfoRow, drawUserInfoCard, savePDF, PAGE, PDFUserInfo, fetchAvatarBase64 } from '@/lib/pdf-export';
import { toast } from 'sonner';

export default function AnalyticsPage() {
  useAuth();
  const { signals, fetchSignals, fetchPerformance, user } = useAppStore();
  const [selectedTimeframe, setSelectedTimeframe] = useState('24H');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [justExported, setJustExported] = useState(false);

  // Fetch data on mount
  useEffect(() => {
    fetchSignals().catch(() => {});
    fetchPerformance().catch(() => {});
  }, [fetchSignals, fetchPerformance]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([fetchSignals(), fetchPerformance()]);
    } catch {}
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
    const doc = createBrandedPDF('Analyses Avancees', `Periode: ${selectedTimeframe}`, pdfUser);
    let y = 58;

    // User info card
    y = drawUserInfoCard(doc, y, pdfUser);

    // Overview stats
    y = drawSectionTitle(doc, 'Resume de la periode', y);
    const cardW = 42;
    const gap = 3;
    y = drawStatCard(doc, PAGE.marginL, y, cardW, 'Total Signaux', String(signals.length));
    y = drawStatCard(doc, PAGE.marginL + cardW + gap, y - 21, cardW, 'Timeframe', selectedTimeframe, { valueColor: '#D4AF37' });

    y += 6;
    y = drawSectionTitle(doc, 'Signaux', y);
    if (signals.length > 0) {
      const headers = [
        { label: 'Paire', width: 30 },
        { label: 'Direction', width: 25, align: 'center' as const },
        { label: 'Winrate', width: 25, align: 'center' as const },
        { label: 'Statut', width: 25, align: 'center' as const },
        { label: 'Date', width: 40, align: 'right' as const },
      ];
      const rows = signals.slice(0, 50).map(s => [
        s.pair || '-',
        s.direction || '-',
        s.winrate ? `${s.winrate}%` : '-',
        s.status || '-',
        s.timestamp ? new Date(s.timestamp).toLocaleDateString('fr-FR') : '-',
      ]);
      y = drawTable(doc, PAGE.marginL, y, headers, rows);
    } else {
      doc.setFontSize(8);
      doc.setTextColor(107, 114, 128);
      doc.text('Aucun signal pour cette periode.', PAGE.marginL + 4, y + 4);
    }

    const dateStr = new Date().toISOString().split('T')[0];
    savePDF(doc, `a2sniper-analytics-${dateStr}.pdf`, pdfUser);
    setJustExported(true);
    setTimeout(() => setJustExported(false), 2500);
    toast.success('Rapport PDF exporte avec succes !');
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
            Analyses détaillées des performances et métriques
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
            className={`p-2.5 rounded-xl transition-all ${justExported ? 'bg-green-500 text-white' : 'bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black hover:from-[#C5A059] hover:to-[#D4AF37]'} active:scale-95`}
          >
            {justExported ? <Check className="w-4 h-4" /> : <Download className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <AdvancedAnalytics timeframe={selectedTimeframe} />
    </div>
  );
}
