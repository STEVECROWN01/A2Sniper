import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Whitelist des IPs fondateurs (À configurer en production via variables d'environnement)
const FOUNDER_IPS = (process.env.FOUNDER_IPS || '127.0.0.1,::1').split(',');

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Protection de la route cachée
  if (pathname.startsWith('/admin-dawes-stevens-2026')) {
    
    // 1. Vérification de l'IP
    // Note: X-Forwarded-For est utilisé si l'app est derrière un proxy (Vercel, Nginx)
    const ip = request.ip || request.headers.get('x-forwarded-for') || '127.0.0.1';
    const isIpAllowed = FOUNDER_IPS.some(allowedIp => ip.includes(allowedIp.trim()));

    // 2. Vérification du JWT (Cookie)
    const token = request.cookies.get('admin_token')?.value;
    const isValidToken = token === process.env.ADMIN_SECRET_TOKEN; // Sécurité de base, en prod vérifier le JWT réel

    if (!isIpAllowed || !isValidToken) {
      // Si on n'est pas déjà sur la page de login, on redirige
      if (pathname !== '/admin-dawes-stevens-2026/login') {
        const url = request.nextUrl.clone();
        url.pathname = '/admin-dawes-stevens-2026/login';
        return NextResponse.redirect(url);
      }
    }

    // Si on est déjà authentifié et on essaie d'aller sur le login, on redirige vers le dashboard
    if (isValidToken && pathname === '/admin-dawes-stevens-2026/login') {
      const url = request.nextUrl.clone();
      url.pathname = '/admin-dawes-stevens-2026';
      return NextResponse.redirect(url);
    }

    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin-dawes-stevens-2026/:path*'],
};
