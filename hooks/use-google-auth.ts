'use client';

import { getApiUrl } from '@/lib/api-config';
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
        'Google OAuth is not configured. To enable Google sign-in, the administrator must set NEXT_PUBLIC_GOOGLE_CLIENT_ID in environment variables.'
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

    if (!accessToken && !code) {
      console.error('[Google Auth Callback] No access_token or code found in URL');
      return false;
    }

    try {
      const baseUrl = getApiUrl().replace(/\/+$/, '');

      // If we have an authorization code, exchange it via backend
      if (code && !accessToken) {
        const redirectUri = `${window.location.origin}/google-callback`;
        const res = await fetch(`${baseUrl}/api/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',  // Cookies sent automatically
          body: JSON.stringify({ code, redirect_uri: redirectUri }),
        });

        if (!res.ok) {
          let errorMsg = `Server error (${res.status})`;
          try {
            const errData = await res.json();
            errorMsg = 'Server error: ' + (errData.detail || JSON.stringify(errData));
          } catch {
            try { errorMsg = 'Server error: ' + await res.text(); } catch {}
          }
          toast.error(errorMsg);
          return false;
        }

        let data;
        try {
          data = await res.json();
        } catch (parseErr) {
          console.error('[Google Auth] Failed to parse response as JSON:', parseErr);
          toast.error('Server returned invalid response. Please try again.');
          return false;
        }

        // Tokens are now in httpOnly cookies — no localStorage needed
        const userData = data.user || {};
        // Fetch full profile from /api/auth/me as verification
        try {
          const meRes = await fetch(`${baseUrl}/api/auth/me`, { credentials: 'include' });
          if (meRes.ok) {
            const fullUser = await meRes.json();
            setUser(fullUser);
          } else {
            setUser(userData);
          }
        } catch {
          setUser(userData);
        }
        setAuthenticated(true);
        router.push('/dashboard');
        return true;
      }

      // If we have an access token (implicit flow), verify it via backend
      const res = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ access_token: accessToken }),
      });

      if (!res.ok) {
        let errorMsg = `Server error (${res.status})`;
        try {
          const errData = await res.json();
          errorMsg = 'Server error: ' + (errData.detail || JSON.stringify(errData));
        } catch {
          try { errorMsg = 'Server error: ' + await res.text(); } catch {}
        }
        toast.error(errorMsg);
        return false;
      }

      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        console.error('[Google Auth] Failed to parse response as JSON:', parseErr);
        toast.error('Server returned invalid response. Please try again.');
        return false;
      }

      // Tokens are now in httpOnly cookies — no localStorage needed
      const userData = data.user || {};
      try {
        const meRes = await fetch(`${baseUrl}/api/auth/me`, { credentials: 'include' });
        if (meRes.ok) {
          const fullUser = await meRes.json();
          setUser(fullUser);
        } else {
          setUser(userData);
        }
      } catch {
        setUser(userData);
      }
      setAuthenticated(true);
      router.push('/dashboard');
      return true;
    } catch (e) {
      console.error(e);
      toast.error('Network error. Please try again.');
    }
    return false;
  }, [router, setAuthenticated, setUser]);

  return { signInWithGoogle, handleGoogleCallback };
}
