'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { ExternalLink, Star, DollarSign, TrendingUp, Shield, Users } from 'lucide-react';
import { supportedBrokers } from '@/lib/mock-data';

export default function BrokersPage() {
  const [selectedBroker, setSelectedBroker] = useState<string | null>(null);

  const handleBrokerSelect = (brokerName: string, url: string) => {
    setSelectedBroker(brokerName);
    
    // Notification
    const notification = document.createElement('div');
    notification.className = 'fixed top-4 right-4 bg-[#D4AF37] text-black px-6 py-3 rounded-lg shadow-lg z-50 font-bold';
    notification.textContent = `Redirection vers ${brokerName}...`;
    document.body.appendChild(notification);
    
    setTimeout(() => {
      window.open(url, '_blank');
      document.body.removeChild(notification);
      setSelectedBroker(null);
    }, 1500);
  };

  return (
    <div className="space-y-8">
        
          {/* Header */}
          <div className="mb-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <h1 className="text-2xl font-black text-white uppercase tracking-tight mb-2">
                Courtiers Partenaires
              </h1>
              <p className="text-sm text-gray-400 font-bold">
                Plateformes de trading compatibles avec A2Sniper
              </p>
            </motion.div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            {[
              { label: 'Courtiers supportés', value: supportedBrokers.length, color: 'text-[#D4AF37] bg-[#D4AF37]/10', icon: TrendingUp },
              { label: 'Dépôt minimum', value: '$5', color: 'text-green-500 bg-green-500/10', icon: DollarSign },
              { label: 'Note moyenne', value: '4.2/5', color: 'text-[#D4AF37] bg-[#D4AF37]/10', icon: Star },
              { label: 'Traders actifs', value: '10K+', color: 'text-purple-500 bg-purple-500/10', icon: Users }
            ].map((stat, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: i * 0.1 }}
                className="bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-2xl backdrop-blur-md"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">{stat.label}</p>
                    <p className="text-2xl font-black text-white tracking-tight">{stat.value}</p>
                  </div>
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${stat.color}`}>
                    <stat.icon className="w-5 h-5" />
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          {/* Brokers Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {supportedBrokers.map((broker, index) => (
              <motion.div
                key={broker.name}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="bg-[#0a0a0c]/80 border border-white/5 rounded-2xl p-6 hover:border-[#D4AF37]/20 transition-all backdrop-blur-md"
              >
                <div className="flex items-center space-x-4 mb-4">
                  <img 
                    src={broker.logo} 
                    alt={broker.name}
                    className="w-12 h-12 rounded-xl object-cover border border-white/10"
                  />
                  <div>
                    <h3 className="text-lg font-black text-white">{broker.name}</h3>
                    <div className="flex items-center space-x-1">
                      {[...Array(5)].map((_, i) => (
                        <Star 
                          key={i} 
                          className={`w-3.5 h-3.5 ${
                            i < Math.floor(broker.rating) 
                              ? 'text-[#D4AF37] fill-current' 
                              : 'text-gray-700'
                          }`} 
                        />
                      ))}
                      <span className="text-xs text-gray-500 font-bold ml-1">{broker.rating}</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 mb-6">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500 font-bold">Dépôt minimum</span>
                    <span className="text-xs font-black text-white">${broker.min_deposit}</span>
                  </div>
                  
                  <div>
                    <span className="text-xs text-gray-500 font-bold block mb-2">Fonctionnalités</span>
                    <div className="flex flex-wrap gap-1.5">
                      {broker.features.map((feature, i) => (
                        <span 
                          key={i}
                          className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black bg-white/[0.03] border border-white/5 text-gray-400 uppercase tracking-wider"
                        >
                          {feature}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => handleBrokerSelect(broker.name, broker.url)}
                  disabled={selectedBroker === broker.name}
                  className="w-full bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black py-3.5 rounded-xl font-black text-xs uppercase tracking-[0.15em] hover:from-[#C5A059] hover:to-[#D4AF37] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 active:scale-95"
                >
                  {selectedBroker === broker.name ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-black"></div>
                      <span>Redirection...</span>
                    </>
                  ) : (
                    <>
                      <span>Trader maintenant</span>
                      <ExternalLink className="w-4 h-4" />
                    </>
                  )}
                </button>
              </motion.div>
            ))}
          </div>

          {/* Info Section */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.6 }}
            className="mt-12 bg-gradient-to-br from-[#0a0a0c] to-[#050507] border border-[#D4AF37]/20 rounded-2xl p-8"
          >
            <div className="text-center">
              <Shield className="w-12 h-12 mx-auto mb-4 text-[#D4AF37]" />
              <h3 className="text-xl font-black text-white uppercase tracking-wider mb-4">Sécurité et Conformité</h3>
              <p className="text-xs text-gray-400 font-bold mb-8 max-w-2xl mx-auto leading-relaxed">
                Tous nos courtiers partenaires sont régulés et offrent une sécurité maximale pour vos fonds. 
                A2Sniper ne stocke aucune information financière personnelle.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-center">
                <div>
                  <div className="text-2xl font-black text-[#D4AF37]">100%</div>
                  <div className="text-xs text-gray-500 font-bold uppercase tracking-wider">Sécurisé</div>
                </div>
                <div>
                  <div className="text-2xl font-black text-[#D4AF37]">24/7</div>
                  <div className="text-xs text-gray-500 font-bold uppercase tracking-wider">Support</div>
                </div>
                <div>
                  <div className="text-2xl font-black text-[#D4AF37]">0%</div>
                  <div className="text-xs text-gray-500 font-bold uppercase tracking-wider">Commission</div>
                </div>
              </div>
            </div>
          </motion.div>
    </div>
  );
}