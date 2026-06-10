'use client';

import { motion } from 'framer-motion';
import { TelegramBotSimulator } from '@/components/ui/telegram-bot-simulator';
import { Bot, Zap, Shield, Users, Target, BarChart4, ChevronRight, MessageSquare, ShieldCheck } from 'lucide-react';

export default function TelegramPage() {
  const features = [
    {
      icon: <Bot className="w-6 h-6" />,
      title: "Moteur A2Sniper 3.0",
      description: "Interface Assistant de pointe avec consensus multi-modèles (LSTM/Transformer/XGBoost)."
    },
    {
      icon: <Zap className="w-6 h-6" />,
      title: "Signaux Temps Réel",
      description: "Données extraites directement du flux WebSocket Pocket Option. Zéro latence."
    },
    {
      icon: <ShieldCheck className="w-6 h-6" />,
      title: "Gestion du Risque",
      description: "Risk Manager intégré pour une protection maximale du capital et profits constants."
    },
    {
      icon: <Users className="w-6 h-6" />,
      title: "Accès Exclusif",
      description: "Espace Founders-Only avec monitoring en direct et analyses SMC détaillées."
    }
  ];

  const highlights = [
    { label: "Précision Assistant", value: "99.99%", color: "text-green-400" },
    { label: "Latence", value: "< 150ms", color: "text-[#D4AF37]" },
    { label: "Actifs", value: "8 OTC Pairs", color: "text-indigo-400" },
    { label: "Disponibilité", value: "24/7", color: "text-purple-400" }
  ];

  return (
    <div className="space-y-12 max-w-7xl mx-auto">
          
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-12 items-start">
            
            {/* Left: Simulator (Pushed upwards slightly with negative top margin) */}
            <div className="xl:col-span-5 relative group mt-4 xl:-mt-8">
              <div className="absolute -inset-1 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] rounded-[2.5rem] blur opacity-20 group-hover:opacity-30 transition duration-1000 group-hover:duration-200" />
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.8 }}
                className="relative"
              >
                <TelegramBotSimulator />
              </motion.div>
            </div>

            {/* Right: Content & Onboarding text block */}
            <div className="xl:col-span-7 space-y-10">
              
              {/* Header block moved to the right */}
              <div className="relative">
                <div className="absolute -top-20 -left-20 w-64 h-64 bg-[#D4AF37]/10 rounded-full blur-[100px] pointer-events-none" />
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.8 }}
                >

                  <h1 className="text-4xl md:text-5xl font-black text-white mb-4 tracking-tight leading-tight">
                    Bot Telegram <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#D4AF37] to-[#C5A059]">A2Sniper</span>
                  </h1>
                  <p className="text-lg text-gray-400 max-w-2xl font-medium leading-relaxed mb-6">
                    Connectez-vous au flux de signaux le plus puissant du marché. 
                    Données réelles, analyses institutionnelles et exécution instantanée.
                  </p>
                  <button className="inline-flex py-4 px-8 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] hover:from-[#C5A059] hover:to-[#D4AF37] rounded-2xl text-xs font-black text-white uppercase tracking-[0.3em] transition-all shadow-[0_0_30px_rgba(212,175,55,0.2)] items-center justify-center gap-3 active:scale-95 group">
                    Rejoindre le Terminal Telegram
                    <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </button>
                </motion.div>
              </div>

              {/* Stats Bar */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {highlights.map((stat, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.1 }}
                    className="bg-[#0a0a0c] p-4 rounded-2xl border border-gray-800/50 text-center"
                  >
                    <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1">{stat.label}</p>
                    <p className={`text-xl font-black ${stat.color} tracking-tight`}>{stat.value}</p>
                  </motion.div>
                ))}
              </div>

              {/* Features Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {features.map((feature, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.5, delay: index * 0.1 }}
                    className="bg-[#0a0a0c]/50 p-6 rounded-3xl border border-gray-800 hover:border-[#D4AF37]/30 transition-all group relative overflow-hidden"
                  >
                    <div className="absolute top-0 right-0 w-32 h-32 bg-[#D4AF37]/5 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity" />
                    <div className="w-12 h-12 bg-[#D4AF37]/10 rounded-2xl flex items-center justify-center mb-6 border border-[#D4AF37]/20 group-hover:scale-110 transition-transform">
                      <div className="text-[#D4AF37]">
                        {feature.icon}
                      </div>
                    </div>
                    <h3 className="text-lg font-black text-white mb-2 tracking-tight group-hover:text-[#D4AF37] transition-colors">{feature.title}</h3>
                    <p className="text-sm text-gray-400 font-bold leading-relaxed">{feature.description}</p>
                  </motion.div>
                ))}
              </div>

            </div>

          </div>
    </div>
  );
}