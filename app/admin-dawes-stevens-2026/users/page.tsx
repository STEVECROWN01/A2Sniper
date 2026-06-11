'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Users, UserCheck, Shield, Award, Crown, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';

export default function AdminUsersPage() {
  useAuth(true);
  interface UserEntry {
    user_id: string;
    email: string;
    plan_name: string;
  }
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const res = await fetch(`${url}/api/admin/users`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
      }
    } catch (err) {
      toast.error("Failed to load user database.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const updatePlan = async (userId: string, newPlan: string) => {
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const res = await fetch(`${url}/api/admin/users/${userId}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ plan: newPlan })
      });
      if (res.ok) {
        toast.success(`User plan updated to ${newPlan}`);
        setUsers(users.map(u => u.user_id === userId ? { ...u, plan_name: newPlan } : u));
      }
    } catch (err) {
      toast.error("Failed to update user plan.");
    }
  };

  const getPlanIcon = (plan: string) => {
    switch (plan) {
      case 'Pro': return <Crown className="w-4 h-4 text-yellow-500" />;
      case 'Premium': return <Award className="w-4 h-4 text-purple-500" />;
      default: return <Shield className="w-4 h-4 text-blue-500" />;
    }
  };

  // Calculate retention rate: users with active (non-Standard) plans / total users
  const activeSubscriptions = users.filter(u => u.plan_name !== 'Standard').length;
  const retentionRate = users.length > 0 ? Math.round((activeSubscriptions / users.length) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">User Matrix</h1>
          <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">Access Control & Subscriptions</p>
        </div>
        <button 
          onClick={fetchUsers}
          className="p-2 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-gray-900/40 border border-gray-800 p-6 rounded-2xl">
          <p className="text-xs text-gray-500 uppercase font-bold mb-1">Total Members</p>
          <p className="text-3xl font-bold">{users.length}</p>
        </div>
        <div className="bg-gray-900/40 border border-gray-800 p-6 rounded-2xl">
          <p className="text-xs text-gray-500 uppercase font-bold mb-1">Active Premium</p>
          <p className="text-3xl font-bold text-purple-500">{users.filter(u => u.plan_name !== 'Standard').length}</p>
        </div>
        <div className="bg-gray-900/40 border border-gray-800 p-6 rounded-2xl">
          <p className="text-xs text-gray-500 uppercase font-bold mb-1">Retention</p>
          <p className="text-3xl font-bold text-green-500">{users.length > 0 ? `${retentionRate}%` : 'N/A'}</p>
        </div>
      </div>
      
      <div className="bg-gray-900/40 border border-gray-800 rounded-2xl overflow-hidden backdrop-blur-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-gray-800 bg-black/20">
              <th className="p-4 text-[10px] font-bold text-gray-500 uppercase">User Identity</th>
              <th className="p-4 text-[10px] font-bold text-gray-500 uppercase">Email</th>
              <th className="p-4 text-[10px] font-bold text-gray-500 uppercase">Current Plan</th>
              <th className="p-4 text-[10px] font-bold text-gray-500 uppercase text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.user_id} className="border-b border-gray-800 hover:bg-white/5 transition-colors">
                <td className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-gray-800 rounded-full flex items-center justify-center font-bold text-xs">
                      {user.user_id[0]}
                    </div>
                    <span className="font-mono text-sm">{user.user_id}</span>
                  </div>
                </td>
                <td className="p-4 text-sm text-gray-400">{user.email}</td>
                <td className="p-4">
                  <div className="flex items-center gap-2">
                    {getPlanIcon(user.plan_name)}
                    <span className="text-sm font-bold">{user.plan_name}</span>
                  </div>
                </td>
                <td className="p-4 text-right">
                  <select 
                    value={user.plan_name}
                    onChange={(e) => updatePlan(user.user_id, e.target.value)}
                    className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
                  >
                    <option value="Standard">Standard</option>
                    <option value="Premium">Premium</option>
                    <option value="Pro">Pro</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
