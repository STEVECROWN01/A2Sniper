'use client';

import { useState, useEffect, useRef } from 'react';
import { Terminal, RefreshCw, Download, Search, AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { useAuth } from '@/hooks/use-auth';

export default function AdminLogsPage() {
  useAuth(true);
  interface LogEntry {
    msg: string;
    level: string;
    time: string;
  }
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async () => {
    try {
      const url = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const res = await fetch(`${url}/api/admin/logs?limit=100`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs);
      }
    } catch (err) {
      console.error("Failed to fetch logs");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const filteredLogs = logs.filter(l => 
    l.msg.toLowerCase().includes(filter.toLowerCase()) || 
    l.level.toLowerCase().includes(filter.toLowerCase())
  );

  const getLevelColor = (level: string) => {
    switch (level.toUpperCase()) {
      case 'ERROR': return 'text-red-500';
      case 'WARN': return 'text-yellow-500';
      case 'SUCCESS': return 'text-green-500';
      default: return 'text-blue-400';
    }
  };

  const getLevelIcon = (level: string) => {
    switch (level.toUpperCase()) {
      case 'ERROR': return <AlertTriangle className="w-3 h-3" />;
      case 'SUCCESS': return <CheckCircle className="w-3 h-3" />;
      default: return <Info className="w-3 h-3" />;
    }
  };

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-200px)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Kernel Logs</h1>
          <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">Real-time system telemetry</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input 
              type="text" 
              placeholder="Filter logs..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-10 pr-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-xs focus:outline-none focus:border-blue-500 w-64"
            />
          </div>
          <button 
            onClick={fetchLogs}
            className="p-2 bg-gray-800 rounded-lg hover:bg-gray-700 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="flex-1 bg-black border border-gray-800 rounded-2xl p-6 font-mono text-[11px] overflow-y-auto custom-scrollbar shadow-inner">
        <div className="flex items-center gap-2 mb-6 border-b border-gray-800 pb-4">
          <Terminal className="w-4 h-4 text-green-500" />
          <span className="text-gray-500 uppercase tracking-widest text-[9px] font-bold">master_node:~/telemetry$ tail -f engine.log</span>
        </div>
        
        <div className="space-y-2">
          {filteredLogs.map((log, i) => (
            <motion.div 
              key={i}
              initial={{ opacity: 0, x: -5 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex items-start gap-4 group"
            >
              <span className="text-gray-600 shrink-0">[{log.time}]</span>
              <div className={`flex items-center gap-2 shrink-0 font-bold ${getLevelColor(log.level)}`}>
                {getLevelIcon(log.level)}
                <span>{log.level}:</span>
              </div>
              <span className="text-gray-300 group-hover:text-white transition-colors">{log.msg}</span>
            </motion.div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>

      <div className="flex justify-between items-center text-[10px] text-gray-600 uppercase font-bold tracking-widest">
        <div className="flex gap-4">
          <span>Total entries: {logs.length}</span>
          <span className="text-green-500">Node Status: Operational</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          Live Connection
        </div>
      </div>
    </div>
  );
}
