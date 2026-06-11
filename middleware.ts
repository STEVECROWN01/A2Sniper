import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const FOUNDER_IPS = (process.env.FOUNDER_IPS || '').split(',').filter(Boolean);
const ADMIN_SECRET_TOKEN = process.env.ADMIN_SECRET_TOKEN || '';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Admin route protection
  if (pathname.startsWith('/admin-dawes-stevens-2026')) {
    // Skip login page
    if (pathname === '/admin-dawes-stevens-2026/login') {
      return NextResponse.next();
    }

    // Check IP - use exact match instead of substring
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 
               request.headers.get('x-real-ip')?.trim() || 
               'unknown';
    
    // Exact IP match only (not substring)
    const isIpAllowed = FOUNDER_IPS.length > 0 && FOUNDER_IPS.some(allowedIp => ip === allowedIp.trim());
    
    // Check admin token cookie
    const token = request.cookies.get('admin_token')?.value || '';
    const isValidToken = token === ADMIN_SECRET_TOKEN && ADMIN_SECRET_TOKEN.length > 0;
    
    if (!isIpAllowed && !isValidToken) {
      return NextResponse.redirect(new URL('/admin-dawes-stevens-2026/login', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin-dawes-stevens-2026/:path*'],
};
