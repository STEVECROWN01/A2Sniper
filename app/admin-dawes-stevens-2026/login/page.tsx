'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, ShieldCheck, Lock, Fingerprint, Terminal, Mail, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export default function AdminLoginPage() {
  const [step, setStep] = useState<'login' | '2fa' | 'success'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [otp, setOtp] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const router = useRouter();

  const handleLogin = async () => {
    if (!email || !password) {
      toast.error('Veuillez entrer vos identifiants administrateur.');
      return;
    }

    setIsVerifying(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const res = await fetch(`${apiUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (res.ok) {
        const data = await res.json();
        // Check if the user is actually an admin
        if (!data.user?.is_admin) {
          setIsVerifying(false);
          toast.error('Accès refusé. Privilèges administrateur requis.');
          return;
        }
        // Store the JWT token from the backend
        if (typeof window !== 'undefined') {
          localStorage.setItem('a2sniper_token', data.token);
        }
        setAuthToken(data.token);
        setStep('2fa');
        toast.success('Identité vérifiée. Veuillez saisir le code 2FA.');
      } else {
        const data = await res.json().catch(() => ({}));
        setIsVerifying(false);
        toast.error(data.detail || 'Identifiants invalides. Accès refusé.');
      }
    } catch (err) {
      setIsVerifying(false);
      toast.error('Erreur réseau. Impossible de vérifier les identifiants.');
    }
  };

  const handleVerify2FA = async () => {
    if (otp.length < 6) {
      toast.error('Veuillez saisir le code 2FA complet (6 chiffres).');
      return;
    }

    setIsVerifying(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const res = await fetch(`${apiUrl}/api/auth/verify-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ otp_code: otp }),
      });

      if (res.ok) {
        setStep('success');
        toast.success('Accès accordé. Bienvenue, Fondateur.');

        setTimeout(() => {
          router.push('/admin-dawes-stevens-2026');
        }, 2000);
      } else {
        const data = await res.json().catch(() => ({}));
        setIsVerifying(false);
        setOtp('');
        toast.error(data.detail || 'Code 2FA invalide. Accès refusé.');
      }
    } catch (err) {
      setIsVerifying(false);
      setOtp('');
      toast.error('Erreur réseau. Impossible de vérifier le code 2FA.');
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
              {step === 'login' && (
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
          {step === 'login' && (
            <motion.div
              key="login-ui"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="space-y-6"
            >
              <div className="p-4 bg-black/40 border border-gray-800 rounded-lg">
                <div className="flex items-center gap-3 mb-2">
                  <Terminal className="w-4 h-4 text-red-500" />
                  <span className="text-xs text-gray-400">ADMIN CREDENTIALS</span>
                </div>
              </div>

              <div>
                <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mb-2">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@a2sniper.ai"
                    className="w-full bg-black border border-gray-800 rounded-xl pl-10 pr-4 py-3 text-sm font-bold text-white outline-none focus:border-red-500 transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest block mb-2">Mot de passe</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-black border border-gray-800 rounded-xl pl-10 pr-10 py-3 text-sm font-bold text-white outline-none focus:border-red-500 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <Button
                onClick={handleLogin}
                disabled={isVerifying}
                className="w-full bg-red-600 hover:bg-red-700 text-white h-12 font-bold"
              >
                {isVerifying ? 'AUTHENTIFICATION...' : 'INITIALISER PROTOCOLE'}
              </Button>

              <div className="text-[10px] text-center text-gray-600 uppercase tracking-widest">
                Protégé par IP-Whitelist &amp; Token Sécurisé
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
                <p className="text-sm text-gray-400 mb-4">Saisissez le code à 6 chiffres de votre appareil authentificateur.</p>
                <input
                  type="text"
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  disabled={isVerifying}
                  className="w-48 text-center text-2xl font-black tracking-[0.5em] bg-black border border-red-500/30 rounded-xl py-4 text-white outline-none focus:border-red-500 transition-colors"
                  placeholder="------"
                />
              </div>

              <Button
                onClick={handleVerify2FA}
                disabled={isVerifying || otp.length < 6}
                className="w-full bg-red-600 hover:bg-red-700 text-white h-12 font-bold"
              >
                {isVerifying ? 'VALIDATION DU CODE...' : 'VÉRIFIER IDENTITÉ'}
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
              <div className="text-green-500 font-bold text-xl mb-2">SYSTÈME DÉVERROUILLÉ</div>
              <div className="text-gray-400 text-sm">Redirection vers le contrôle principal...</div>
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
