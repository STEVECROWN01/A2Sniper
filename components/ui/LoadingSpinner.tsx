'use client';

import { motion } from 'framer-motion';

export default function LoadingSpinner() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] h-full w-full bg-[#050507]" role="status" aria-label="Loading">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: [0.8, 1.1, 1], opacity: 1 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="relative"
      >
        {/* Animated rotating ring around the logo */}
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 3, ease: "linear" }}
          className="absolute inset-[-4px] rounded-2xl border-2 border-transparent z-20"
          style={{
            borderTopColor: '#D4AF37',
            borderRightColor: 'rgba(212,175,55,0.4)',
            borderBottomColor: 'rgba(212,175,55,0.1)',
            borderLeftColor: 'rgba(212,175,55,0.6)',
          }}
        />
        
        {/* Pulsing glow effect behind the logo */}
        <motion.div 
          animate={{ opacity: [0.15, 0.45, 0.15], scale: [0.95, 1.05, 0.95] }}
          transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
          className="absolute inset-0 bg-[#D4AF37] blur-[60px] rounded-full" 
        />
        
        {/* Static A2Sniper Logo — fixed, no rotation */}
        <img 
          src="/A2Sniper-logo.jpeg" 
          alt="A2Sniper Logo" 
          className="w-24 h-24 object-cover rounded-2xl shadow-[0_0_30px_rgba(212,175,55,0.4)] border border-[#D4AF37]/35 relative z-10"
        />
      </motion.div>
      
      <div className="mt-6 flex flex-col items-center gap-2 relative z-10">
        <div className="flex space-x-1.5">
          <div className="w-1.5 h-1.5 bg-[#D4AF37] rounded-full animate-bounce shadow-[0_0_8px_rgba(212,175,55,0.6)]"></div>
          <div className="w-1.5 h-1.5 bg-[#F3E5AB] rounded-full animate-bounce delay-150 shadow-[0_0_8px_rgba(243,229,171,0.6)]"></div>
          <div className="w-1.5 h-1.5 bg-[#C5A059] rounded-full animate-bounce delay-300 shadow-[0_0_8px_rgba(197,160,89,0.6)]"></div>
        </div>
        <p className="text-[9px] font-black text-gray-500 uppercase tracking-[0.25em]">
          Loading system...
        </p>
      </div>
    </div>
  );
}
