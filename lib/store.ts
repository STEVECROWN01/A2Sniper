import { create } from 'zustand';
import { Signal, mockSignals, mockUserStats, UserStats } from './mock-data';

// ============================================================================
// SECURITY WARNING: Auth token is stored in localStorage
// ============================================================================
// This approach is vulnerable to XSS attacks. If an attacker injects malicious
// JavaScript into the application, they can read the token from localStorage.
// 
// RECOMMENDED FIX: Use httpOnly cookies set by the backend instead. The backend
// should set the JWT as an httpOnly, Secure, SameSite=Strict cookie on login.
// This would require backend changes to the auth endpoints.
//
// For now, we mitigate by:
// 1. Checking token expiry before using it
// 2. Clearing expired tokens automatically
// 3. Not storing sensitive user data alongside the token
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
  maxSignalsPerDay: 5,
  canAccessAPI: false,
  canBacktest: false,
  canRequestSignal: false,
  maxSignalRequestsPerHour: 0,
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
  } | null;
  liveStatus: 'LIVE' | 'DISCONNECTED';
  marketInfo: {
    isConnected: boolean;
    payouts: Record<string, number | null>;
  } | null;
  isInitialized: boolean;
  clockOffset: number;
  
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
  initialize: () => Promise<void>;
  logout: () => void;
  requestSignal: (pair: string) => Promise<{ success: boolean; signal?: Signal; message?: string }>;
  checkPlanLimit: (action: string) => { allowed: boolean; reason?: string };
  getAuthHeaders: () => Record<string, string>;
  getApiUrl: () => string;
}

// Check if a JWT token is expired
function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp) {
      // exp is in seconds since epoch
      return Date.now() >= payload.exp * 1000;
    }
    return false; // Token without exp claim — treat as valid
  } catch {
    return true; // Malformed token — treat as expired
  }
}

// Get stored token with expiry check
function getValidToken(): string | null {
  if (typeof window === 'undefined') return null;
  const token = localStorage.getItem('a2sniper_token');
  if (!token) return null;
  if (isTokenExpired(token)) {
    localStorage.removeItem('a2sniper_token');
    return null;
  }
  return token;
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

  // Helper to get auth headers — uses getValidToken() for expiry check
  getAuthHeaders: () => {
    const token = getValidToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  },

  // Helper to get API base URL
  getApiUrl: () => process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000',

  // Check if the current user's plan allows the requested action
  checkPlanLimit: (action: string): { allowed: boolean; reason?: string } => {
    const user = get().user;
    const planName = user?.plan || 'Free';
    const plan = PLAN_LIMITS[planName] || DEFAULT_PLAN;

    switch (action) {
      case 'requestSignal': {
        if (!plan.canRequestSignal) {
          return { allowed: false, reason: `Le plan ${plan.name} ne permet pas de demander des signaux. Passez au plan Standard ou supérieur.` };
        }
        return { allowed: true };
      }
      case 'accessAPI': {
        if (!plan.canAccessAPI) {
          return { allowed: false, reason: `L'accès API nécessite le plan Pro.` };
        }
        return { allowed: true };
      }
      case 'backtest': {
        if (!plan.canBacktest) {
          return { allowed: false, reason: `Le backtesting nécessite le plan Premium ou Pro.` };
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
      const headers = get().getAuthHeaders();
      // If no valid token, skip the fetch
      if (!headers['Authorization']) return;
      
      const res = await fetch(`${url}/api/signals`, { headers });
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
            status: s.is_win === true ? 'WON' : s.is_win === false ? 'LOST' : 'ACTIVE',
            timestamp: new Date(tsStr || Date.now())
          };
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
      const headers = get().getAuthHeaders();
      if (!headers['Authorization']) return;

      const res = await fetch(`${url}/api/performance`, { headers });
      if (res.ok) {
        const data = await res.json();
        // API returns nested objects: { win_rate_all: { win_rate: 75.5, total: 100, ... }, ... }
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
        headers: get().getAuthHeaders(),
        body: JSON.stringify({ ssid })
      });
      const data = await res.json();
      if (res.ok) {
        set({ liveStatus: 'LIVE' });
        await get().fetchMarketStatus();
        return { success: true, message: data.message };
      }
      return { success: false, message: data.detail || 'Erreur de connexion' };
    } catch (err) {
      return { success: false, message: 'Erreur réseau' };
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
        headers: get().getAuthHeaders(),
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
          timestamp: new Date(tsStr)
        };
        set((state) => ({
          signals: [parsedSignal, ...state.signals.filter(s => s.id !== parsedSignal.id)]
        }));
        return { success: true, signal: parsedSignal };
      }
      return { success: false, message: data.detail || 'Erreur lors de la génération du signal' };
    } catch (err) {
      return { success: false, message: 'Erreur réseau' };
    }
  },

  disconnectMarket: async () => {
    try {
      const url = get().getApiUrl();
      await fetch(`${url}/api/market/disconnect`, { 
        method: 'POST',
        headers: get().getAuthHeaders()
      });
      set({ liveStatus: 'DISCONNECTED', marketInfo: null });
    } catch (err) {
      console.error('Failed to disconnect market', err);
    }
  },

  fetchMarketStatus: async () => {
    try {
      const url = get().getApiUrl();
      const headers = get().getAuthHeaders();
      if (!headers['Authorization']) return;

      const res = await fetch(`${url}/api/market/status`, { headers });
      if (res.ok) {
        const data = await res.json();
        set({ 
          liveStatus: data.is_connected ? 'LIVE' : 'DISCONNECTED',
          marketInfo: {
            isConnected: data.is_connected,
            payouts: data.payouts
          }
        });
      }
    } catch (err) {
      console.error('Failed to fetch market status', err);
    }
  },

  initialize: async () => {
    // Use getValidToken() which checks expiry
    const token = getValidToken();
    if (token) {
      try {
        const url = get().getApiUrl();
        const res = await fetch(`${url}/api/auth/me`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const user = await res.json();
          set({ user, isAuthenticated: true, isInitialized: true });
          await get().fetchSignals();
          await get().fetchPerformance();
          await get().fetchMarketStatus();
          return;
        } else {
          // Token was rejected by server — clear it (could be revoked or expired server-side)
          localStorage.removeItem('a2sniper_token');
        }
      } catch (err) {
        console.error('Initialization failed', err);
      }
    }
    set({ isInitialized: true });
  },

  logout: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('a2sniper_token');
    }
    set({ user: null, isAuthenticated: false });
  }
}));

// Export plan limits for use in components
export { PLAN_LIMITS, DEFAULT_PLAN };
export type { SubscriptionPlan };
