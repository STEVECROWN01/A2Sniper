import { create } from 'zustand';
import { Signal, mockSignals, mockUserStats, UserStats } from './mock-data';
import { getApiUrl } from './api-config';

// ============================================================================
// SECURITY: Auth tokens are now stored in httpOnly cookies
// ============================================================================
// The JWT tokens are set as httpOnly cookies by the Next.js API proxy,
// so they are NOT accessible via JavaScript (XSS protection).
//
// The browser automatically sends the cookies with /api/* requests.
// The proxy reads the cookies and adds the Authorization header for the backend.
//
// For frontend auth state, we check /api/auth/me to verify the session.
// ============================================================================

interface SubscriptionPlan {
  name: string;
  maxSignalsPerDay: number;
  canAccessAPI: boolean;
  canBacktest: boolean;
  canRequestSignal: boolean;
  maxSignalRequestsPerHour: number;
}

const PLAN_LIMITS: Record<string, SubscriptionPlan> = {
  Standard: {
    name: 'Standard',
    maxSignalsPerDay: 20,
    canAccessAPI: false,
    canBacktest: false,
    canRequestSignal: true,
    maxSignalRequestsPerHour: 3,
  },
  Premium: {
    name: 'Premium',
    maxSignalsPerDay: 35,
    canAccessAPI: false,
    canBacktest: true,
    canRequestSignal: true,
    maxSignalRequestsPerHour: 10,
  },
  Pro: {
    name: 'Pro',
    maxSignalsPerDay: Infinity,
    canAccessAPI: true,
    canBacktest: true,
    canRequestSignal: true,
    maxSignalRequestsPerHour: Infinity,
  },
};

// Default plan for unauthenticated users
const DEFAULT_PLAN: SubscriptionPlan = {
  name: 'Free',
  maxSignalsPerDay: 100,  // Allow signal requests on Free plan (was 5)
  canAccessAPI: false,
  canBacktest: false,
  canRequestSignal: true,  // Allow signal requests on Free plan (was false)
  maxSignalRequestsPerHour: 50,
};

interface AppState {
  signals: Signal[];
  // Aggregate counts from backend — accurate regardless of pagination limit.
  // The frontend `signals[]` array is capped (default 200) for performance,
  // but these totals reflect the true DB state. Use these for stat cards.
  totalSignals: number;
  totalActive: number;
  totalWon: number;
  totalLost: number;
  resetTimestamp: number | null; // When user clicks reset, signals older than this are hidden
  userStats: UserStats;
  selectedPairs: string[];
  isAuthenticated: boolean;
  user: {
    id: string;
    email: string;
    name: string;
    avatar?: string;
    notification_sound?: string;
    is_admin?: boolean;
    plan?: string;
    auth_provider?: string;
  } | null;
  liveStatus: 'LIVE' | 'DISCONNECTED';
  marketInfo: {
    isConnected: boolean;
    // Only includes pairs that are ACTIVE on PO AND have payout ≥ 70%.
    // Inactive pairs and pairs below the threshold are EXCLUDED entirely
    // (backend filters them out — frontend never sees them).
    payouts: Record<string, number>;
    pair_status?: Record<string, { payout: number; is_active: boolean; display: string }>;
    all_otc_pairs?: Record<string, number>;
    // Account balance from PO — already filtered by is_demo on the backend,
    // so this is the balance for the account type the user is actually
    // connected to (real if is_demo=false, demo if is_demo=true).
    account_balance?: number | null;
    is_demo?: boolean;
    balance_source?: string | null;
    balance_last_updated?: string | null;
    balance_event_is_demo?: boolean | null;
  } | null;
  isInitialized: boolean;
  clockOffset: number;
  // SSID is now server-side only — the frontend never stores it. We track
  // only a boolean indicating whether the server has a saved SSID (for the
  // "Reconnect" button). The SSID value itself never enters the browser.
  hasSavedSsid: boolean;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  lastConnectTime: number;

