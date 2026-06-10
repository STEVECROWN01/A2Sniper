'use client';

import { useCallback } from 'react';
import { useAppStore } from '@/lib/store';
import { useRouter } from 'next/navigation';

export function useGoogleAuth() {
  const router = useRouter();
  const { setAuthenticated, setUser } = useAppStore();

  const handleDevToken = async (token: string) => {
    console.log('🔧 Utilisation du token de dev', token);
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:8000';
      const res = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token }),
      });
      const data = await res.json();
      console.log('🔧 Réponse du backend (dev)', data);
      if (res.ok) {
        localStorage.setItem('a2sniper_token', data.token);
        setUser(data.user);
        setAuthenticated(true);
        router.push('/dashboard');
      } else {
        alert('⚠️ Erreur backend (dev) : ' + (data.detail || 'Erreur inconnue'));
      }
    } catch (e) {
      console.error(e);
      alert('⚠️ Erreur réseau (dev) : Veuillez réessayer.');
    }
  };

  const signInWithGoogle = useCallback(() => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    const devToken = process.env.GOOGLE_DEV_TOKEN;

    if (!clientId || clientId === 'VOTRE_CLIENT_ID_ICI') {
      if (devToken) {
        console.warn('⚠️ CLIENT_ID non configuré – utilisation du token de développement.');
        handleDevToken(devToken);
        return;
      }
      alert(
        '⚠️ Configuration requise\n\n' +
        'Pour activer Google Sign‑In :\n' +
        '1. Allez sur console.cloud.google.com\n' +
        '2. Créez un projet et activez "Google+ API"\n' +
        '3. Créez des identifiants OAuth 2.0 (type: Web Application)\n' +
        '4. Ajoutez http://localhost:3000/google-callback dans les URI de redirection autorisées\n' +
        '5. Remplacez NEXT_PUBLIC_GOOGLE_CLIENT_ID par votre Client ID' 
      );
      return;
    }
    
    // Logic for actual Google Sign-In redirect would go here
  }, [handleDevToken]);

  const handleGoogleCallback = useCallback(async () => {
    const hash = window.location.hash;
    console.log('🔧 Hash reçu', hash);
    const params = new URLSearchParams(hash.substring(1));
    const accessToken = params.get('access_token');
    console.log('🔧 access_token extrait', accessToken);

    if (!accessToken) return false;

    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:8000';
      const res = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken }),
      });
      const data = await res.json();
      console.log('🔧 Réponse du backend', data);

      if (res.ok) {
        localStorage.setItem('a2sniper_token', data.token);
        setUser(data.user);
        setAuthenticated(true);
        router.push('/dashboard');
        return true;
      } else {
        alert('⚠️ Erreur serveur : ' + (data.detail || 'Impossible de se connecter'));
      }
    } catch (e) {
      console.error(e);
      alert('⚠️ Erreur réseau – veuillez réessayer.');
    }
    return false;
  }, [router, setAuthenticated, setUser]);

  return { signInWithGoogle, handleGoogleCallback };
}
