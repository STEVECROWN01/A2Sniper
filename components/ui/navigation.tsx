'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  TrendingUp, 
  BarChart3, 
  Settings, 
  Users, 
  Zap, 
  Menu, 
  X, 
  User, 
  Bell, 
  LogOut, 
  Search,
  MessageCircle,
  Brain,
  DollarSign,
  LayoutDashboard,
  Calculator,
  BookOpen,
  Activity,
  Crown
} from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '@/lib/store';

const navigationItems = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Signaux', href: '/signals', icon: TrendingUp },
  { name: 'Bot Telegram', href: '/telegram', icon: MessageCircle },
  { name: 'Risk Manager', href: '/risk-manager', icon: Calculator },
  { name: 'Trading Journal', href: '/trading-journal', icon: BookOpen },
  { name: 'Performance', href: '/performance', icon: Activity },
  { name: 'Analyses', href: '/analytics', icon: Brain },
  { name: 'Paramètres', href: '/settings', icon: Settings },
  { name: 'Tarifs', href: '/pricing', icon: DollarSign }
];

export function Navigation() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { user, logout } = useAppStore();
  const userPlan = user?.plan || 'Free';
  const isProUser = userPlan === 'Pro';
  const pathname = usePathname();
  const router = useRouter();

  // Click-outside handler for dropdowns
  const dropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // TODO: Fetch notifications from /api/notifications when available
  // For now, default to empty — no fake notification data
  const notifications: Array<{ id: number; title: string; time: string; type: string }> = [];
  const notificationCount = 0;

  const handleLogout = useCallback(() => {
    logout();
    setShowUserMenu(false);
    router.push('/');
  }, [logout, router]);

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      
      // Match against actual application routes
      const result = navigationItems.find(item => 
        item.name.toLowerCase().includes(query) ||
        item.href.toLowerCase().includes(query)
      );
      
      if (result) {
        router.push(result.href);
      } else {
        // No matching route found — show feedback instead of defaulting to /signals
        toast.error('Aucun r\u00e9sultat trouv\u00e9 pour \u00ab\u00a0' + searchQuery.trim() + '\u00a0\u00bb');
      }
      setSearchQuery('');
      setIsMobileMenuOpen(false);
    }
  }, [searchQuery, router]);

  return (
    <>
      {/* Sidebar Desktop */}
      <div className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 z-50">
        <div className="flex flex-col flex-grow pt-6 bg-[#0a0a0c] border-r border-white/5 overflow-y-auto">
          
          {/* Logo Brand */}
          <div className="flex items-center flex-shrink-0 px-5 mb-8">
            <div className="flex items-center space-x-3">
              <div className="relative w-10 h-10 rounded-xl overflow-hidden border border-[#D4AF37]/30 flex items-center justify-center bg-[#050507] shadow-[0_0_15px_rgba(212,175,55,0.1)]">
                <img src="/A2Sniper-logo.jpeg" alt="A2Sniper Logo" className="w-full h-full object-cover" />
              </div>
              <div>
                <h1 className="text-sm font-black text-white tracking-widest uppercase">A2Sniper <span className="text-[10px] text-[#D4AF37] font-black tracking-[0.2em] ml-1">v3.0</span></h1>
                <p className="text-[9px] text-[#D4AF37] font-black uppercase tracking-widest">Neural cockpit</p>
              </div>
            </div>
          </div>
          
          {/* Nav Items */}
          <div className="flex-grow flex flex-col">
            <nav className="flex-1 px-3 space-y-1">
              {navigationItems.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    className={`group flex items-center px-4 py-3 text-xs font-bold uppercase tracking-wider rounded-xl transition-all duration-200 relative ${
                      isActive
                        ? 'bg-[#D4AF37]/10 text-[#D4AF37] border-l-2 border-[#D4AF37]'
                        : 'text-gray-400 hover:text-white hover:bg-white/[0.02]'
                    }`}
                  >
                    <item.icon
                      className={`mr-3 h-4 w-4 transition-colors ${
                        isActive ? 'text-[#D4AF37]' : 'text-gray-500 group-hover:text-white'
                      }`}
                    />
                    {item.name}
                  </Link>
                );
              })}
            </nav>
            
            {/* User Profile */}
            <div className="flex-shrink-0 flex border-t border-white/5 p-4 bg-[#050507]/40">
              <div className="flex items-center space-x-3 w-full">
                <div className="w-10 h-10 bg-white/[0.02] border border-[#D4AF37]/20 rounded-full flex items-center justify-center flex-shrink-0">
                  <User className="w-5 h-5 text-[#D4AF37]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-black text-white truncate uppercase tracking-wider">
                      {user?.name || 'Founder Member'}
                    </p>
                    {isProUser && (
                      <span className="flex items-center gap-0.5 px-1.5 py-0.5 bg-[#D4AF37]/10 border border-[#D4AF37]/30 rounded text-[8px] font-black text-[#D4AF37] uppercase tracking-wider">
                        <Crown className="w-2.5 h-2.5" />
                        Pro
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-gray-500 truncate font-bold">
                    {user?.email || 'founders@a2sniper.ai'}
                  </p>
                </div>
                <button
                  onClick={handleLogout}
                  className="flex-shrink-0 p-2 text-gray-500 hover:text-[#D4AF37] hover:bg-white/[0.03] rounded-lg transition-colors"
                  title="Déconnexion"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile Top Bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 bg-[#0a0a0c] border-b border-white/5 px-4 py-3 flex items-center justify-between">
        
        {/* Left: Mobile Menu Trigger */}
        <button
          onClick={() => setIsMobileMenuOpen(true)}
          className="p-2 text-gray-400 hover:text-white hover:bg-white/[0.03] rounded-xl transition-colors"
        >
          <Menu className="w-6 h-6" />
        </button>

        {/* Center: Brand */}
        <div className="flex items-center space-x-2">
          <div className="relative w-8 h-8 rounded-lg overflow-hidden border border-[#D4AF37]/30 flex items-center justify-center bg-[#050507]">
            <img src="/A2Sniper-logo.jpeg" alt="Logo" className="w-full h-full object-cover" />
          </div>
          <span className="text-sm font-black text-white tracking-widest uppercase">A2Sniper</span>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center space-x-2" ref={dropdownRef}>
          
          {/* Notifications */}
          <div className="relative">
            <button
              onClick={() => setShowNotifications(!showNotifications)}
              className="p-2 text-gray-400 hover:text-white hover:bg-white/[0.03] rounded-xl transition-colors relative"
            >
              <Bell className="w-5 h-5" />
              {notificationCount > 0 && (
                <span className="absolute top-1 right-1 bg-[#D4AF37] text-black text-[9px] font-black rounded-full w-4 h-4 flex items-center justify-center">
                  {notificationCount}
                </span>
              )}
            </button>

            {showNotifications && (
              <div className="absolute right-0 mt-3 w-80 bg-[#0a0a0c] rounded-2xl border border-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.5)] z-50">
                <div className="p-4 border-b border-white/5 flex justify-between items-center">
                  <h3 className="font-bold text-xs uppercase tracking-wider text-white">Notifications</h3>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {notifications.length > 0 ? (
                    notifications.map((notification) => (
                      <div key={notification.id} className="p-4 border-b border-white/[0.02] hover:bg-white/[0.02] transition-colors">
                        <div className="flex justify-between items-start gap-2">
                          <div>
                            <p className="text-xs font-bold text-gray-200">{notification.title}</p>
                            <p className="text-[10px] text-gray-500 font-bold mt-1">Il y a {notification.time}</p>
                          </div>
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            notification.type === 'signal' ? 'bg-[#D4AF37]' :
                            notification.type === 'performance' ? 'bg-green-500' :
                            'bg-red-500'
                          }`} />
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="p-6 text-center">
                      <p className="text-xs text-gray-500 font-bold">Aucune notification</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* User Menu */}
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center p-1 border border-[#D4AF37]/20 rounded-full hover:bg-white/[0.03] transition-colors"
            >
              <div className="w-7 h-7 bg-white/[0.02] rounded-full flex items-center justify-center overflow-hidden">
                <User className="w-4 h-4 text-[#D4AF37]" />
              </div>
            </button>

            {showUserMenu && (
              <div className="absolute right-0 mt-3 w-48 bg-[#0a0a0c] rounded-2xl border border-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.5)] z-50">
                <div className="p-4 border-b border-white/5">
                  <p className="text-xs font-black text-white uppercase truncate">{user?.name || 'Founder Member'}</p>
                  <p className="text-[10px] text-gray-500 font-bold truncate mt-0.5">{user?.email}</p>
                </div>
                <div className="py-2">
                  <Link
                    href="/settings"
                    className="flex items-center space-x-2 px-4 py-2.5 text-xs font-bold text-gray-400 hover:text-white hover:bg-white/[0.02]"
                    onClick={() => setShowUserMenu(false)}
                  >
                    <Settings className="w-4 h-4" />
                    <span>Paramètres</span>
                  </Link>
                  <button
                    onClick={handleLogout}
                    className="flex items-center space-x-2 px-4 py-2.5 text-xs font-bold text-red-400 hover:bg-red-500/10 w-full text-left"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Déconnexion</span>
                  </button>
                </div>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* Mobile Drawer Menu */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.6 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMobileMenuOpen(false)}
              className="fixed inset-0 bg-black z-40 backdrop-blur-sm md:hidden"
            />

            {/* Sidebar drawer */}
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'tween', duration: 0.3 }}
              className="fixed inset-y-0 left-0 w-64 bg-[#0a0a0c] border-r border-white/5 z-50 p-6 flex flex-col md:hidden"
            >
              <div className="flex justify-between items-center mb-8">
                <div className="flex items-center space-x-3">
                  <div className="relative w-8 h-8 rounded-lg overflow-hidden border border-[#D4AF37]/30 flex items-center justify-center bg-[#050507]">
                    <img src="/A2Sniper-logo.jpeg" alt="Logo" className="w-full h-full object-cover" />
                  </div>
                  <span className="text-sm font-black text-white tracking-widest uppercase">A2Sniper</span>
                </div>
                <button
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="p-1.5 text-gray-500 hover:text-white hover:bg-white/[0.03] rounded-lg"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Navigation list */}
              <nav className="flex-1 space-y-1 overflow-y-auto no-scrollbar">
                {navigationItems.map((item) => {
                  const isActive = pathname === item.href;
                  return (
                    <Link
                      key={item.name}
                      href={item.href}
                      onClick={() => setIsMobileMenuOpen(false)}
                      className={`group flex items-center px-4 py-3 text-xs font-bold uppercase tracking-wider rounded-xl transition-all duration-200 ${
                        isActive
                          ? 'bg-[#D4AF37]/10 text-[#D4AF37] border-l-2 border-[#D4AF37]'
                          : 'text-gray-400 hover:text-white hover:bg-white/[0.02]'
                      }`}
                    >
                      <item.icon
                        className={`mr-3 h-4 w-4 ${
                          isActive ? 'text-[#D4AF37]' : 'text-gray-500'
                        }`}
                      />
                      {item.name}
                    </Link>
                  );
                })}
              </nav>

              {/* Bottom logout */}
              <div className="border-t border-white/5 pt-6 mt-auto">
                <button
                  onClick={handleLogout}
                  className="flex items-center space-x-3 text-xs font-bold text-red-400 hover:text-red-300 w-full"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Se déconnecter</span>
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      
      {/* Spacer to push down content under Mobile Top Bar */}
      <div className="h-14 md:hidden" />
    </>
  );
}