  // Actions
  setSignals: (signals: Signal[]) => void;
  updateUserStats: (stats: UserStats) => void;
  togglePair: (pair: string) => void;
  setAuthenticated: (auth: boolean) => void;
  setUser: (user: AppState['user']) => void;
  addSignal: (signal: Signal) => void;
  updateSignalStatus: (id: string, status: Signal['status'], result?: { result_price: number; profit_loss: number }) => void;
  fetchSignals: () => Promise<void>;
  fetchPerformance: () => Promise<void>;
  connectMarket: (ssid: string) => Promise<{ success: boolean; message: string }>;
  connectWithSaved: () => Promise<{ success: boolean; message: string }>;
  disconnectMarket: () => Promise<void>;
  fetchMarketStatus: () => Promise<void>;
  fetchSsidStatus: () => Promise<void>;
  initialize: () => Promise<void>;
  logout: () => Promise<void>;
  requestSignal: (pair: string) => Promise<{ success: boolean; signal?: Signal; message?: string }>;
  checkPlanLimit: (action: string) => { allowed: boolean; reason?: string };
  getAuthHeaders: () => Record<string, string>;
  getApiUrl: () => string;
}

export const useAppStore = create<AppState>((set, get) => ({
  signals: mockSignals,
  totalSignals: 0,
  totalActive: 0,
  totalWon: 0,
  totalLost: 0,
  resetTimestamp: null,
  userStats: mockUserStats,
  selectedPairs: ['EUR/USD OTC', 'GBP/USD OTC', 'USD/JPY OTC'],
  isAuthenticated: false,
  user: null,
  liveStatus: 'DISCONNECTED',
  marketInfo: null,
  isInitialized: false,
  clockOffset: 0,
  hasSavedSsid: false,
  reconnectAttempts: 0,
  maxReconnectAttempts: 5,  // Lowered from 10 to 5 — stop the endless loop faster
  lastConnectTime: 0 as number,  // timestamp of last successful connect (for stability check)
  
  setSignals: (signals) => set({ signals }),
  
  updateUserStats: (stats) => set({ userStats: stats }),
  
  togglePair: (pair) => set((state) => ({
    selectedPairs: state.selectedPairs.includes(pair)
      ? state.selectedPairs.filter(p => p !== pair)
      : [...state.selectedPairs, pair]
  })),
  
  setAuthenticated: (auth) => set({ isAuthenticated: auth }),
  
  setUser: (user) => {
    set({ user });
    // Keep localStorage cache in sync so the profile appears instantly on reload
    if (typeof window !== 'undefined') {
      try {
        if (user) {
          localStorage.setItem('a2sniper_cached_user', JSON.stringify(user));
        } else {
          localStorage.removeItem('a2sniper_cached_user');
        }
      } catch { /* ignore quota errors */ }
    }
  },
  
  addSignal: (signal) => set((state) => ({
    signals: [signal, ...state.signals]
  })),
  
  updateSignalStatus: (id, status, result) => set((state) => ({
    signals: state.signals.map(signal => 
      signal.id === id 
        ? { ...signal, status, ...result }
        : signal
    )
  })),

  // Helper to get auth headers — cookies are sent automatically, but we include
  // Content-Type. The proxy adds Authorization from cookies.
  getAuthHeaders: () => {
    return { 'Content-Type': 'application/json' };
  },

  // Helper to get API base URL (uses shared config)
  getApiUrl: () => getApiUrl(),

  // Reconnect using the server-side saved SSID — no SSID transits the browser.
  // The server reads its encrypted last_ssid.txt and reconnects.
  connectWithSaved: async () => {
    try {
      const url = get().getApiUrl();
      const res = await fetch(`${url}/api/market/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ use_saved: true })
      });
      const data = await res.json();
      if (res.ok) {
        set({ liveStatus: 'LIVE' });
        await get().fetchMarketStatus();
        return { success: true, message: data.message };
      }
      return { success: false, message: data.detail || 'Reconnection failed — no saved SSID on server.' };
    } catch {
      return { success: false, message: 'Network error — verify that the backend server is running.' };
    }
  },

  // Check if the current user's plan allows the requested action
  checkPlanLimit: (action: string): { allowed: boolean; reason?: string } => {
    const user = get().user;

    // Admin bypass: admins can do everything, no limits
    if (user?.is_admin) {
      return { allowed: true };
    }

    const planName = user?.plan || 'Free';
    const plan = PLAN_LIMITS[planName] || DEFAULT_PLAN;

    switch (action) {
      case 'requestSignal': {
        if (!plan.canRequestSignal) {
          return { allowed: false, reason: `The ${plan.name} plan does not allow signal requests. Upgrade to Standard or higher.` };
        }
        return { allowed: true };
      }
      case 'accessAPI': {
        if (!plan.canAccessAPI) {
          return { allowed: false, reason: `API access requires the Pro plan.` };
        }
        return { allowed: true };
      }
      case 'backtest': {
        if (!plan.canBacktest) {
          return { allowed: false, reason: `Backtesting requires the Premium or Pro plan.` };
        }
        return { allowed: true };
      }
      case 'signalsPerDay': {
        const todaySignals = get().signals.filter(s => {
          const today = new Date();
          const signalDate = new Date(s.timestamp);
          return signalDate.toDateString() === today.toDateString();
        }).length;
        if (todaySignals >= plan.maxSignalsPerDay) {
          return { allowed: false, reason: `Limite quotidienne atteinte (${plan.maxSignalsPerDay} signaux/jour pour le plan ${plan.name}).` };
        }
        return { allowed: true };
      }
      default:
        return { allowed: true };
    }
  },

  fetchSignals: async () => {
    try {
      const url = get().getApiUrl();
      const startTime = Date.now();
      // Request the 100 most-recent signals — enough for the signals page grid
      // + the current session's 10 trade-dot visualization. Aggregate counts
      // (total/won/lost/active) come separately from the backend, so stat
      // cards stay accurate regardless of this limit. Was 500 — too heavy
      // for 1-5s polling, caused event-loop contention.
      const res = await fetch(`${url}/api/signals?limit=100`, { credentials: 'include' });
      if (res.ok) {
        // Calculate clock offset from HTTP Date header
        const serverDateStr = res.headers.get('Date');
        if (serverDateStr) {
          const serverTime = new Date(serverDateStr).getTime();
          const rtt = Date.now() - startTime;
          const adjustedServerTime = serverTime + rtt / 2;
          const offset = adjustedServerTime - Date.now();
          set({ clockOffset: offset });
        }

        const data = await res.json();
        const allParsedSignals = (data.signals || []).map((s: Record<string, unknown>) => {
          let tsStr = s.timestamp as string | undefined;
          if (tsStr && !tsStr.endsWith('Z') && !tsStr.includes('+')) {
            tsStr = tsStr + 'Z';
          }
          return {
            ...s,
            // Use status from backend if available, otherwise compute
            status: (s.status as string) || (s.is_win === true ? 'WON' : s.is_win === false ? 'LOST' : 'ACTIVE'),
            timestamp: new Date(tsStr || Date.now()),
            // Ensure analysis fields are never undefined — descriptive fallbacks
            smc_structure: (s.smc_structure as string) || 'Price Action',
            smc_zone: (s.smc_zone as string) || 'Momentum Zone',
            chart_pattern: (s.chart_pattern as string) || 'Momentum Continuation',
            fibonacci: (s.fibonacci as string) || 'Trend Aligned',
            rsi_status: (s.rsi_status as string) || 'Neutral',
          } as Signal;
        });

        // Filter: only show signals newer than the reset timestamp.
        // This makes the reset button persistent across 5s polling cycles.
        const resetTs = get().resetTimestamp;
        const parsedSignals = resetTs
          ? allParsedSignals.filter((s: Signal) => s.timestamp.getTime() > resetTs)
          : allParsedSignals;

        // Recalculate counts from the filtered list (ignore backend totals
        // when reset is active — they include pre-reset signals)
        const displayActive = parsedSignals.filter((s: Signal) => s.status === 'ACTIVE').length;
        const displayWon = parsedSignals.filter((s: Signal) => s.status === 'WON').length;
        const displayLost = parsedSignals.filter((s: Signal) => s.status === 'LOST').length;

        // ─── NEW SIGNAL DETECTION + SOUND NOTIFICATION ──────────────
        // If so, play the user's selected notification sound.
        // This fires when the page is open and the backend emits a new signal.
        // (When the page is closed, the service worker handles it via Web Push.)
        const currentSignals = get().signals;
        if (currentSignals.length > 0 && parsedSignals.length > 0) {
          const currentIds = new Set(currentSignals.map((s: Signal) => s.id));
          const newSignals = parsedSignals.filter((s: Signal) => !currentIds.has(s.id));
          if (newSignals.length > 0) {
            // New signal(s) detected — play sound
            const sound = typeof window !== 'undefined'
              ? localStorage.getItem('a2sniper_notification_sound') || 'bell'
              : 'bell';
            if (sound !== 'none' && sound !== 'disabled') {
              try {
                const { playNotificationSound } = await import('@/lib/notifications');
                playNotificationSound(sound);
              } catch {
                // notifications module not loaded yet — skip sound
              }
            }
          }
        }

        set({
          signals: parsedSignals,
          // If reset is active, use filtered counts. Otherwise use backend totals.
          totalSignals: resetTs ? parsedSignals.length : (typeof data.total === 'number' ? data.total : parsedSignals.length),
          totalActive: resetTs ? displayActive : (typeof data.active_count === 'number' ? data.active_count : 0),
          totalWon: resetTs ? displayWon : (typeof data.won_count === 'number' ? data.won_count : 0),
          totalLost: resetTs ? displayLost : (typeof data.lost_count === 'number' ? data.lost_count : 0),
          liveStatus: data.live_status || 'DISCONNECTED'
        });
      }
    } catch (err) {
      console.error('Failed to fetch signals', err);
    }
  },

  fetchPerformance: async () => {
    try {
      const url = get().getApiUrl();
      const res = await fetch(`${url}/api/performance`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const globalWinRate = data.win_rate_all?.win_rate ?? 0;
        const totalTrades = data.win_rate_all?.total ?? 0;
        set((state) => ({
          userStats: {
            ...state.userStats,
            winRate: parseFloat(String(globalWinRate)),
            totalTrades,
            todaySignals: data.signals_today ?? 0,
            performance: totalTrades > 0 ? parseFloat(String(globalWinRate)) : 0,
          }
        }));
      }
    } catch (err) {
      console.error('Failed to fetch performance', err);
    }
  },

  connectMarket: async (ssid: string) => {
    try {
      const url = get().getApiUrl();
      const res = await fetch(`${url}/api/market/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ssid })
      });
      const data = await res.json();
      if (res.ok) {
        // SECURITY: do NOT store the SSID in localStorage or Zustand state.
        // The server has persisted it (encrypted at rest). Future reconnects
        // use connectWithSaved() which POSTs {use_saved: true} — the SSID
        // never transits the browser again.
        set({ liveStatus: 'LIVE', hasSavedSsid: true });
        await get().fetchMarketStatus();
        return { success: true, message: data.message };
      }
      return { success: false, message: data.detail || 'Erreur de connexion' };
    } catch (err) {
      return { success: false, message: 'Network error — verify that the backend server is running on port 8000.' };
    }
  },

  fetchSsidStatus: async () => {
    try {
      const url = get().getApiUrl();
      const res = await fetch(`${url}/api/market/ssid-status`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        set({ hasSavedSsid: data.has_saved_ssid === true });
      }
    } catch {
      // Silent fail — the reconnect button just won't show if status can't be fetched.
    }
  },

  requestSignal: async (pair: string) => {
    // Check plan limits before requesting
    const limitCheck = get().checkPlanLimit('requestSignal');
    if (!limitCheck.allowed) {
      return { success: false, message: limitCheck.reason };
    }

    const dailyLimitCheck = get().checkPlanLimit('signalsPerDay');
    if (!dailyLimitCheck.allowed) {
      return { success: false, message: dailyLimitCheck.reason };
    }

    try {
      const url = get().getApiUrl();
      const res = await fetch(`${url}/api/signals/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pair })
      });
      // Handle non-JSON responses gracefully (e.g., "Internal Server Error" plain text)
      const responseText = await res.text();
      let data: any;
      try {
        data = JSON.parse(responseText);
      } catch {
        // Backend returned plain text (likely a 500 error)
        if (!res.ok) {
          return { success: false, message: `Server error (${res.status}). The analysis engine could not generate a signal for ${pair}. Please try again in a few seconds.` };
        }
        return { success: false, message: 'Invalid response from server. Please try again.' };
      }
      if (res.ok) {
        let tsStr = data.signal.timestamp;
        if (tsStr && !tsStr.endsWith('Z') && !tsStr.includes('+')) {
          tsStr = tsStr + 'Z';
        }
        const parsedSignal = {
          ...data.signal,
          status: data.signal.is_win === true ? 'WON' : data.signal.is_win === false ? 'LOST' : 'ACTIVE',
          timestamp: new Date(tsStr),
          // Ensure analysis fields are never undefined — use descriptive fallbacks
          smc_structure: data.signal.smc_structure || 'Price Action',
          smc_zone: data.signal.smc_zone || 'Momentum Zone',
          chart_pattern: data.signal.chart_pattern || 'Momentum Continuation',
          fibonacci: data.signal.fibonacci || 'Trend Aligned',
          rsi_status: data.signal.rsi_status || 'Neutral',
        };
        set((state) => ({
          signals: [parsedSignal, ...state.signals.filter(s => s.id !== parsedSignal.id)]
        }));
        return { success: true, signal: parsedSignal };
      }
      // Backend returned an error — extract the detail message
      // FastAPI's HTTPException detail can be: string, array of objects, or object
      // We need to extract a clean string, never [object Object]
      let errMsg = '';
      if (typeof data.detail === 'string') {
        errMsg = data.detail;
      } else if (Array.isArray(data.detail)) {
        // Validation errors: extract the msg from each item
        errMsg = data.detail.map((e: any) => e?.msg || String(e)).join('; ');
      } else if (data.detail && typeof data.detail === 'object') {
        errMsg = data.detail.msg || data.detail.message || JSON.stringify(data.detail);
      } else if (typeof data.message === 'string') {
        errMsg = data.message;
      } else if (typeof data.error === 'string') {
        errMsg = data.error;
      } else {
        errMsg = `Erreur HTTP ${res.status}`;
      }
      return { success: false, message: errMsg };
    } catch (err) {
      // Network error — extract message safely (avoid [object Object])
      const netErr = err instanceof Error ? err.message : 'Network error';
      return { success: false, message: netErr };
    }
  },

  disconnectMarket: async () => {
    try {
      const url = get().getApiUrl();
      await fetch(`${url}/api/market/disconnect`, { 
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      set({ liveStatus: 'DISCONNECTED', marketInfo: null });
    } catch (err) {
      console.error('Failed to disconnect market', err);
    }
  },

  fetchMarketStatus: async () => {
    try {
      const url = get().getApiUrl();
      const res = await fetch(`${url}/api/market/status`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const wasLive = get().liveStatus === 'LIVE';
        const isNowLive = data.is_connected;

        // Backend now only returns ACTIVE pairs with payout ≥ 70%.
        // - data.payouts: default OTC pairs that meet the criteria
        // - data.all_otc_pairs: ALL OTC pairs that meet the criteria (active + ≥70%)
        // - data.pair_status: per-default-pair info (only active + ≥70% pairs included)
        // Inactive pairs and pairs with payout < 70% are EXCLUDED entirely —
        // the frontend never sees them.
        const defaultPayouts: Record<string, number> = data.payouts || {};
        const allOtcPairs: Record<string, number> = data.all_otc_pairs || {};
        const pairStatus: Record<string, { payout: number; is_active: boolean; display: string }> =
          data.pair_status || {};

        // Merge — all_otc_pairs values take priority (they include all live pairs)
        const mergedPayouts: Record<string, number> = { ...defaultPayouts };
        for (const [pair, payout] of Object.entries(allOtcPairs)) {
          mergedPayouts[pair] = payout;
        }

        set({
          liveStatus: isNowLive ? 'LIVE' : 'DISCONNECTED',
          marketInfo: {
            isConnected: isNowLive,
            payouts: mergedPayouts,
            pair_status: pairStatus,
            all_otc_pairs: allOtcPairs,
            account_balance: data.account_balance ?? null,
            is_demo: data.is_demo,
            balance_source: data.balance_source ?? null,
            balance_last_updated: data.balance_last_updated ?? null,
            balance_event_is_demo: data.balance_event_is_demo ?? null,
          }
        });

        // Cache market status for instant display on next reload
        // (prevents the "DISCONNECTED" flash on page refresh)
        if (typeof window !== 'undefined') {
          try {
            localStorage.setItem('a2sniper_cached_market', JSON.stringify({
              liveStatus: isNowLive ? 'LIVE' : 'DISCONNECTED',
              marketInfo: {
                isConnected: isNowLive,
                payouts: mergedPayouts,
                pair_status: pairStatus,
                all_otc_pairs: allOtcPairs,
                account_balance: data.account_balance ?? null,
                is_demo: data.is_demo,
                balance_source: data.balance_source ?? null,
                balance_last_updated: data.balance_last_updated ?? null,
                balance_event_is_demo: data.balance_event_is_demo ?? null,
              },
              timestamp: Date.now(),
            }));
          } catch { /* ignore quota errors */ }
        }

        // NO auto-reconnect — connection ONLY happens on user's explicit click.
        // If the connection drops, the user must manually click "Connect" again.
      }
    } catch (err) {
      console.error('Failed to fetch market status', err);
    }
  },

  initialize: async () => {
    // ─── INSTANT DISPLAY: load cached user from localStorage ────────────
    // This makes the profile picture + name appear INSTANTLY on page reload,
    // before the /api/auth/me response arrives (which can take 500ms-2s).
    // The cached user is overwritten with fresh data once /me returns.
    if (typeof window !== 'undefined') {
      try {
        const cachedUser = localStorage.getItem('a2sniper_cached_user');
        if (cachedUser) {
          const parsed = JSON.parse(cachedUser);
          set({ user: parsed, isAuthenticated: true });
        }
      } catch { /* ignore parse errors */ }

      // ─── INSTANT DISPLAY: load cached market status ───────────────────
      // Prevents the "DISCONNECTED" flash on page refresh. The cached status
      // appears immediately, then gets refreshed when fetchMarketStatus returns.
      try {
        const cachedMarket = localStorage.getItem('a2sniper_cached_market');
        if (cachedMarket) {
          const parsed = JSON.parse(cachedMarket);
          // Only use cache if it's less than 5 minutes old (connection state
          // can change, so stale cache shouldn't persist too long)
          if (parsed.timestamp && (Date.now() - parsed.timestamp) < 5 * 60 * 1000) {
            set({
              liveStatus: parsed.liveStatus || 'DISCONNECTED',
              marketInfo: parsed.marketInfo || null,
            });
          }
        }
      } catch { /* ignore parse errors */ }
    }

    // Check auth via httpOnly cookie — call /api/auth/me
    // The browser sends the cookie automatically with credentials: 'include'
    try {
      const url = get().getApiUrl();
      const res = await fetch(`${url}/api/auth/me`, { credentials: 'include' });
      if (res.ok) {
        const user = await res.json();
        set({ user, isAuthenticated: true, isInitialized: true });

        // Cache user data for instant display on next reload
        if (typeof window !== 'undefined') {
          try {
            localStorage.setItem('a2sniper_cached_user', JSON.stringify(user));
          } catch { /* ignore quota errors */ }
        }

        // Fire ALL 3 fetches in PARALLEL (was sequential — each awaited
        // before the next started, tripling load time). Now they run
        // concurrently, and we don't block isInitialized on them.
        Promise.allSettled([
          get().fetchSignals(),
          get().fetchPerformance(),
          get().fetchMarketStatus(),
        ]).catch(() => { /* errors handled in each fetch */ });

        // Check whether the server has a saved SSID (for the reconnect button).
        // The SSID value itself is never sent to the browser — only this boolean.
        get().fetchSsidStatus();
        return;
      }
      // If /api/auth/me returns 401, user is not authenticated — clear cached user
      if (typeof window !== 'undefined') {
        localStorage.removeItem('a2sniper_cached_user');
      }
      // If we had a cached user from localStorage but /me returned non-OK,
      // clear the stale user from state
      if (get().user) {
        set({ user: null, isAuthenticated: false });
      }
    } catch (err) {
      console.error('Initialization failed', err);
    }
    set({ isInitialized: true });
  },

  logout: async () => {
    try {
      const url = get().getApiUrl();
      // Call backend logout to revoke tokens — cookies are sent automatically
      await fetch(`${url}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('Logout API call failed', err);
    }
    // Clear frontend state + cached user
    set({ user: null, isAuthenticated: false });
    if (typeof window !== 'undefined') {
      localStorage.removeItem('a2sniper_cached_user');
    }
  }
}));

// Export plan limits for use in components
export { PLAN_LIMITS, DEFAULT_PLAN };
export type { SubscriptionPlan };
