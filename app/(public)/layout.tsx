'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { Navigation } from '@/components/ui/navigation';
import LoadingSpinner from '@/components/ui/LoadingSpinner';

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Pages that should not display the sidebar
  const noNavRoutes = ['/', '/login', '/signup', '/google-callback'];
  const shouldShowNav = !noNavRoutes.includes(pathname) && !pathname.startsWith('/admin-dawes-stevens-2026');

  useEffect(() => {
    if (!shouldShowNav) return;
    
    setIsTransitioning(true);
    const timer = setTimeout(() => {
      setIsTransitioning(false);
    }, 3500); // Minimum of 3.5 seconds (3 to 4 seconds) as requested

    return () => clearTimeout(timer);
  }, [pathname, shouldShowNav]);

  if (!shouldShowNav) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-[#050507] text-gray-200 relative overflow-hidden flex flex-col md:flex-row">
      
      {/* Background orbs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-1/4 -left-20 w-[500px] h-[500px] bg-[#D4AF37]/5 rounded-full blur-[150px]" />
        <div className="absolute bottom-1/4 -right-20 w-[500px] h-[500px] bg-[#D4AF37]/5 rounded-full blur-[150px]" />
      </div>

      {/* Persistent Sidebar Navigation */}
      <Navigation />

      {/* Content wrapper with correct margins on desktop to prevent sidebar overlap */}
      <div className="flex-grow flex flex-col min-w-0 md:pl-64 relative z-10 w-full">
        <main className="flex-grow p-4 sm:p-6 lg:p-10 w-full overflow-x-hidden">
          {isTransitioning ? <LoadingSpinner /> : children}
        </main>
      </div>
    </div>
  );
}
