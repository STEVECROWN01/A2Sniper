'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useGoogleAuth } from '@/hooks/use-google-auth';
import { Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

export default function GoogleCallbackPage() {
  const router = useRouter();
  const { handleGoogleCallback } = useGoogleAuth();
  const [error, setError] = useState('');
  const hasExecuted = useRef(false);

  useEffect(() => {
    // Guard against React Strict Mode double-execution
    // Google auth codes are one-time use - exchanging twice causes 400 errors
    if (hasExecuted.current) return;
    hasExecuted.current = true;

    const timeout = setTimeout(() => {
      setError('Google sign-in timed out. Please try again.');
      setTimeout(() => router.replace('/login'), 2000);
    }, 15000); // 15-second timeout

    (async () => {
      try {
        const ok = await handleGoogleCallback();
        clearTimeout(timeout);
        if (!ok) {
          setError('Google sign-in failed. Please try again.');
          setTimeout(() => router.replace('/login'), 2000);
        }
      } catch (err) {
        clearTimeout(timeout);
        setError('An error occurred during Google sign-in.');
        setTimeout(() => router.replace('/login'), 2000);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#050507]">
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center"
      >
        {error ? (
          <>
            <p className="text-red-400 text-lg font-medium mb-2">Error</p>
            <p className="text-gray-400 text-sm">{error}</p>
          </>
        ) : (
          <>
            <Loader2 className="w-12 h-12 animate-spin text-[#D4AF37] mb-4" />
            <p className="text-white text-lg font-medium">Signing in with Google...</p>
          </>
        )}
      </motion.div>
    </div>
  );
}
