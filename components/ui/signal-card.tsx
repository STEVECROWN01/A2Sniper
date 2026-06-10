'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown, Clock, Star, Copy, ExternalLink, Check, X, Target, AlertTriangle, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '@/lib/store';
import { Signal } from '@/lib/mock-data';

interface SignalCardProps {
  signal: Signal;
}

export function SignalCard({ signal }: SignalCardProps) {
  const { updateSignalStatus } = useAppStore();
  const [isFavorite, setIsFavorite] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const [isExpiring, setIsExpiring] = useState(false);

  useEffect(() => {
    if (signal.status === 'ACTIVE') {
      const calculateRemaining = () => {
        // Use synchronized now time
        const clockOffset = useAppStore.getState().clockOffset || 0;
        const now = Date.now() + clockOffset;
        
        // Find the next candle boundary after signal creation
        const signalTime = signal.timestamp.getTime();
        const minutes = signal.timestamp.getMinutes();
        const minutesToBoundary = signal.expiration - (minutes % signal.expiration);
        
        const boundaryDate = new Date(signal.timestamp);
        boundaryDate.setSeconds(0, 0);
        boundaryDate.setMinutes(boundaryDate.getMinutes() + minutesToBoundary);
        
        const remaining = boundaryDate.getTime() - now;
        return remaining <= 0 ? 0 : remaining;
      };

      const initialRemaining = calculateRemaining();
      setTimeLeft(initialRemaining);
      setIsExpiring(initialRemaining < 30000);

      const interval = setInterval(() => {
        const remaining = calculateRemaining();
        setTimeLeft(remaining);
        setIsExpiring(remaining < 30000);
        
        if (remaining <= 0) {
          // If remaining time hits 0, trigger fetch to update status from backend
          useAppStore.getState().fetchSignals();
        }
      }, 1000);

      return () => clearInterval(interval);
    }
    // Use signal.id as dependency so timer only resets when a new signal arrives,
    // not on every re-render of the parent component
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal.id, signal.status, signal.expiration, updateSignalStatus]);

  const formatTime = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleCopySignal = () => {
    const signalText = `🎯 SIGNAL TRADING - A2Sniper
📊 Paire: ${signal.pair}
📈 Direction: ${signal.direction} ${signal.direction === 'CALL' ? '✅ CALL' : '🔻 PUT'}
⏰ Expiration: ${signal.expiration} minutes
🎯 Winrate: ${signal.winrate}% • Payout: ${signal.payout}%
💰 Prix d'entrée: ${signal.entry_price.toFixed(4)}

📋 ANALYSE :
▶ Structure : ${signal.smc_structure}
▶ Zone      : ${signal.smc_zone}
▶ Pattern   : ${signal.chart_pattern}
▶ Fibonacci : ${signal.fibonacci}
▶ RSI       : ${signal.rsi_status}

📍 Timestamp: ${signal.timestamp.toLocaleString('fr-FR')}
#${signal.pair.replace('/', '').replace(' OTC', '')} #${signal.direction} #${signal.expiration}MIN`;

    navigator.clipboard.writeText(signalText).then(
      () => toast.success('Signal copié dans le presse-papiers !'),
      () => toast.error('Impossible de copier le signal. Vérifiez les permissions du presse-papiers.')
    );
  };

  const handleTrade = () => {
    window.open('https://po.trade', '_blank');
    toast.info('Redirection vers Pocket Option...');
  };

  const handleMarkResult = (result: 'WON' | 'LOST') => {
    // Calculate P&L based on actual signal data
    // Use signal.is_win if available from backend, otherwise use user's manual marking
    const payout = signal.payout || 85;
    const profitLoss = result === 'WON' ? payout : -100;
    const resultPrice = signal.entry_price;
    
    updateSignalStatus(signal.id, result, { result_price: resultPrice, profit_loss: profitLoss });
    toast.success(`Signal marqué comme ${result === 'WON' ? 'gagné' : 'perdu'} !`);
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={{ scale: 1.02 }}
        className={`bg-[#0a0a0c]/80 rounded-2xl border-l-4 p-6 cursor-pointer transition-all border border-white/5 backdrop-blur-md hover:border-[#D4AF37]/30 ${
          signal.direction === 'CALL' ? 'border-l-green-500' : 'border-l-red-500'
        } ${isExpiring ? 'ring-2 ring-[#D4AF37] ring-opacity-50' : ''}`}
        onClick={() => setShowDetails(true)}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-4 gap-2">
          <div className="flex items-center space-x-3 min-w-0">
            <div className={`w-12 h-12 rounded-xl flex-shrink-0 flex items-center justify-center ${
              signal.direction === 'CALL' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'
            }`}>
              {signal.direction === 'CALL' ? 
                <TrendingUp className="w-6 h-6 animate-pulse" /> :
                <TrendingDown className="w-6 h-6 animate-pulse" />
              }
            </div>
            <div className="min-w-0">
              <h3 className="font-black text-white truncate text-md tracking-tight uppercase">{signal.pair}</h3>
              <div className="flex items-center gap-2">
                <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${
                  signal.direction === 'CALL' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
                }`}>
                  {signal.direction}
                </span>
                <span className="text-[9px] text-gray-500 font-bold uppercase tracking-widest">OTC PROTOCOL</span>
              </div>
            </div>
          </div>
          
          <div className="flex flex-col items-end space-y-2 flex-shrink-0">
            <div className="flex items-center space-x-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsFavorite(!isFavorite);
                }}
                className={`p-1 rounded ${isFavorite ? 'text-[#D4AF37]' : 'text-gray-500 hover:text-[#D4AF37]'}`}
              >
                <Star className={`w-4 h-4 ${isFavorite ? 'fill-current' : ''}`} />
              </button>
              
              <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider ${
                signal.status === 'ACTIVE' ? 'bg-[#D4AF37] text-black shadow-[0_0_10px_rgba(212,175,55,0.3)]' :
                signal.status === 'WON' ? 'bg-green-500/20 text-green-500 border border-green-500/30' :
                signal.status === 'LOST' ? 'bg-red-500/20 text-red-500 border border-red-500/30' :
                'bg-white/5 text-gray-400'
              }`}>
                {signal.status}
              </span>
            </div>
          </div>
        </div>

        {/* Winrate et Payout */}
        <div className="grid grid-cols-2 gap-3 mb-4 font-bold">
          <div className="bg-[#050507] p-2.5 rounded-xl border border-white/5">
            <p className="text-[8px] text-gray-500 uppercase tracking-wider mb-0.5">Winrate Réel</p>
            <p className="text-sm font-black text-[#D4AF37]">{signal.winrate}%</p>
          </div>
          <div className="bg-[#050507] p-2.5 rounded-xl border border-white/5">
            <p className="text-[8px] text-gray-500 uppercase tracking-wider mb-0.5">Payout Marché</p>
            <p className="text-sm font-black text-gray-200">{signal.payout}%</p>
          </div>
        </div>

        {/* Prix et Temps */}
        <div className="flex items-center justify-between p-3.5 bg-[#050507] rounded-xl mb-4 border border-white/5">
          <div>
            <p className="text-[8px] text-gray-500 uppercase font-black mb-0.5 tracking-wider">Prix d&apos;entrée</p>
            <p className="text-sm font-mono font-black text-white">{signal.entry_price.toFixed(5)}</p>
          </div>
          
          <div className="text-right">
            <p className="text-[8px] text-gray-500 uppercase font-black mb-0.5 tracking-wider">
              {signal.status === 'ACTIVE' ? 'Temps restant' : 'Expiration'}
            </p>
            <div className="flex items-center justify-end space-x-1">
              <Clock className={`w-3.5 h-3.5 ${isExpiring ? 'text-[#D4AF37] animate-pulse' : 'text-gray-400'}`} />
              <span className={`text-sm font-black ${isExpiring ? 'text-[#D4AF37]' : 'text-white'}`}>
                {signal.status === 'ACTIVE' ? formatTime(timeLeft) : `${signal.expiration}m`}
              </span>
            </div>
          </div>
        </div>

        {/* Result status — show Pending if is_win is unknown, otherwise show P&L */}
        {signal.is_win === null || signal.is_win === undefined ? (
          signal.status !== 'ACTIVE' && (
            <div className="flex items-center justify-between mb-4 px-3 py-2 bg-[#050507] border border-dashed border-yellow-500/20 rounded-xl">
              <span className="text-[10px] text-gray-500 font-bold uppercase">Résultat</span>
              <span className="text-xs font-black text-yellow-500">En attente</span>
            </div>
          )
        ) : signal.profit_loss !== undefined ? (
          <div className="flex items-center justify-between mb-4 px-3 py-2 bg-[#050507] border border-dashed border-white/10 rounded-xl">
            <span className="text-[10px] text-gray-500 font-bold uppercase">Résultat Brut</span>
            <span className={`text-xs font-black ${signal.profit_loss > 0 ? 'text-green-500' : 'text-red-500'}`}>
              {signal.profit_loss > 0 ? '+' : ''}${Math.abs(signal.profit_loss).toFixed(2)}
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between mb-4 px-3 py-2 bg-[#050507] border border-dashed border-white/10 rounded-xl">
            <span className="text-[10px] text-gray-500 font-bold uppercase">Résultat</span>
            <span className={`text-xs font-black ${signal.is_win ? 'text-green-500' : 'text-red-500'}`}>
              {signal.is_win ? 'GAGNÉ' : 'PERDU'}
            </span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center space-x-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleCopySignal();
            }}
            className="flex-1 bg-white/5 text-gray-300 px-3 py-2 rounded-xl text-xs font-bold uppercase tracking-wider hover:bg-white/10 transition-colors flex items-center justify-center space-x-1"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>Copier</span>
          </button>
          
          {signal.status === 'ACTIVE' && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleTrade();
                }}
                className="flex-1 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black px-3 py-2 rounded-xl text-xs font-black uppercase tracking-wider hover:from-[#c5a059] hover:to-[#D4AF37] transition-all flex items-center justify-center space-x-1"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Trader</span>
              </button>
              
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleMarkResult('WON');
                }}
                className="p-2 bg-green-500/10 text-green-500 border border-green-500/20 rounded-xl hover:bg-green-500 hover:text-black transition-all"
                title="Marquer gagné"
              >
                <Check className="w-4 h-4" />
              </button>
              
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleMarkResult('LOST');
                }}
                className="p-2 bg-red-500/10 text-red-500 border border-red-500/20 rounded-xl hover:bg-red-500 hover:text-black transition-all"
                title="Marquer perdu"
              >
                <X className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </motion.div>

      {/* Detail Modal */}
      {showDetails && (
        <div 
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 cursor-pointer backdrop-blur-sm"
          onClick={() => setShowDetails(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-[#0a0a0c] border border-white/10 rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto cursor-default"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              
              {/* Modal Header */}
              <div className="flex items-center justify-between mb-6 border-b border-white/5 pb-4">
                <h2 className="text-md font-black text-white uppercase tracking-wider flex items-center gap-2">
                  <Zap className="w-4 h-4 text-[#D4AF37]" />
                  Détails du Signal Sniper
                </h2>
                <button
                  onClick={() => setShowDetails(false)}
                  className="p-1.5 text-gray-500 hover:text-white hover:bg-white/[0.03] rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-4">
                
                {/* Meta Pair */}
                <div className="flex items-center space-x-3 p-4 bg-[#050507] border border-white/5 rounded-xl">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                    signal.direction === 'CALL' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'
                  }`}>
                    {signal.direction === 'CALL' ? 
                      <TrendingUp className="w-6 h-6" /> :
                      <TrendingDown className="w-6 h-6" />
                    }
                  </div>
                  <div>
                    <h3 className="font-black text-white tracking-tight uppercase text-md">{signal.pair}</h3>
                    <p className={`text-[10px] font-black uppercase ${signal.direction === 'CALL' ? 'text-green-500' : 'text-red-500'}`}>
                      {signal.direction}
                    </p>
                  </div>
                </div>

                {/* Winrate Stats */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 bg-[#050507] rounded-xl border border-white/5">
                    <p className="text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-1">Winrate Réel</p>
                    <p className="text-md font-black text-[#D4AF37]">{signal.winrate}%</p>
                  </div>
                  <div className="p-3 bg-[#050507] rounded-xl border border-white/5">
                    <p className="text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-1">Payout Marché</p>
                    <p className="text-md font-black text-gray-200">{signal.payout}%</p>
                  </div>
                </div>

                {/* Entry Price */}
                <div className="p-3 bg-[#050507] rounded-xl border border-white/5">
                  <p className="text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-1">Prix d&apos;entrée SNIPER</p>
                  <p className="text-md font-mono font-black text-white">{signal.entry_price.toFixed(5)}</p>
                </div>

                {/* Algorithmic Details */}
                <div className="p-4 bg-[#050507] border border-white/5 rounded-xl space-y-2.5 font-bold text-xs">
                  <div className="flex items-center gap-2 mb-3">
                    <Zap className="w-4 h-4 text-[#D4AF37] fill-[#D4AF37]" />
                    <h4 className="font-black text-white uppercase text-[10px] tracking-widest">Moteur Neuronal v3.0</h4>
                  </div>
                  <div className="flex justify-between text-gray-400"><span className="uppercase text-[9px] tracking-wider">Structure :</span> <span className="font-black text-white uppercase">{signal.smc_structure}</span></div>
                  <div className="flex justify-between text-gray-400"><span className="uppercase text-[9px] tracking-wider">Zone SMC :</span> <span className="font-black text-white uppercase">{signal.smc_zone}</span></div>
                  <div className="flex justify-between text-gray-400"><span className="uppercase text-[9px] tracking-wider">Pattern Chartiste :</span> <span className="font-black text-white uppercase">{signal.chart_pattern}</span></div>
                  <div className="flex justify-between text-gray-400"><span className="uppercase text-[9px] tracking-wider">Niveaux Fibonacci :</span> <span className="font-black text-white uppercase">{signal.fibonacci}</span></div>
                  <div className="flex justify-between text-gray-400"><span className="uppercase text-[9px] tracking-wider">Indicateur RSI :</span> <span className="font-black text-white uppercase">{signal.rsi_status}</span></div>
                </div>

                {signal.result_price && (
                  <div className="p-3 bg-[#050507] rounded-xl border border-white/5">
                    <p className="text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-1">Prix de sortie</p>
                    <p className="text-md font-mono font-black text-white">{signal.result_price.toFixed(5)}</p>
                  </div>
                )}

                {signal.profit_loss && (
                  <div className={`p-3 rounded-xl border ${
                    signal.profit_loss > 0 ? 'bg-green-500/10 border-green-500/20' : 'bg-red-500/10 border-red-500/20'
                  }`}>
                    <p className={`text-[9px] font-bold uppercase mb-1 ${signal.profit_loss > 0 ? 'text-green-500' : 'text-red-500'}`}>
                      Résultat Financier
                    </p>
                    <p className={`text-md font-black ${signal.profit_loss > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {signal.profit_loss > 0 ? '+' : ''}${signal.profit_loss.toFixed(2)}
                    </p>
                  </div>
                )}

                {/* Time stamp */}
                <div className="p-3 bg-[#050507] rounded-xl border border-white/5">
                  <p className="text-[9px] text-gray-500 font-bold uppercase mb-1">Date d&apos;émission</p>
                  <p className="text-xs font-bold text-gray-300">
                    {signal.timestamp.toLocaleString('fr-FR')}
                  </p>
                </div>

                {/* Footer buttons */}
                <div className="flex space-x-2 pt-4">
                  <button
                    onClick={handleCopySignal}
                    className="flex-1 bg-white/5 text-gray-300 px-4 py-3 rounded-xl text-xs font-bold uppercase tracking-wider hover:bg-white/10 transition-colors flex items-center justify-center space-x-2"
                  >
                    <Copy className="w-4 h-4" />
                    <span>Copier</span>
                  </button>
                  
                  {signal.status === 'ACTIVE' && (
                    <button
                      onClick={handleTrade}
                      className="flex-1 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black px-4 py-3 rounded-xl text-xs font-black uppercase tracking-wider hover:from-[#c5a059] hover:to-[#D4AF37] transition-all flex items-center justify-center space-x-2"
                    >
                      <ExternalLink className="w-4 h-4" />
                      <span>Trader</span>
                    </button>
                  )}
                </div>

              </div>
            </div>
          </motion.div>
        </div>
      )}
    </>
  );
}