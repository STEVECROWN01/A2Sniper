'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useEffect } from 'react';
import { Mail, Lock, ArrowRight, Eye, EyeOff, ArrowLeft, KeyRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAppStore } from '@/lib/store';
import { useGoogleAuth } from '@/hooks/use-google-auth';

type Step = 'LOGIN' | 'FORGOT_EMAIL' | 'FORGOT_OTP' | 'FORGOT_NEW_PWD';

export default function LoginPage() {
  const router = useRouter();
  const { setAuthenticated, setUser, isAuthenticated, isInitialized, initialize } = useAppStore();
  const { signInWithGoogle } = useGoogleAuth();
  
  // Login State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  
  // Forgot Password State
  const [step, setStep] = useState<Step>('LOGIN');
  const [forgotEmail, setForgotEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  
  // Global State
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';

  useEffect(() => {
    if (isInitialized && isAuthenticated) {
      router.push('/dashboard');
    }
  }, [isAuthenticated, isInitialized, router]);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
    if (isInitialized && !isAuthenticated && token) {
      initialize();
      const timer = setTimeout(() => {
        const currentToken = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
        if (!useAppStore.getState().isAuthenticated && currentToken) {
          initialize();
        }
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isInitialized, isAuthenticated, initialize]);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const res = await fetch(`${apiUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        data = {};
      }

      if (res.ok) {
        localStorage.setItem('a2sniper_token', data.token);
        setUser(data.user);
        setAuthenticated(true);
        router.push('/dashboard');
      } else {
        if (res.status === 401) {
          setError("Compte introuvable ou mot de passe incorrect. (Si vous venez de redémarrer le serveur, vos données locales ont été réinitialisées : veuillez vous réinscrire en cliquant ci-dessous !)");
        } else {
          setError(data.detail || "Email ou mot de passe incorrect");
        }
      }
    } catch (err) {
      setError('Erreur réseau. Veuillez vérifier que le serveur est bien démarré.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    
    try {
      const res = await fetch(`${apiUrl}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail })
      });
      const data = await res.json();
      if (res.ok) {
        setStep('FORGOT_OTP');
      } else {
        setError(data.detail || "Erreur lors de l'envoi");
      }
    } catch (err) {
      setError('Erreur réseau.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    
    try {
      const res = await fetch(`${apiUrl}/api/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail, otp_code: otpCode })
      });
      const data = await res.json();
      if (res.ok) {
        setStep('FORGOT_NEW_PWD');
      } else {
        setError(data.detail || "Code OTP invalide");
      }
    } catch (err) {
      setError('Erreur réseau.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleNewPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("Les mots de passe ne correspondent pas");
      return;
    }
    
    setIsLoading(true);
    setError('');
    
    try {
      const res = await fetch(`${apiUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail, otp_code: otpCode, new_password: newPassword })
      });
      const data = await res.json();
      if (res.ok) {
        setSuccessMsg("Mot de passe modifié avec succès !");
        setStep('LOGIN');
        setEmail(forgotEmail);
        setPassword('');
      } else {
        setError(data.detail || "Erreur lors de la réinitialisation");
      }
    } catch (err) {
      setError('Erreur réseau.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleLogin = () => {
    setError('');
    setIsGoogleLoading(true);
    signInWithGoogle();
  };

  const resetFlow = () => {
    setStep('LOGIN');
    setError('');
    setSuccessMsg('');
  };

  // Formulaire de connexion standard
  const renderLogin = () => (
    <motion.div
      key="LOGIN"
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.3 }}
    >
      <form onSubmit={handleLoginSubmit} className="space-y-5">
        <div>
          <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2 block">Email</label>
          <div className="relative">
            <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3.5 pl-12 pr-4 text-white focus:border-[#D4AF37] focus:bg-white/[0.04] outline-none transition-all text-sm font-semibold"
              placeholder="name@example.com"
              required
            />
          </div>
        </div>

        <div>
          <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2 block">Mot de passe</label>
          <div className="relative">
            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3.5 pl-12 pr-12 text-white focus:border-[#D4AF37] focus:bg-white/[0.04] outline-none transition-all text-sm font-semibold"
              placeholder="••••••••"
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
              tabIndex={0}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <div className="text-right mt-2">
            <button 
              type="button" 
              onClick={() => setStep('FORGOT_EMAIL')}
              className="text-[10px] text-gray-400 hover:text-[#D4AF37] transition-colors"
            >
              Mot de passe oublié ?
            </button>
          </div>
        </div>

        {error && (
          <motion.p initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="text-red-400 text-xs bg-red-500/10 p-3.5 rounded-xl border border-red-500/20 font-bold">
            {error}
          </motion.p>
        )}
        {successMsg && (
          <motion.p initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="text-green-400 text-xs bg-green-500/10 p-3.5 rounded-xl border border-green-500/20 font-bold">
            {successMsg}
          </motion.p>
        )}

        <button
          type="submit"
          disabled={isLoading}
          className="w-full bg-gradient-to-r from-[#D4AF37] to-[#C5A059] hover:from-[#c5a059] hover:to-[#D4AF37] text-black py-4 rounded-xl font-black uppercase text-xs tracking-[0.2em] transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(212,175,55,0.2)] active:scale-[0.98]"
        >
          {isLoading ? 'Connexion...' : 'Se connecter'}
          <ArrowRight className="w-4 h-4 text-black" />
        </button>
      </form>

      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-white/5"></div>
        </div>
        <div className="relative flex justify-center text-[10px] uppercase">
          <span className="bg-[#0a0a0c] px-3 text-gray-500 font-bold tracking-widest">Ou continuer avec</span>
        </div>
      </div>

      <button
        type="button"
        onClick={handleGoogleLogin}
        disabled={isLoading || isGoogleLoading}
        className="w-full bg-white hover:bg-gray-50 text-[#1f1f1f] py-3.5 rounded-xl font-bold text-sm flex items-center justify-center gap-3 transition-all duration-300 shadow-[0_2px_12px_rgba(0,0,0,0.2)] disabled:opacity-50 active:scale-[0.98] border border-gray-200"
      >
        {isGoogleLoading ? (
          <div className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335" />
          </svg>
        )}
        {isGoogleLoading ? 'Redirection vers Google...' : "Se connecter avec Google"}
      </button>

      <p className="mt-8 text-center text-gray-500 text-xs font-bold uppercase tracking-wider">
        Pas encore de compte ?{' '}
        <Link href="/signup" className="text-[#D4AF37] hover:text-[#F3E5AB] transition-colors ml-1">
          S'inscrire gratuitement
        </Link>
      </p>
    </motion.div>
  );

  // Formulaire d'envoi d'email pour l'OTP
  const renderForgotEmail = () => (
    <motion.div
      key="FORGOT_EMAIL"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3 }}
    >
      <div className="mb-6">
        <button onClick={resetFlow} className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-xs font-bold">
          <ArrowLeft className="w-3 h-3" /> Retour
        </button>
      </div>
      <h2 className="text-xl font-bold text-white mb-2">Mot de passe oublié</h2>
      <p className="text-gray-400 text-sm mb-6">Saisissez votre email pour recevoir un code de réinitialisation.</p>

      <form onSubmit={handleForgotEmailSubmit} className="space-y-5">
        <div>
          <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2 block">Email du compte</label>
          <div className="relative">
            <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="email"
              value={forgotEmail}
              onChange={(e) => setForgotEmail(e.target.value)}
              className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3.5 pl-12 pr-4 text-white focus:border-[#D4AF37] focus:bg-white/[0.04] outline-none transition-all text-sm font-semibold"
              placeholder="votre@email.com"
              required
            />
          </div>
        </div>

        {error && (
          <motion.p initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="text-red-400 text-xs bg-red-500/10 p-3.5 rounded-xl border border-red-500/20 font-bold">
            {error}
          </motion.p>
        )}

        <button
          type="submit"
          disabled={isLoading || !forgotEmail}
          className="w-full bg-gradient-to-r from-[#D4AF37] to-[#C5A059] hover:from-[#c5a059] hover:to-[#D4AF37] text-black py-4 rounded-xl font-black uppercase text-xs tracking-[0.2em] transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isLoading ? 'Envoi...' : 'Envoyer le code'}
          <ArrowRight className="w-4 h-4 text-black" />
        </button>
      </form>
    </motion.div>
  );

  // Formulaire de saisie du code OTP
  const renderOtp = () => (
    <motion.div
      key="FORGOT_OTP"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3 }}
    >
      <div className="mb-6">
        <button onClick={() => setStep('FORGOT_EMAIL')} className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-xs font-bold">
          <ArrowLeft className="w-3 h-3" /> Modifier l'email
        </button>
      </div>
      <h2 className="text-xl font-bold text-white mb-2">Vérification OTP</h2>
      <p className="text-gray-400 text-sm mb-6">Nous avons envoyé un code à 6 chiffres à <strong>{forgotEmail}</strong>.</p>

      <form onSubmit={handleOtpSubmit} className="space-y-5">
        <div>
          <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2 block">Code à 6 chiffres</label>
          <div className="relative">
            <KeyRound className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              maxLength={6}
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/[^0-9]/g, ''))}
              className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3.5 pl-12 pr-4 text-white focus:border-[#D4AF37] focus:bg-white/[0.04] outline-none transition-all text-center text-lg font-bold tracking-[0.5em]"
              placeholder="000000"
              required
            />
          </div>
        </div>

        {error && (
          <motion.p initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="text-red-400 text-xs bg-red-500/10 p-3.5 rounded-xl border border-red-500/20 font-bold">
            {error}
          </motion.p>
        )}

        <button
          type="submit"
          disabled={isLoading || otpCode.length !== 6}
          className="w-full bg-gradient-to-r from-[#D4AF37] to-[#C5A059] hover:from-[#c5a059] hover:to-[#D4AF37] text-black py-4 rounded-xl font-black uppercase text-xs tracking-[0.2em] transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isLoading ? 'Vérification...' : 'Vérifier le code'}
          <ArrowRight className="w-4 h-4 text-black" />
        </button>
      </form>
    </motion.div>
  );

  // Formulaire de nouveau mot de passe
  const renderNewPassword = () => (
    <motion.div
      key="FORGOT_NEW_PWD"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3 }}
    >
      <h2 className="text-xl font-bold text-white mb-2">Nouveau mot de passe</h2>
      <p className="text-gray-400 text-sm mb-6">Choisissez un nouveau mot de passe sécurisé.</p>

      <form onSubmit={handleNewPasswordSubmit} className="space-y-5">
        <div>
          <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2 block">Nouveau mot de passe</label>
          <div className="relative">
            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type={showNewPassword ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3.5 pl-12 pr-12 text-white focus:border-[#D4AF37] focus:bg-white/[0.04] outline-none transition-all text-sm font-semibold"
              placeholder="••••••••"
              required
              minLength={6}
            />
            <button
              type="button"
              onClick={() => setShowNewPassword(!showNewPassword)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
              tabIndex={-1}
            >
              {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div>
          <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2 block">Confirmer</label>
          <div className="relative">
            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type={showNewPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3.5 pl-12 pr-4 text-white focus:border-[#D4AF37] focus:bg-white/[0.04] outline-none transition-all text-sm font-semibold"
              placeholder="••••••••"
              required
            />
          </div>
        </div>

        {error && (
          <motion.p initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="text-red-400 text-xs bg-red-500/10 p-3.5 rounded-xl border border-red-500/20 font-bold">
            {error}
          </motion.p>
        )}

        <button
          type="submit"
          disabled={isLoading || !newPassword || !confirmPassword}
          className="w-full bg-gradient-to-r from-[#D4AF37] to-[#C5A059] hover:from-[#c5a059] hover:to-[#D4AF37] text-black py-4 rounded-xl font-black uppercase text-xs tracking-[0.2em] transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isLoading ? 'Mise à jour...' : 'Mettre à jour le mot de passe'}
          <ArrowRight className="w-4 h-4 text-black" />
        </button>
      </form>
    </motion.div>
  );

  return (
    <div className="min-h-screen bg-[#050507] text-gray-200 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Background Orbs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 -left-20 w-[500px] h-[500px] bg-[#D4AF37]/10 rounded-full blur-[150px]" />
        <div className="absolute bottom-1/4 -right-20 w-[500px] h-[500px] bg-[#D4AF37]/10 rounded-full blur-[150px]" />
      </div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md relative z-10"
      >
        <div className="bg-[#0a0a0c]/80 border border-white/5 backdrop-blur-2xl p-8 rounded-[2.5rem] shadow-[0_0_50px_rgba(0,0,0,0.8)] overflow-hidden">
          {/* Logo A2Sniper */}
          <div className="text-center mb-8">
            <div className="flex justify-center mb-6">
              <div className="relative group">
                <div className="absolute inset-0 bg-[#D4AF37] blur-[20px] opacity-40 rounded-3xl group-hover:scale-110 transition-transform duration-500" />
                <img
                  src="/A2Sniper-logo.jpeg"
                  alt="A2Sniper Logo"
                  className="w-20 h-20 object-cover rounded-3xl border-2 border-[#D4AF37]/50 relative z-10 shadow-[0_0_20px_rgba(212,175,55,0.3)] group-hover:border-[#D4AF37] transition-all duration-300"
                />
              </div>
            </div>
            <h1 className="text-2xl font-black text-white mb-2 uppercase tracking-tight">
              Bon retour <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB]">sniper</span>
            </h1>
            <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">
              Accédez à vos signaux 100% réels
            </p>
          </div>

          <div className="relative">
            <AnimatePresence mode="wait">
              {step === 'LOGIN' && renderLogin()}
              {step === 'FORGOT_EMAIL' && renderForgotEmail()}
              {step === 'FORGOT_OTP' && renderOtp()}
              {step === 'FORGOT_NEW_PWD' && renderNewPassword()}
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
