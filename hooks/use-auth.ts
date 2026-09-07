'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAppStore } from '@/lib/store';

export function useAuth(requireAdmin = false) {
  const { isAuthenticated, user, isInitialized } = useAppStore();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isInitialized) return; // Wait until store is initialized

    // ─── ADMIN ROUTES: skip the regular user auth check ─────────────
    // Admin pages use a separate auth mechanism (admin_token cookie,
    // verified by the admin layout via /api/admin/config ping). The
    // regular user auth store (isAuthenticated) is NOT set by admin
    // login — it's only set by regular user login (/login).
    //
    // Without this check, every admin page redirects to /login because
    // isAuthenticated is false after admin login (which only sets the
    // admin_token cookie, not the regular user auth state).
    if (pathname.startsWith('/admin-dawes-stevens-2026')) {
      return; // Admin auth is handled by the admin layout, not this hook
    }

    // Liste des pages publiques
    const publicPages = ['/', '/login', '/signup', '/pricing', '/legal', '/google-callback'];

    if (!isAuthenticated && !publicPages.includes(pathname)) {
      router.push('/login');
    }

    if (requireAdmin && user && !user.is_admin) {
      router.push('/dashboard');
    }
  }, [isAuthenticated, user, isInitialized, pathname, router, requireAdmin]);

  return { isAuthenticated, user };
}
