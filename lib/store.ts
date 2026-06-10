import { create } from 'zustand';
import { Signal, mockSignals, mockUserStats, UserStats } from './mock-data';

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
  setUser: (user: any) => void;
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

  fetchSignals: async () => {
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      const startTime = Date.now();
      const res = await fetch(`${url}/api/signals`);
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
        // The backend returns { signals: [], total: 0 }
        const parsedSignals = (data.signals || []).map((s: any) => {
          let tsStr = s.timestamp;
          if (tsStr && !tsStr.endsWith('Z') && !tsStr.includes('+')) {
            tsStr = tsStr + 'Z';
          }
          return {
            ...s,
            status: s.is_win === true ? 'WON' : s.is_win === false ? 'LOST' : 'ACTIVE',
            timestamp: new Date(tsStr)
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
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      const res = await fetch(`${url}/api/performance`);
      if (res.ok) {
        const data = await res.json();
        set((state) => ({
          userStats: {
            ...state.userStats,
            winRate: parseFloat(data.win_rate),
            todaySignals: data.signals_today,
          }
        }));
      }
    } catch (err) {
      console.error('Failed to fetch performance', err);
    }
  },

  connectMarket: async (ssid: string) => {
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      const res = await fetch(`${url}/api/market/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      const res = await fetch(`${url}/api/signals/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        // Add to signals list
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
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      await fetch(`${url}/api/market/disconnect`, { method: 'POST' });
      set({ liveStatus: 'DISCONNECTED', marketInfo: null });
    } catch (err) {
      console.error('Failed to disconnect market', err);
    }
  },

  fetchMarketStatus: async () => {
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      const res = await fetch(`${url}/api/market/status`);
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
    const token = localStorage.getItem('a2sniper_token');
    if (token) {
      try {
        const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
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
          localStorage.removeItem('a2sniper_token');
        }
      } catch (err) {
        console.error('Initialization failed', err);
      }
    }
    set({ isInitialized: true });
  },

  logout: () => {
    localStorage.removeItem('a2sniper_token');
    set({ user: null, isAuthenticated: false });
  }
}));