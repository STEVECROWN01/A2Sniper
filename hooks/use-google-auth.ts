'use client';

import { useCallback } from 'react';
import { useAppStore } from '@/lib/store';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function useGoogleAuth() {
  const router = useRouter();
  const { setAuthenticated, setUser } = useAppStore();

  const signInWithGoogle = useCallback(() => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

    if (!clientId || clientId === 'VOTRE_CLIENT_ID_ICI' || clientId === '') {
      toast.error(
        'Google OAuth non configuré. Pour activer la connexion Google, l\'administrateur doit configurer NEXT_PUBLIC_GOOGLE_CLIENT_ID dans les variables d\'environnement.'
      );
      return;
    }

    // Google Sign-In redirect using OAuth 2.0 implicit flow
    const redirectUri = `${window.location.origin}/google-callback`;
    const scope = 'openid email profile';
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scope)}`;
    window.location.href = authUrl;
  }, []);

  const handleGoogleCallback = useCallback(async () => {
    const hash = window.location.hash;
    const params = new URLSearchParams(hash.substring(1));
    const accessToken = params.get('access_token');

    if (!accessToken) return false;

    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '') || 'http://localhost:8000';
      const res = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken }),
      });
      const data = await res.json();

      if (res.ok) {
        localStorage.setItem('a2sniper_token', data.token);
        setUser(data.user);
        setAuthenticated(true);
        router.push('/dashboard');
        return true;
      } else {
        toast.error('Erreur serveur : ' + (data.detail || 'Impossible de se connecter'));
      }
    } catch (e) {
      console.error(e);
      toast.error('Erreur réseau – veuillez réessayer.');
    }
    return false;
  }, [router, setAuthenticated, setUser]);

  return { signInWithGoogle, handleGoogleCallback };
}
