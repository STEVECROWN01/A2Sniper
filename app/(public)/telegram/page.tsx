'use client';

import { motion } from 'framer-motion';
import { TelegramBotSimulator } from '@/components/ui/telegram-bot-simulator';
import { Zap, ShieldCheck, ChevronRight } from 'lucide-react';

export default function TelegramPage() {
  const features = [
    {
      icon: <Zap className="w-6 h-6" />,
      title: "Real-time Signals",
      description: "Data extracted directly from the Pocket Option WebSocket stream. Zero latency."
    },
    {
      icon: <ShieldCheck className="w-6 h-6" />,
      title: "Risk Management",
      description: "Integrated Risk Manager for maximum capital protection and consistent profits."
    }
  ];

  return (
    <div className="space-y-12 max-w-7xl mx-auto">

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-12 items-start">

            {/* Left: Simulator */}
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

            {/* Right: Content */}
            <div className="xl:col-span-7 space-y-10">

              {/* Header block */}
              <div className="relative">
                <div className="absolute -top-20 -left-20 w-64 h-64 bg-[#D4AF37]/10 rounded-full blur-[100px] pointer-events-none" />
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.8 }}
                >
                  <h1 className="text-4xl md:text-5xl font-black text-white mb-4 tracking-tight leading-tight">
                    Telegram Bot <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#D4AF37] to-[#C5A059]">A2Sniper</span>
                  </h1>
                  <p className="text-lg text-gray-400 max-w-2xl font-medium leading-relaxed mb-6">
                    Connect to the most powerful signal stream on the market.
                    Real data, institutional analysis and instant execution.
                  </p>
                  <a
                    href="https://t.me/A2SniperBot"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex py-4 px-8 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] hover:from-[#C5A059] hover:to-[#D4AF37] rounded-2xl text-xs font-black text-white uppercase tracking-[0.3em] transition-all shadow-[0_0_30px_rgba(212,175,55,0.2)] items-center justify-center gap-3 active:scale-95 group"
                  >
                    Join Telegram Terminal
                    <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </a>
                </motion.div>
              </div>

              {/* Features Grid — only Real-time Signals and Risk Management */}
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
