'use client';

import { motion } from 'framer-motion';
import { TelegramBotSimulator } from '@/components/ui/telegram-bot-simulator';

export default function TelegramPage() {
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

            {/* Right: Header only — removed stats cards and features grid */}
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
                </motion.div>
              </div>

            </div>

          </div>
    </div>
  );
}
