import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const FOUNDER_IPS = (process.env.FOUNDER_IPS || '').split(',').filter(Boolean);
const ADMIN_SECRET_TOKEN = process.env.ADMIN_SECRET_TOKEN || '';

// Public pages that don't require authentication
const PUBLIC_PAGES = ['/', '/login', '/signup', '/pricing', '/legal', '/google-callback'];

// ─── Admin token (JWT HS256) verification in the edge runtime ───────────────
// The admin_token cookie is a JWT signed by the backend with ADMIN_SECRET_TOKEN.
// We verify the signature here using Web Crypto (crypto.subtle), which is
// available in the Next.js edge runtime. No DB lookup needed.
//
// JWT structure: header.payload.signature — all base64url-encoded, dot-separated.
// We reconstruct the signing input (header.payload), recompute the HMAC, and
// compare in constant time.

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

async function verifyAdminToken(token: string): Promise<boolean> {
  if (!ADMIN_SECRET_TOKEN || ADMIN_SECRET_TOKEN.length < 16) {
    return false; // secret not configured — refuse all admin access
  }

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) return false;

  // Reconstruct the signing input: "header.payload"
  const signingInput = `${headerB64}.${payloadB64}`;
  const enc = new TextEncoder();

  // Decode the base64url signature into raw bytes
  let signatureBytes: Uint8Array;
  try {
    // base64url -> base64 -> bytes
    const b64 = signatureB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    signatureBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      signatureBytes[i] = binary.charCodeAt(i);
    }
  } catch {
    return false;
  }

  // Verify the HMAC-SHA256 signature
  let isValid = false;
  try {
    const key = await importHmacKey(ADMIN_SECRET_TOKEN);
    isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      enc.encode(signingInput),
    );
  } catch {
    return false;
  }
  if (!isValid) return false;

  // Decode the payload and check expiration + purpose
  try {
    const payloadB64Norm = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const payloadPadded = payloadB64Norm + '='.repeat((4 - (payloadB64Norm.length % 4)) % 4);
    const payloadJson = atob(payloadPadded);
    const payload = JSON.parse(payloadJson);

    // Check purpose
    if (payload.purpose !== 'admin') return false;

    // Check expiration (exp is a unix timestamp in seconds)
    if (typeof payload.exp !== 'number') return false;
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp < nowSec) return false; // expired

    return true;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ═══════════ Admin route protection ═══════════
  if (pathname.startsWith('/admin-dawes-stevens-2026')) {
    // Skip login page itself
    if (pathname === '/admin-dawes-stevens-2026/login') {
      return NextResponse.next();
    }

    // Layer A: IP whitelist (founder IPs)
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip')?.trim() ||
      'unknown';

    const isIpAllowed =
      FOUNDER_IPS.length > 0 &&
      FOUNDER_IPS.some((allowedIp) => ip === allowedIp.trim());

    if (isIpAllowed) {
      // IP-whelisted founders bypass both 2FA and the regular user auth check.
      // Return immediately so we don't fall through to the public-route check
      // (which would require an a2sniper_at cookie and redirect to /login).
      return NextResponse.next();
    }

    // Layer B: signed admin_token cookie (JWT HS256, 10-min TTL)
    const adminToken = request.cookies.get('admin_token')?.value || '';
    const isValidToken = adminToken ? await verifyAdminToken(adminToken) : false;

    if (!isValidToken) {
      const loginUrl = new URL('/admin-dawes-stevens-2026/login', request.url);
      return NextResponse.redirect(loginUrl);
    }

    // Admin token is valid — allow access. Return immediately so we don't
    // fall through to the public-route check (which would require an
    // a2sniper_at cookie and could redirect to /login).
    return NextResponse.next();
  }

  // ═══════════ User route protection (cookie-based auth) ═══════════
  // Skip API routes, static files, and Next.js internals
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // Skip public pages
  if (PUBLIC_PAGES.some((page) => pathname === page)) {
    return NextResponse.next();
  }

  // Check if user has an auth cookie (httpOnly access token)
  const accessToken = request.cookies.get('a2sniper_at')?.value;

  if (!accessToken) {
    // No auth cookie — redirect to login
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin-dawes-stevens-2026/:path*', '/((?!api|_next|favicon.ico|.*\\..*).*)'],
};
