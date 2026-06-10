'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useGoogleAuth } from '@/hooks/use-google-auth';
import { Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

export default function GoogleCallbackPage() {
  const router = useRouter();
  const { handleGoogleCallback } = useGoogleAuth();

  useEffect(() => {
    (async () => {
      const ok = await handleGoogleCallback();
      if (!ok) {
        router.replace('/login');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Simple animated loading UI
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900">
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center"
      >
        <Loader2 className="w-12 h-12 animate-spin text-[#D4AF37] mb-4" />
        <p className="text-white text-lg font-medium">Connexion Google en cours…</p>
      </motion.div>
    </div>
  );
}
