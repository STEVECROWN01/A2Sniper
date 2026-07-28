/**
 * A2Sniper Notification System
 *
 * Features:
 * 1. Sound generation via Web Audio API (no sound files needed)
 *    - bell, chime, alert, coin, digital, none
 * 2. Web Push subscription management
 *    - subscribe() requests permission, creates push subscription, sends to backend
 *    - unsubscribe() removes the subscription from the backend
 * 3. Sound playback when a new signal arrives (via polling or push)
 *
 * The service worker (public/sw.js) handles push notifications when the
 * browser tab is closed. When a push arrives, the SW forwards it to open
 * tabs via postMessage — this module listens for those messages and plays
 * the selected sound.
 */

import { getApiUrl } from './api-config';

// ═══════════ SOUND GENERATION (Web Audio API) ═══════════

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

/**
 * Play a single tone with given frequency, duration, and type.
 */
function playTone(ctx: AudioContext, freq: number, duration: number, type: OscillatorType = 'sine', startTime: number = 0, volume: number = 0.3): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.value = freq;

  const t = ctx.currentTime + startTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(t);
  osc.stop(t + duration);
}

/**
 * Play the selected notification sound.
 * Sounds are generated via Web Audio API — no audio files needed.
 *
 * @param sound The sound name: bell, chime, alert, coin, digital, none
 */
export function playNotificationSound(sound: string): void {
  if (sound === 'none') return;

  const ctx = getAudioContext();
  if (!ctx) return;

  // Resume context if suspended (browsers require user interaction first)
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  switch (sound) {
    case 'bell':
      // Classic bell: 880Hz sine with long decay
      playTone(ctx, 880, 0.8, 'sine', 0, 0.4);
      playTone(ctx, 1320, 0.6, 'sine', 0.05, 0.2); // harmonic
      break;

    case 'chime':
      // Ascending chime: C5 → E5 → G5
      playTone(ctx, 523.25, 0.3, 'sine', 0, 0.3);     // C5
      playTone(ctx, 659.25, 0.3, 'sine', 0.15, 0.3);  // E5
      playTone(ctx, 783.99, 0.5, 'sine', 0.30, 0.3);  // G5
      break;

    case 'alert':
      // Urgent triple beep
      playTone(ctx, 1000, 0.12, 'square', 0, 0.25);
      playTone(ctx, 1000, 0.12, 'square', 0.18, 0.25);
      playTone(ctx, 1000, 0.12, 'square', 0.36, 0.25);
      break;

    case 'coin':
      // Classic coin sound: two quick high tones
      playTone(ctx, 988, 0.08, 'square', 0, 0.3);     // B5
      playTone(ctx, 1319, 0.25, 'square', 0.07, 0.3); // E6
      break;

    case 'digital':
      // Electronic beep
      playTone(ctx, 1200, 0.15, 'sawtooth', 0, 0.2);
      playTone(ctx, 800, 0.15, 'sawtooth', 0.12, 0.2);
      break;

    default:
      // Fallback: simple beep
      playTone(ctx, 880, 0.3, 'sine', 0, 0.3);
  }
}

// ═══════════ PUSH SUBSCRIPTION MANAGEMENT ═══════════

/**
 * Convert a base64 string to Uint8Array (needed for VAPID key).
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = typeof window !== 'undefined' ? window.atob(base64) : Buffer.from(base64, 'base64').toString('binary');
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

/**
 * Register the service worker. Called once on app load.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return reg;
  } catch (err) {
    return null;
  }
}

/**
 * Subscribe to web push notifications.
 * 1. Requests notification permission
 * 2. Creates a push subscription using the VAPID public key
 * 3. Sends the subscription to the backend for storage
 *
 * Returns true if subscription was successful, false otherwise.
 */
export async function subscribeToPushNotifications(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return false;
  }

  try {
    // Step 1: Request notification permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return false;
    }

    // Step 2: Get the service worker registration
    const reg = await navigator.serviceWorker.ready;

    // Step 3: Fetch the VAPID public key from the backend
    const apiUrl = getApiUrl();
    const keyRes = await fetch(`${apiUrl}/api/notifications/vapid-public-key`, {
      credentials: 'include',
    });
    if (!keyRes.ok) return false;
    const { public_key } = await keyRes.json();
    if (!public_key) return false;

    // Step 4: Check if already subscribed
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      // Create new subscription
      const applicationServerKey = urlBase64ToUint8Array(public_key);
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }

    // Step 5: Send subscription to backend
    const subRes = await fetch(`${apiUrl}/api/notifications/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(subscription),
    });

    return subRes.ok;
  } catch (err) {
    return false;
  }
}

/**
 * Unsubscribe from web push notifications.
 * Removes the subscription from both the browser and the backend.
 */
export async function unsubscribeFromPushNotifications(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return true;

    // Remove from backend
    const apiUrl = getApiUrl();
    await fetch(`${apiUrl}/api/notifications/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });

    // Remove from browser
    await subscription.unsubscribe();
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Check if the user is currently subscribed to push notifications.
 */
export async function isSubscribedToPush(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    return !!subscription;
  } catch {
    return false;
  }
}

/**
 * Check if notifications are supported in this browser.
 */
export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
}

/**
 * Check if notification permission is granted.
 */
export function notificationPermissionGranted(): boolean {
  return typeof window !== 'undefined' &&
    'Notification' in window &&
    Notification.permission === 'granted';
}

// ═══════════ PUSH MESSAGE LISTENER ═══════════

/**
 * Listen for push messages forwarded by the service worker.
 * When a push arrives, play the selected notification sound.
 *
 * @param sound The user's selected notification sound
 * @param onSignal Optional callback fired when a push signal arrives
 */
export function listenForPushSignals(
  sound: string,
  onSignal?: (data: any) => void
): () => void {
  if (typeof window === 'undefined' || !navigator.serviceWorker) {
    return () => {};
  }

  const handler = (event: MessageEvent) => {
    if (event.data && event.data.type === 'PUSH_SIGNAL') {
      // Play the selected sound
      playNotificationSound(sound);
      // Call the optional callback
      if (onSignal) {
        onSignal(event.data.data);
      }
    }
  };

  navigator.serviceWorker.addEventListener('message', handler);

  // Return an unsubscribe function
  return () => {
    navigator.serviceWorker.removeEventListener('message', handler);
  };
}
