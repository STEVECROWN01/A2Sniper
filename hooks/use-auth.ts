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

    // Liste des pages publiques
    const publicPages = ['/', '/login', '/signup', '/pricing', '/legal'];
    
    if (!isAuthenticated && !publicPages.includes(pathname)) {
      router.push('/login');
    }

    if (requireAdmin && user && !user.is_admin) {
      router.push('/dashboard');
    }
  }, [isAuthenticated, user, isInitialized, pathname, router, requireAdmin]);

  return { isAuthenticated, user };
}
