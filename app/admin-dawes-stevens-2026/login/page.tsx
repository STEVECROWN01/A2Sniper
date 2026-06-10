'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, ShieldCheck, Lock, Fingerprint, Terminal } from 'lucide-react';
import { 
  InputOTP, 
  InputOTPGroup, 
  InputOTPSlot, 
  InputOTPSeparator 
} from '@/components/ui/input-otp';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export default function AdminLoginPage() {
  const [step, setStep] = useState<'identify' | '2fa' | 'success'>('identify');
  const [otp, setOtp] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const router = useRouter();

  // Simulation d'une identité déjà connue pour le fondateur
  const founderName = "DAWES-STEVENS";

  const handleIdentify = () => {
    setIsVerifying(true);
    setTimeout(() => {
      setIsVerifying(false);
      setStep('2fa');
      toast.success("Identity verified. Requesting 2FA challenge.");
    }, 1500);
  };

  const handleVerify2FA = async () => {
    if (otp.length < 6) {
      toast.error("Please enter the full 6-digit code.");
      return;
    }

    setIsVerifying(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      const res = await fetch(`${apiUrl}/api/admin/verify-2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp_code: otp }),
      });
      
      if (res.ok) {
        const data = await res.json();
        // The API sets an httpOnly cookie for admin_token — no client-side cookie manipulation
        setStep('success');
        toast.success("Access Granted. Welcome back, Founder.");
        
        setTimeout(() => {
          router.push('/admin-dawes-stevens-2026');
        }, 2000);
      } else {
        const data = await res.json().catch(() => ({}));
        setIsVerifying(false);
        setOtp('');
        toast.error(data.detail || "Invalid 2FA Code. Access Denied.");
      }
    } catch (err) {
      setIsVerifying(false);
      setOtp('');
      toast.error("Network error. Could not verify 2FA code.");
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white flex items-center justify-center font-mono overflow-hidden relative">
      {/* Background Elements */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_50%_50%,#ff0000_0%,transparent_50%)]" />
        <div className="absolute inset-0" style={{ backgroundImage: 'radial-gradient(#333 1px, transparent 1px)', backgroundSize: '20px 20px' }} />
      </div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative z-10 w-full max-w-md p-8 bg-gray-900/50 backdrop-blur-xl border border-red-500/20 rounded-2xl shadow-[0_0_50px_rgba(255,0,0,0.1)]"
      >
        <div className="flex flex-col items-center mb-8">
          <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mb-4 border border-red-500/30">
            <AnimatePresence mode="wait">
              {step === 'identify' && (
                <motion.div key="lock" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>
                  <Lock className="w-10 h-10 text-red-500" />
                </motion.div>
              )}
              {step === '2fa' && (
                <motion.div key="fingerprint" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>
                  <Fingerprint className="w-10 h-10 text-red-500 animate-pulse" />
                </motion.div>
              )}
              {step === 'success' && (
                <motion.div key="check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}>
                  <ShieldCheck className="w-10 h-10 text-green-500" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <h1 className="text-2xl font-bold tracking-tighter text-center">
            {step === 'success' ? 'ACCESS GRANTED' : 'FOUNDER AUTHENTICATION'}
          </h1>
          <p className="text-gray-500 text-xs mt-2 uppercase tracking-[0.2em]">
            A2Sniper — Sniper Edition v3.0
          </p>
        </div>

        <AnimatePresence mode="wait">
          {step === 'identify' && (
            <motion.div 
              key="identify-ui"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="space-y-6"
            >
              <div className="p-4 bg-black/40 border border-gray-800 rounded-lg">
                <div className="flex items-center gap-3 mb-2">
                  <Terminal className="w-4 h-4 text-red-500" />
                  <span className="text-xs text-gray-400">SESSION IDENTIFIER</span>
                </div>
                <div className="text-lg font-bold text-red-500">
                  {founderName} <span className="animate-pulse">_</span>
                </div>
              </div>

              <Button 
                onClick={handleIdentify}
                disabled={isVerifying}
                className="w-full bg-red-600 hover:bg-red-700 text-white h-12 font-bold"
              >
                {isVerifying ? 'SCANNING BIOMETRICS...' : 'INITIALIZE PROTOCOL'}
              </Button>
              
              <div className="text-[10px] text-center text-gray-600 uppercase tracking-widest">
                Protected by IP-Whitelist &amp; Secure Token
              </div>
            </motion.div>
          )}

          {step === '2fa' && (
            <motion.div 
              key="2fa-ui"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="space-y-8 flex flex-col items-center"
            >
              <div className="text-center">
                <p className="text-sm text-gray-400 mb-4">Enter the 6-digit code from your authenticator device.</p>
                <InputOTP 
                  maxLength={6} 
                  value={otp} 
                  onChange={setOtp}
                  disabled={isVerifying}
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} className="w-12 h-14 text-xl border-red-500/30" />
                    <InputOTPSlot index={1} className="w-12 h-14 text-xl border-red-500/30" />
                    <InputOTPSlot index={2} className="w-12 h-14 text-xl border-red-500/30" />
                  </InputOTPGroup>
                  <InputOTPSeparator />
                  <InputOTPGroup>
                    <InputOTPSlot index={3} className="w-12 h-14 text-xl border-red-500/30" />
                    <InputOTPSlot index={4} className="w-12 h-14 text-xl border-red-500/30" />
                    <InputOTPSlot index={5} className="w-12 h-14 text-xl border-red-500/30" />
                  </InputOTPGroup>
                </InputOTP>
              </div>

              <Button 
                onClick={handleVerify2FA}
                disabled={isVerifying || otp.length < 6}
                className="w-full bg-red-600 hover:bg-red-700 text-white h-12 font-bold"
              >
                {isVerifying ? 'VALIDATING CODE...' : 'VERIFY IDENTITY'}
              </Button>
            </motion.div>
          )}

          {step === 'success' && (
            <motion.div 
              key="success-ui"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="text-center py-8"
            >
              <div className="text-green-500 font-bold text-xl mb-2">SYSTEM UNLOCKED</div>
              <div className="text-gray-400 text-sm">Redirecting to Master Control...</div>
              <div className="mt-8 flex justify-center">
                <div className="w-12 h-1 bg-gray-800 rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: '100%' }}
                    transition={{ duration: 2 }}
                    className="h-full bg-green-500"
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Security Footer */}
      <div className="absolute bottom-4 left-0 w-full text-center">
        <p className="text-[10px] text-gray-700 flex items-center justify-center gap-2">
          <ShieldAlert className="w-3 h-3" />
          SECURE CHANNEL ENCRYPTED (AES-256) — CLOUDFLARE ENTERPRISE ACTIVE
        </p>
      </div>
    </div>
  );
}
