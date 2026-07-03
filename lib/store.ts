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
  userStats: UserStats;
  selectedPairs: string[];
  isAuthenticated: boolean;
  user: {
    id: string;
    email: string;
    name: string;
    avatar?: string;
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
    account_balance?: number | null;
  } | null;
  isInitialized: boolean;
  clockOffset: number;
  lastConnectedSSID: string | null;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  lastConnectTime: number;
  autoConnectDone: boolean;  // Track if initial auto-connect has been attempted
  
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
  disconnectMarket: () => Promise<void>;
  fetchMarketStatus: () => Promise<void>;
  attemptReconnect: () => Promise<{ success: boolean; message: string }>;
  initialize: () => Promise<void>;
  logout: () => Promise<void>;
  requestSignal: (pair: string) => Promise<{ success: boolean; signal?: Signal; message?: string }>;
  checkPlanLimit: (action: string) => { allowed: boolean; reason?: string };
  getAuthHeaders: () => Record<string, string>;
  getApiUrl: () => string;
}

export const useAppStore = create<AppState>((set, get) => ({
  signals: mockSignals,
  userStats: mockUserStats,
  selectedPairs: ['EUR/USD OTC', 'GBP/USD OTC', 'USD/JPY OTC'],
  isAuthenticated: false,
  user: null,
  liveStatus: 'DISCONNECTED',
  marketInfo: null,
  isInitialized: false,
  clockOffset: 0,
  lastConnectedSSID: null as string | null,
  reconnectAttempts: 0,
  maxReconnectAttempts: 5,  // Lowered from 10 to 5 — stop the endless loop faster
  lastConnectTime: 0 as number,  // timestamp of last successful connect (for stability check)
  autoConnectDone: false,
  
  setSignals: (signals) => set({ signals }),
  
  updateUserStats: (stats) => set({ userStats: stats }),
  
  togglePair: (pair) => set((state) => ({
    selectedPairs: state.selectedPairs.includes(pair)
      ? state.selectedPairs.filter(p => p !== pair)
      : [...state.selectedPairs, pair]
  })),
  
  setAuthenticated: (auth) => set({ isAuthenticated: auth }),
  
  setUser: (user) => set({ user }),
  
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

  // Reconnect using saved SSID — ONLY called when user clicks the button
  attemptReconnect: async () => {
    const state = get();
    const ssid = state.lastConnectedSSID || (typeof window !== 'undefined' ? localStorage.getItem('a2sniper_last_ssid') : null);
    if (!ssid) {
      return { success: false, message: 'No saved SSID for reconnection' };
    }
    return await state.connectMarket(ssid);
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
      // Cookies are sent automatically — no need to add Authorization header
      const res = await fetch(`${url}/api/signals`, { credentials: 'include' });
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
        const parsedSignals = (data.signals || []).map((s: Record<string, unknown>) => {
          let tsStr = s.timestamp as string | undefined;
          if (tsStr && !tsStr.endsWith('Z') && !tsStr.includes('+')) {
            tsStr = tsStr + 'Z';
          }
          return {
            ...s,
            // Use status from backend if available, otherwise compute
            status: (s.status as string) || (s.is_win === true ? 'WON' : s.is_win === false ? 'LOST' : 'ACTIVE'),
            timestamp: new Date(tsStr || Date.now()),
            // Ensure analysis fields are never undefined
            smc_structure: (s.smc_structure as string) || 'Price Action',
            smc_zone: (s.smc_zone as string) || 'Active Zone',
            chart_pattern: (s.chart_pattern as string) || 'Momentum',
            fibonacci: (s.fibonacci as string) || 'Golden Zone',
            rsi_status: (s.rsi_status as string) || 'Neutral',
          } as Signal;
        });
        set({ 
          signals: parsedSignals,
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
        set({ liveStatus: 'LIVE', lastConnectedSSID: ssid });
        // Save SSID for reconnect button
        if (typeof window !== 'undefined') {
          localStorage.setItem('a2sniper_last_ssid', ssid);
        }
        await get().fetchMarketStatus();
        return { success: true, message: data.message };
      }
      return { success: false, message: data.detail || 'Erreur de connexion' };
    } catch (err) {
      return { success: false, message: 'Network error — verify that the backend server is running on port 8000.' };
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
      const data = await res.json();
      if (res.ok) {
        let tsStr = data.signal.timestamp;
        if (tsStr && !tsStr.endsWith('Z') && !tsStr.includes('+')) {
          tsStr = tsStr + 'Z';
        }
        const parsedSignal = {
          ...data.signal,
          status: data.signal.is_win === true ? 'WON' : data.signal.is_win === false ? 'LOST' : 'ACTIVE',
          timestamp: new Date(tsStr),
          // Ensure analysis fields are never undefined
          smc_structure: data.signal.smc_structure || 'Price Action',
          smc_zone: data.signal.smc_zone || 'N/A',
          chart_pattern: data.signal.chart_pattern || 'Momentum',
          fibonacci: data.signal.fibonacci || 'N/A',
          rsi_status: data.signal.rsi_status || 'N/A',
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
          }
        });

        // NO auto-reconnect — connection ONLY happens on user's explicit click.
        // If the connection drops, the user must manually click "Connect" again.
      }
    } catch (err) {
      console.error('Failed to fetch market status', err);
    }
  },

  initialize: async () => {
    // Check auth via httpOnly cookie — call /api/auth/me
    // The browser sends the cookie automatically with credentials: 'include'
    try {
      const url = get().getApiUrl();
      const res = await fetch(`${url}/api/auth/me`, { credentials: 'include' });
      if (res.ok) {
        const user = await res.json();
        set({ user, isAuthenticated: true, isInitialized: true });
        await get().fetchSignals();
        await get().fetchPerformance();
        await get().fetchMarketStatus();

        // NO auto-connect — connection ONLY happens on user's explicit click.
        // We still load the saved SSID into state so the user can quickly
        // reconnect by clicking the "Reconnect with saved SSID" button.
        const savedSSID = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_last_ssid') : null;
        if (savedSSID && !get().autoConnectDone) {
          set({ autoConnectDone: true, lastConnectedSSID: savedSSID });
        }
        return;
      }
      // If /api/auth/me returns 401, user is not authenticated — that's fine
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
    // Clear frontend state
    set({ user: null, isAuthenticated: false });
  }
}));

// Export plan limits for use in components
export { PLAN_LIMITS, DEFAULT_PLAN };
export type { SubscriptionPlan };
