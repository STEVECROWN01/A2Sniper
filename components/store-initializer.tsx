'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/lib/store';

export function StoreInitializer() {
  const initialize = useAppStore((state) => state.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  return null;
}

