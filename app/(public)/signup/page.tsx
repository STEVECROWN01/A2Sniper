'use client';

import { getApiUrl } from '@/lib/api-config';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useEffect } from 'react';
import { Mail, Lock, User, ArrowRight, Eye, EyeOff, KeyRound, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAppStore } from '@/lib/store';
import { useGoogleAuth } from '@/hooks/use-google-auth';
import { toast } from 'sonner';

type Step = 'FORM' | 'OTP';

export default function SignupPage() {
  const router = useRouter();
  const { isAuthenticated, isInitialized, initialize } = useAppStore();
  const { signInWithGoogle } = useGoogleAuth();
  const [step, setStep] = useState<Step>('FORM');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const [otpCode, setOtpCode] = useState('');

  useEffect(() => {
    if (isInitialized && isAuthenticated) {
      router.push('/dashboard');
    }
  }, [isAuthenticated, isInitialized, router]);

  // If store is initialized but auth state unclear, try to initialize
  useEffect(() => {
    if (isInitialized && !isAuthenticated) {
      initialize();
    }
  }, [isInitialized, isAuthenticated, initialize]);

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      setIsLoading(false);
      return;
    }

    try {
      const baseUrl = getApiUrl().replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/api/auth/register-send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, email, password }),
      });

      let data;
      try {
        data = await res.json();
      } catch {
        setError('Server returned an invalid response. Please try again.');
        return;
      }

      if (res.ok) {
        setStep('OTP');
      } else {
        // Handle FastAPI validation errors (detail can be array of objects)
        const detail = data.detail;
        if (typeof detail === 'string') {
          setError(detail);
        } else if (Array.isArray(detail)) {
          setError(detail.map((d: { msg?: string; message?: string }) => d.msg || d.message || 'Validation error').join('. '));
        } else {
          setError('Registration failed. Please try again.');
        }
      }
    } catch {
      setError('Unable to connect. Please check your internet connection and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const baseUrl = getApiUrl().replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/api/auth/register-verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, email, password, otp_code: otpCode }),
      });

      let data;
      try {
        data = await res.json();
      } catch {
        setError('Server returned an invalid response. Please try again.');
        return;
      }

      if (res.ok) {
        toast.success('Account created successfully! Please sign in with your registered email and password.', {
          duration: 6000,
        });
        setTimeout(() => {
          router.push('/login');
        }, 3500);
      } else {
        const detail = data.detail;
        if (typeof detail === 'string') {
          setError(detail);
        } else if (Array.isArray(detail)) {
          setError(detail.map((d: { msg?: string; message?: string }) => d.msg || d.message || 'Validation error').join('. '));
        } else {
          setError('OTP verification failed. Please try again.');
        }
      }
    } catch {
      setError('Unable to connect. Please check your internet connection and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignup = () => {
    setError('');
    setIsGoogleLoading(true);
    signInWithGoogle();
    // setIsGoogleLoading(false) will be handled by the callback page
  };

  const renderForm = () => (
    <motion.div
      key="FORM"
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3 }}
    >
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
          Join the{' '}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB]">
            A2Sniper
          </span>{' '}
          Elite
        </h1>
        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">
          Create your free account!
        </p>
      </div>

      <form onSubmit={handleFormSubmit} className="space-y-5">
        {/* Full Name */}
        <div>
          <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2 block">
            Full Name
          </label>
          <div className="relative">
            <User className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3.5 pl-12 pr-4 text-white focus:border-[#D4AF37] focus:bg-white/[0.04] outline-none transition-all text-sm font-semibold"
              placeholder="Alex Sniper"
              required
            />
          </div>
        </div>

        {/* Email */}
        <div>
          <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2 block">
            Sniper Email
          </label>
          <div className="relative">
            <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3.5 pl-12 pr-4 text-white focus:border-[#D4AF37] focus:bg-white/[0.04] outline-none transition-all text-sm font-semibold"
              placeholder="sniper@a2sniper.com"
              required
            />
          </div>
        </div>

        {/* Password */}
        <div>
          <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2 block">
            Password
          </label>
          <div className="relative">
            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type={showPassword ? 'text' : 'password'}
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
              tabIndex={-1}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Confirm Password */}
        <div>
          <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2 block">
            Confirm Password
          </label>
          <div className="relative">
            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type={showConfirmPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3.5 pl-12 pr-12 text-white focus:border-[#D4AF37] focus:bg-white/[0.04] outline-none transition-all text-sm font-semibold"
              placeholder="••••••••"
              required
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
              tabIndex={-1}
            >
              {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {error && (
          <motion.p
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-red-400 text-xs bg-red-500/10 p-3.5 rounded-xl border border-red-500/20 font-bold"
          >
            {error}
          </motion.p>
        )}

        <button
          type="submit"
          disabled={isLoading || isGoogleLoading}
          className="w-full bg-gradient-to-r from-[#D4AF37] to-[#C5A059] hover:from-[#c5a059] hover:to-[#D4AF37] text-black py-4 rounded-xl font-black uppercase text-xs tracking-[0.2em] transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(212,175,55,0.2)] active:scale-[0.98]"
        >
          {isLoading ? 'Sending OTP...' : 'Create My Sniper Account'}
          <ArrowRight className="w-4 h-4 text-black" />
        </button>
      </form>

      {/* Divider */}
      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-white/5" />
        </div>
        <div className="relative flex justify-center text-[10px] uppercase">
          <span className="bg-[#0a0a0c] px-3 text-gray-500 font-bold tracking-widest">
            Or continue with
          </span>
        </div>
      </div>

      {/* Google OAuth button */}
      <button
        type="button"
        onClick={handleGoogleSignup}
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
        {isGoogleLoading ? 'Redirecting to Google...' : 'Sign up with Google'}
      </button>

      <p className="mt-8 text-center text-gray-500 text-xs font-bold uppercase tracking-wider">
        Already a Sniper?{' '}
        <Link href="/login" className="text-[#D4AF37] hover:text-[#F3E5AB] transition-colors ml-1">
          Sign In
        </Link>
      </p>
    </motion.div>
  );

  const renderOtp = () => (
    <motion.div
      key="OTP"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3 }}
    >
      <div className="mb-6">
        <button onClick={() => { setStep('FORM'); setError(''); }} className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-xs font-bold">
          <ArrowLeft className="w-3 h-3" /> Back to form
        </button>
      </div>
      <h2 className="text-xl font-bold text-white mb-2">OTP Verification</h2>
      <p className="text-gray-400 text-sm mb-6">We sent a 6-digit code to <strong>{email}</strong>.</p>

      <form onSubmit={handleOtpSubmit} className="space-y-5">
        <div>
          <label className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2 block">6-Digit Code</label>
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
          <motion.p
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-red-400 text-xs bg-red-500/10 p-3.5 rounded-xl border border-red-500/20 font-bold"
          >
            {error}
          </motion.p>
        )}

        <button
          type="submit"
          disabled={isLoading || otpCode.length !== 6}
          className="w-full bg-gradient-to-r from-[#D4AF37] to-[#C5A059] hover:from-[#c5a059] hover:to-[#D4AF37] text-black py-4 rounded-xl font-black uppercase text-xs tracking-[0.2em] transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(212,175,55,0.2)] active:scale-[0.98]"
        >
          {isLoading ? 'Verifying...' : 'Verify Code'}
          <ArrowRight className="w-4 h-4 text-black" />
        </button>
      </form>
    </motion.div>
  );

  return (
    <div className="min-h-screen bg-[#050507] text-gray-200 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Background Orbs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 -right-20 w-[500px] h-[500px] bg-[#D4AF37]/10 rounded-full blur-[150px]" />
        <div className="absolute bottom-1/4 -left-20 w-[500px] h-[500px] bg-[#D4AF37]/10 rounded-full blur-[150px]" />
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md relative z-10"
      >
        <div className="bg-[#0a0a0c]/80 border border-white/5 backdrop-blur-2xl p-8 rounded-[2.5rem] shadow-[0_0_50px_rgba(0,0,0,0.8)]">
          {step === 'FORM' && renderForm()}
          {step === 'OTP' && renderOtp()}
        </div>
      </motion.div>
    </div>
  );
}
