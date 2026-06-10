'use client';

import { useState, useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';

export function GlobalLoader() {
  const pathname = usePathname();
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Show loader ONLY on the home page '/'
    if (pathname !== '/') {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    
    // Optimize loading time to 5s
    const minLoadTime = 4800;
    const maxLoadTime = 5000;
    
    // Simulate complex loading and then hide
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, Math.random() * (maxLoadTime - minLoadTime) + minLoadTime);

    return () => clearTimeout(timer);
  }, [pathname]);

  return (
    <AnimatePresence>
      {isLoading && (
        <motion.div
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: "easeInOut" }}
          className="fixed inset-0 z-[9999] bg-[#050507] flex flex-col items-center justify-center"
        >
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: [0.8, 1.1, 1], opacity: 1 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="relative"
          >
            {/* Glow effect behind the logo */}
            <div className="absolute inset-0 bg-[#D4AF37] blur-[80px] opacity-40 animate-pulse rounded-full" />
            
            <motion.img 
              src="/A2Sniper-logo.jpeg" 
              alt="A2Sniper Logo" 
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 6, ease: "linear" }}
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
        </motion.div>
      )}
    </AnimatePresence>
  );
}
