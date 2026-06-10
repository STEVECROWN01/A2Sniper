'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Settings, Shield, Power, Bell, Globe, Lock, Cpu, Save } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';

export default function AdminSettingsPage() {
  useAuth(true);
  const [isSuspended, setIsSuspended] = useState(false);
  const [config, setConfig] = useState({
    maintenanceMode: false,
    publicAccess: true,
    telegramNotifications: true,
    ipWhitelist: '127.0.0.1, 192.168.1.1',
    maxDrawdown: 15,
    apiRateLimit: 100
  });

  const fetchStatus = async () => {
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const res = await fetch(`${url}/api/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        setIsSuspended(data.status === 'suspended');
      }
    } catch (err) {
      console.error("Failed to fetch system status");
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleCircuitBreaker = async () => {
    const nextState = !isSuspended;
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const res = await fetch(`${url}/api/admin/circuit-breaker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ active: nextState })
      });
      if (res.ok) {
        setIsSuspended(nextState);
        toast.warning(`Circuit Breaker ${nextState ? 'ACTIVATED' : 'DEACTIVATED'}`);
      }
    } catch (err) {
      toast.error("Failed to toggle circuit breaker.");
    }
  };

  const saveConfig = async () => {
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const res = await fetch(`${url}/api/admin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(config)
      });
      if (res.ok) {
        toast.success("System configuration saved successfully.");
      } else {
        toast.error("Failed to save configuration.");
      }
    } catch (err) {
      toast.error("Failed to save configuration.");
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold uppercase tracking-tighter">Master Configuration</h1>
        <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">Core System Parameters</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          {/* Security & Access */}
          <div className="bg-gray-900/40 border border-gray-800 p-8 rounded-2xl backdrop-blur-sm">
            <div className="flex items-center gap-3 mb-8">
              <Shield className="w-5 h-5 text-blue-500" />
              <h2 className="text-lg font-bold">Security & Access</h2>
            </div>

            <div className="space-y-6">
              <div className="flex items-center justify-between p-4 bg-black/20 rounded-xl border border-gray-800">
                <div>
                  <h3 className="text-sm font-bold">Maintenance Mode</h3>
                  <p className="text-xs text-gray-500">Block all public user access during updates.</p>
                </div>
                <button 
                  onClick={() => setConfig({...config, maintenanceMode: !config.maintenanceMode})}
                  className={`w-12 h-6 rounded-full transition-colors relative ${config.maintenanceMode ? 'bg-red-600' : 'bg-gray-800'}`}
                >
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${config.maintenanceMode ? 'left-7' : 'left-1'}`} />
                </button>
              </div>

              <div className="flex items-center justify-between p-4 bg-black/20 rounded-xl border border-gray-800">
                <div>
                  <h3 className="text-sm font-bold">Public Signal Feed</h3>
                  <p className="text-xs text-gray-500">Disable live stream on the public website.</p>
                </div>
                <button 
                  onClick={() => setConfig({...config, publicAccess: !config.publicAccess})}
                  className={`w-12 h-6 rounded-full transition-colors relative ${config.publicAccess ? 'bg-green-600' : 'bg-gray-800'}`}
                >
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${config.publicAccess ? 'left-7' : 'left-1'}`} />
                </button>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Admin IP Whitelist</label>
                <input 
                  type="text" 
                  value={config.ipWhitelist}
                  onChange={(e) => setConfig({...config, ipWhitelist: e.target.value})}
                  className="w-full bg-gray-900 border border-gray-800 p-3 rounded-xl text-sm focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
            </div>
          </div>

          {/* Engine Parameters */}
          <div className="bg-gray-900/40 border border-gray-800 p-8 rounded-2xl backdrop-blur-sm">
            <div className="flex items-center gap-3 mb-8">
              <Cpu className="w-5 h-5 text-purple-500" />
              <h2 className="text-lg font-bold">Risk Management</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Max Account Drawdown (%)</label>
                <input 
                  type="number" 
                  value={config.maxDrawdown}
                  onChange={(e) => setConfig({...config, maxDrawdown: parseInt(e.target.value)})}
                  className="w-full bg-gray-900 border border-gray-800 p-3 rounded-xl text-sm focus:outline-none focus:border-purple-500"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">API Rate Limit (req/hr)</label>
                <input 
                  type="number" 
                  value={config.apiRateLimit}
                  onChange={(e) => setConfig({...config, apiRateLimit: parseInt(e.target.value)})}
                  className="w-full bg-gray-900 border border-gray-800 p-3 rounded-xl text-sm focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-8">
          {/* Circuit Breaker UI (Sync with Header) */}
          <div className={`p-8 rounded-2xl border transition-all duration-500 ${
            isSuspended ? 'bg-red-600/10 border-red-600' : 'bg-gray-900/40 border-gray-800'
          }`}>
            <h2 className="text-lg font-bold uppercase tracking-tighter mb-4">Emergency Control</h2>
            <p className="text-xs text-gray-500 mb-8">Kill-switch for all signal distribution engines.</p>
            <button 
              onClick={handleCircuitBreaker}
              className={`w-full py-4 rounded-xl flex items-center justify-center gap-3 font-bold text-sm transition-all ${
                isSuspended ? 'bg-white text-red-600' : 'bg-red-600 text-white'
              }`}
            >
              <Power className="w-4 h-4" />
              {isSuspended ? 'REACTIVATE SYSTEM' : 'SHUTDOWN SYSTEM'}
            </button>
          </div>

          <button 
            onClick={saveConfig}
            className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold flex items-center justify-center gap-3 transition-all"
          >
            <Save className="w-5 h-5" />
            SAVE MASTER CONFIG
          </button>
        </div>
      </div>
    </div>
  );
}
