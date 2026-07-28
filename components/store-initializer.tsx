'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import { registerServiceWorker, listenForPushSignals, playNotificationSound } from '@/lib/notifications';

export function StoreInitializer() {
  const initialize = useAppStore((state) => state.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Register service worker + listen for push signals
  useEffect(() => {
    // Register the service worker for push notifications
    registerServiceWorker();

    // Get the user's selected sound (from localStorage — set in Settings page)
    const getSound = () => {
      if (typeof window === 'undefined') return 'bell';
      return localStorage.getItem('a2sniper_notification_sound') || 'bell';
    };

    // Listen for push messages forwarded by the service worker.
    // When a push arrives, play the selected sound.
    // The sound is read fresh each time so changes in Settings take effect immediately.
    const unsubscribe = listenForPushSignals('bell', (data) => {
      // Read the latest sound setting
      const sound = getSound();
      playNotificationSound(sound);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return null;
}
