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

    // Use Google OAuth 2.0 Authorization Code flow (more reliable than implicit flow)
    const redirectUri = `${window.location.origin}/google-callback`;
    const scope = 'openid email profile';
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;
    window.location.href = authUrl;
  }, []);

  const handleGoogleCallback = useCallback(async () => {
    // Try to get access_token from hash (implicit flow)
    const hash = window.location.hash;
    let accessToken = '';

    if (hash) {
      const params = new URLSearchParams(hash.substring(1));
      accessToken = params.get('access_token') || '';
    }

    // Try to get code from query params (authorization code flow)
    const searchParams = new URLSearchParams(window.location.search);
    const code = searchParams.get('code');

    console.log('[Google Auth Callback] hash:', hash ? 'present' : 'empty', 'code:', code ? 'present' : 'empty', 'accessToken:', accessToken ? 'present' : 'empty');

    if (!accessToken && !code) {
      console.error('[Google Auth Callback] No access_token or code found in URL');
      return false;
    }

    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '') || 'http://localhost:8000';

      // If we have an authorization code, exchange it via backend
      if (code && !accessToken) {
        const redirectUri = `${window.location.origin}/google-callback`;
        const res = await fetch(`${baseUrl}/api/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, redirect_uri: redirectUri }),
        });
        const data = await res.json();
        console.log('[Google Auth] Code exchange response:', res.status, data);

        if (res.ok) {
          localStorage.setItem('a2sniper_token', data.token);
          setUser(data.user);
          setAuthenticated(true);
          router.push('/dashboard');
          return true;
        } else {
          toast.error('Erreur serveur : ' + (data.detail || 'Impossible de se connecter'));
          return false;
        }
      }

      // If we have an access token (implicit flow), verify it via backend
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
