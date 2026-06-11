'use client';

import { motion } from 'framer-motion';

export default function Loading() {
  return (
    <div className="fixed inset-0 z-[9999] bg-[#050507] flex flex-col items-center justify-center" role="status" aria-label="Chargement en cours">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: [0.8, 1.1, 1], opacity: 1 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="relative"
      >
        {/* Glow effect behind the logo */}
        <div className="absolute inset-0 bg-[#D4AF37] blur-[80px] opacity-40 animate-pulse rounded-full" />
        
        <img 
          src="/A2Sniper-logo.jpeg" 
          alt="A2Sniper Logo" 
          className="w-32 h-32 md:w-48 md:h-48 object-cover rounded-3xl shadow-[0_0_50px_rgba(212,175,55,0.5)] border-2 border-[#D4AF37]/40 relative z-10"
        />
      </motion.div>
      
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="mt-8 flex flex-col items-center gap-3"
      >
        <div className="flex space-x-2">
          <div className="w-2 h-2 bg-[#D4AF37] rounded-full animate-bounce shadow-[0_0_8px_rgba(212,175,55,0.6)]"></div>
          <div className="w-2 h-2 bg-[#F3E5AB] rounded-full animate-bounce delay-150 shadow-[0_0_8px_rgba(243,229,171,0.6)]"></div>
          <div className="w-2 h-2 bg-[#C5A059] rounded-full animate-bounce delay-300 shadow-[0_0_8px_rgba(197,160,89,0.6)]"></div>
        </div>
        <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.3em]">
          Chargement du système...
        </p>
      </motion.div>
    </div>
  );
}
