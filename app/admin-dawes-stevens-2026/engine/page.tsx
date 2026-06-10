'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Brain, Activity, Save, Sliders, Info, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';

export default function AdminEnginePage() {
  useAuth(true);
  const [weights, setWeights] = useState({
    lstm: 0.4,
    transformer: 0.35,
    xgboost: 0.25,
    threshold: 0.95
  });
  const [isSaving, setIsSaving] = useState(false);

  const fetchWeights = async () => {
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const res = await fetch(`${url}/api/admin/engine/weights`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        setWeights(await res.json());
      }
    } catch (err) {
      console.error("Failed to fetch engine weights");
    }
  };

  useEffect(() => {
    fetchWeights();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const res = await fetch(`${url}/api/admin/engine/weights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(weights)
      });
      if (res.ok) {
        toast.success("AI Neural Weights updated successfully.");
      }
    } catch (err) {
      toast.error("Failed to sync neural weights.");
    } finally {
      setIsSaving(false);
    }
  };

  const totalWeight = Number(weights.lstm) + Number(weights.transformer) + Number(weights.xgboost);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold uppercase tracking-tighter">AI Engine Flux</h1>
          <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">Voting Classifier Calibration</p>
        </div>
        <button 
          onClick={handleSave}
          disabled={isSaving || Math.abs(totalWeight - 1.0) > 0.001}
          className="flex items-center gap-2 px-6 py-3 bg-red-600 hover:bg-red-700 disabled:bg-gray-800 text-white rounded-xl font-bold transition-all shadow-lg shadow-red-600/20"
        >
          <Save className="w-4 h-4" />
          {isSaving ? 'SYNCING...' : 'SAVE CONFIGURATION'}
        </button>
      </div>

      {Math.abs(totalWeight - 1.0) > 0.001 && (
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl flex items-center gap-3 text-red-500 text-sm">
          <ShieldAlert className="w-5 h-5" />
          <p className="font-bold">Error: Total weights must equal 100% (Current: {(totalWeight * 100).toFixed(1)}%)</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-gray-900/40 border border-gray-800 p-8 rounded-2xl backdrop-blur-sm">
          <div className="flex items-center gap-3 mb-8">
            <Sliders className="w-5 h-5 text-blue-500" />
            <h2 className="text-lg font-bold">Model Distribution</h2>
          </div>

          <div className="space-y-10">
            {[
              { id: 'lstm', name: 'LSTM Neural Net', color: 'bg-blue-500' },
              { id: 'transformer', name: 'Attention Transformer', color: 'bg-purple-500' },
              { id: 'xgboost', name: 'XGBoost Ensemble', color: 'bg-orange-500' }
            ].map((model) => (
              <div key={model.id} className="space-y-4">
                <div className="flex justify-between items-end">
                  <label className="text-sm font-bold text-gray-400 uppercase tracking-widest">{model.name}</label>
                  <span className="text-xl font-mono font-bold">{(weights as any)[model.id] * 100}%</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max="1" 
                  step="0.05"
                  value={(weights as any)[model.id]}
                  onChange={(e) => setWeights({ ...weights, [model.id]: parseFloat(e.target.value) })}
                  className="w-full h-1.5 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-8">
          <div className="bg-gray-900/40 border border-gray-800 p-8 rounded-2xl backdrop-blur-sm">
            <div className="flex items-center gap-3 mb-6">
              <Brain className="w-5 h-5 text-green-500" />
              <h2 className="text-lg font-bold">Confidence Threshold</h2>
            </div>
            <p className="text-xs text-gray-500 mb-8 leading-relaxed">
              Minimum cumulative consensus required for signal generation. 
              Higher values increase precision but reduce volume.
            </p>
            <div className="space-y-4">
              <div className="flex justify-between items-end">
                <label className="text-sm font-bold text-gray-400 uppercase tracking-widest">Sniper Cutoff</label>
                <span className="text-3xl font-mono font-bold text-green-500">{weights.threshold * 100}%</span>
              </div>
              <input 
                type="range" 
                min="0.70" 
                max="0.99" 
                step="0.01"
                value={weights.threshold}
                onChange={(e) => setWeights({ ...weights, threshold: parseFloat(e.target.value) })}
                className="w-full h-1.5 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-green-500"
              />
            </div>
          </div>

          <div className="bg-blue-600/5 border border-blue-500/20 p-6 rounded-2xl flex items-start gap-4">
            <Info className="w-5 h-5 text-blue-500 shrink-0 mt-1" />
            <div className="text-xs text-gray-400 leading-relaxed">
              <p className="font-bold text-gray-300 mb-1 uppercase tracking-tighter">Calibration Intelligence</p>
              The 2026 Engine uses a weight-based voting mechanism. LSTM handles temporal sequence data, 
              Transformers identify long-term attention patterns, and XGBoost filters non-linear feature noise.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
