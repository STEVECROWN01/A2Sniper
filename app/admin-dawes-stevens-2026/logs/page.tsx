'use client';

import { useState, useEffect } from 'react';
import { Terminal, ExternalLink, Info } from 'lucide-react';

interface DeprecatedResponse {
  logs: [];
  deprecated: boolean;
  message: string;
  railway_logs_hint: string;
}

export default function AdminLogsPage() {
  const [info, setInfo] = useState<DeprecatedResponse | null>(null);

  useEffect(() => {
    // Fetch the deprecation message once on mount. The endpoint no longer
    // queries the database (that was the source of the disk-full crash loop),
    // so this is a cheap static response — no polling needed.
    (async () => {
      try {
        const url = (await import('@/lib/api-config')).getApiUrl();
        const res = await fetch(`${url}/api/admin/logs?limit=1`, {
          credentials: 'include',
        });
        if (res.ok) setInfo(await res.json());
      } catch {
        // Network error — leave info as null, UI shows generic message.
      }
    })();
  }, []);

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-200px)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Kernel Logs</h1>
          <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">
            Real-time system telemetry
          </p>
        </div>
      </div>

      <div className="flex-1 bg-black border border-gray-800 rounded-2xl p-8 font-mono text-sm overflow-y-auto shadow-inner">
        <div className="flex items-center gap-2 mb-6 border-b border-gray-800 pb-4">
          <Terminal className="w-4 h-4 text-green-500" />
          <span className="text-gray-500 uppercase tracking-widest text-[10px] font-bold">
            master_node:~/telemetry$ status
          </span>
        </div>

        <div className="space-y-6">
          <div className="flex items-start gap-3">
            <Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
            <div className="space-y-2">
              <h2 className="text-blue-400 font-bold text-base">
                Database log storage has been removed
              </h2>
              <p className="text-gray-300 text-sm leading-relaxed">
                Logs are now streamed to <code className="text-green-400">stdout</code>{' '}
                only. Railway captures and retains all stdout/stderr output in the
                dashboard, where you can search, filter, and tail them live. This
                change was made to permanently prevent the disk-full crash loop
                caused by the previous DatabaseLogHandler writing every log entry
                into the <code className="text-green-400">system_logs</code> table.
              </p>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">
              How to view logs
            </p>
            <ol className="space-y-2 text-gray-300 text-xs list-decimal list-inside">
              <li>Open the Railway dashboard</li>
              <li>Click the <span className="text-green-400">A2Sniper</span> service</li>
              <li>Go to the <span className="text-green-400">Deployments</span> tab</li>
              <li>Click the latest (top) deployment</li>
              <li>Click the <span className="text-green-400">Logs</span> tab</li>
            </ol>
          </div>

          {info?.message && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">
                Backend message
              </p>
              <p className="text-gray-400 text-xs leading-relaxed">{info.message}</p>
            </div>
          )}

          <div className="flex items-center gap-2 pt-4 border-t border-gray-800">
            <ExternalLink className="w-3 h-3 text-gray-500" />
            <a
              href="https://railway.com/dashboard"
              target="_blank"
              rel="noreferrer"
              className="text-blue-400 hover:text-blue-300 text-xs underline transition-colors"
            >
              Open Railway dashboard
            </a>
          </div>
        </div>
      </div>

      <div className="flex justify-between items-center text-[10px] text-gray-600 uppercase font-bold tracking-widest">
        <div className="flex gap-4">
          <span>Storage: stdout only</span>
          <span className="text-green-500">Disk impact: 0 bytes</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          Permanent fix active
        </div>
      </div>
    </div>
  );
}
