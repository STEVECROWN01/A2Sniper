'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { 
  LayoutDashboard, 
  Target, 
  Users, 
  Terminal, 
  Settings, 
  ShieldCheck, 
  Activity,
  LogOut
} from 'lucide-react';
import Link from 'next/link';
import { useAppStore } from '@/lib/store';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, user, isInitialized } = useAppStore();
  const isLoginPage = pathname === '/admin-dawes-stevens-2026/login';

  // Auth protection: redirect to admin login if not authenticated or not admin
  useEffect(() => {
    if (!isInitialized) return;
    if (isLoginPage) return; // Don't redirect on login page itself
    
    if (!isAuthenticated || !user?.is_admin) {
      router.push('/admin-dawes-stevens-2026/login');
    }
  }, [isAuthenticated, user, isInitialized, isLoginPage, router]);

  if (isLoginPage) return <>{children}</>;

  const menuItems = [
    { name: 'Overview', href: '/admin-dawes-stevens-2026', icon: LayoutDashboard },
    { name: 'Sniper Signals', href: '/admin-dawes-stevens-2026/signals', icon: Target },
    { name: 'User Matrix', href: '/admin-dawes-stevens-2026/users', icon: Users },
    { name: 'Engine Flux', href: '/admin-dawes-stevens-2026/engine', icon: Activity },
    { name: 'Kernel Logs', href: '/admin-dawes-stevens-2026/logs', icon: Terminal },
    { name: 'Configuration', href: '/admin-dawes-stevens-2026/settings', icon: Settings },
  ];

  const handleLogout = () => {
    document.cookie = "admin_token=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT;";
    window.location.href = '/admin-dawes-stevens-2026/login';
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white font-mono flex">
      {/* Sidebar */}
      <aside className="w-72 bg-black/40 backdrop-blur-2xl border-r border-red-500/10 flex flex-col fixed inset-y-0 z-50">
        <div className="p-8">
          <div className="flex items-center gap-3 mb-10">
            <div className="w-10 h-10 bg-red-600 rounded flex items-center justify-center shadow-[0_0_15px_rgba(220,38,38,0.4)]">
              <span className="font-bold text-xl">TS</span>
            </div>
            <div>
              <h1 className="font-bold text-sm tracking-widest text-red-500">FOUNDER</h1>
              <p className="text-[10px] text-gray-500 uppercase tracking-tighter">Master Control Unit</p>
            </div>
          </div>

          <nav className="space-y-1">
            {menuItems.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link 
                  key={item.name} 
                  href={item.href}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all group ${
                    isActive 
                    ? 'bg-red-500/10 text-red-500 border border-red-500/20' 
                    : 'text-gray-500 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <item.icon className={`w-5 h-5 ${isActive ? 'text-red-500' : 'group-hover:text-red-400'}`} />
                  <span className="text-sm font-medium">{item.name}</span>
                  {isActive && (
                    <motion.div 
                      layoutId="active-pill"
                      className="ml-auto w-1.5 h-1.5 bg-red-500 rounded-full shadow-[0_0_8px_#ef4444]"
                    />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="mt-auto p-6 border-t border-gray-900">
          <div className="bg-green-500/5 border border-green-500/20 rounded-xl p-4 mb-4">
            <div className="flex items-center gap-2 mb-1">
              <ShieldCheck className="w-3 h-3 text-green-500" />
              <span className="text-[10px] font-bold text-green-500 uppercase">System Secure</span>
            </div>
            <p className="text-[9px] text-gray-500">IP Whitelist: 127.0.0.1 (Verified)</p>
            <p className="text-[9px] text-gray-500">2FA Status: Active (TOTP)</p>
          </div>

          <button 
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-4 py-3 text-gray-500 hover:text-red-500 transition-colors rounded-lg hover:bg-red-500/5"
          >
            <LogOut className="w-5 h-5" />
            <span className="text-sm font-medium">Terminate Session</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 ml-72">
        <header className="h-20 border-b border-gray-900 flex items-center justify-between px-10 sticky top-0 bg-[#050505]/80 backdrop-blur-md z-40">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse shadow-[0_0_5px_#ef4444]" />
              <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Live Engine Stream</span>
            </div>
            <div className="h-4 w-px bg-gray-800" />
            <div className="text-xs text-gray-400 font-mono">
              $ uptime: <span className="text-green-500">14d 06h 22m</span>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex -space-x-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="w-8 h-8 rounded-full border-2 border-[#050505] bg-gray-800 flex items-center justify-center text-[10px] font-bold overflow-hidden">
                  <img src={`https://i.pravatar.cc/100?u=founder${i}`} alt="Founder" />
                </div>
              ))}
            </div>
          </div>
        </header>

        <div className="p-10">
          {children}
        </div>
      </main>
    </div>
  );
}
