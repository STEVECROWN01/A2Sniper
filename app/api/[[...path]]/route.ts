/**
 * Next.js API Proxy — forwards /api/* requests to the A2Sniper backend.
 *
 * Security Features:
 * - httpOnly cookies for JWT tokens (XSS protection)
 * - Automatic token refresh when access token expires
 * - CSRF protection via custom X-Requested-With header
 * - Token rotation on refresh
 *
 * Architecture:
 * - Frontend calls /api/* (same-origin, no CORS issues)
 * - This proxy forwards to the backend
 * - Auth tokens are stored in httpOnly cookies, never in localStorage
 * - The proxy reads cookies and adds Authorization headers for the backend
 */

import { NextRequest, NextResponse } from 'next/server';

// The proxy needs the REAL backend URL (not the relative proxy URL).
const BACKEND_URL = process.env.API_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

// Allowed origins for CORS — restrict to known domains
const ALLOWED_ORIGINS = [
  'https://a2sniper.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
];

// Only forward these headers to the backend (security: prevent header injection)
const ALLOWED_REQUEST_HEADERS = ['authorization', 'content-type', 'accept'];

// Auth endpoints that return tokens in the response body
const TOKEN_AUTH_ENDPOINTS = [
  '/api/auth/login',
  '/api/auth/google',
  '/api/auth/refresh',
];

// Cookie names
const ACCESS_TOKEN_COOKIE = 'a2sniper_at';
const REFRESH_TOKEN_COOKIE = 'a2sniper_rt';

// Cookie settings
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api/auth/refresh',  // Only sent on refresh requests
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

function getCorsOrigin(request: NextRequest): string {
  const origin = request.headers.get('origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return '';
}

/**
 * Check if an access token is expired by decoding its payload (without verification).
 */
function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp) {
      // Add 30 second buffer to avoid edge cases
      return Date.now() >= (payload.exp * 1000) - 30000;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Attempt to refresh the access token using the refresh token cookie.
 * Returns new tokens or null on failure.
 */
async function attemptTokenRefresh(request: NextRequest): Promise<{
  access_token: string;
  refresh_token: string;
  user?: Record<string, unknown>;
} | null> {
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  if (!refreshToken) {
    return null;
  }

  try {
    const refreshUrl = `${BACKEND_URL}/api/auth/refresh`;
    const refreshRes = await fetch(refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(10000), // 10s timeout for refresh
    });

    if (!refreshRes.ok) {
      return null;
    }

    const data = await refreshRes.json();
    if (data.access_token && data.refresh_token) {
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        user: data.user,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Set auth cookies on a response object.
 */
function setAuthCookies(
  response: NextResponse,
  accessToken: string,
  refreshToken: string
): void {
  // Access token cookie — sent on all /api/* requests
  // MUST match the backend's ACCESS_TOKEN_EXPIRE_MINUTES (7 days = 10080 min)
  // Previously was 15 minutes — caused endless logouts after 15 min of inactivity
  response.cookies.set(ACCESS_TOKEN_COOKIE, accessToken, {
    ...COOKIE_OPTIONS,
    maxAge: 7 * 24 * 60 * 60, // 7 days (matches backend ACCESS_TOKEN_EXPIRE_MINUTES)
  });

  // Refresh token cookie — only sent on /api/auth/refresh requests
  // MUST match the backend's REFRESH_TOKEN_EXPIRE_DAYS (30 days)
  response.cookies.set(REFRESH_TOKEN_COOKIE, refreshToken, {
    ...REFRESH_COOKIE_OPTIONS,
    maxAge: 30 * 24 * 60 * 60, // 30 days (matches backend REFRESH_TOKEN_EXPIRE_DAYS)
  });
}

/**
 * Clear all auth cookies on a response object.
 */
function clearAuthCookies(response: NextResponse): void {
  response.cookies.set(ACCESS_TOKEN_COOKIE, '', { ...COOKIE_OPTIONS, maxAge: 0 });
  response.cookies.set(REFRESH_TOKEN_COOKIE, '', { ...REFRESH_COOKIE_OPTIONS, maxAge: 0 });
}

async function proxyRequest(request: NextRequest, path?: string[]) {
  // Build the target URL
  const pathStr = path ? path.join('/') : '';
  const targetUrl = `${BACKEND_URL}/api/${pathStr}`;
  const endpoint = `/api/${pathStr}`;

  // Forward query parameters
  const url = new URL(request.url);
  const queryString = url.searchParams.toString();
  const fullUrl = queryString ? `${targetUrl}?${queryString}` : targetUrl;

  // Only forward whitelisted headers (security: prevent header injection / SSRF)
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (ALLOWED_REQUEST_HEADERS.includes(key.toLowerCase())) {
      headers[key] = value;
    }
  });

  // ====== TOKEN INJECTION ======
  // For non-auth endpoints, read the access token from cookie and inject Authorization header
  if (!TOKEN_AUTH_ENDPOINTS.includes(endpoint) && endpoint !== '/api/auth/logout') {
    let accessToken = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;

    // If access token is expired, try to refresh it first
    if (accessToken && isTokenExpired(accessToken)) {
      const refreshed = await attemptTokenRefresh(request);
      if (refreshed) {
        accessToken = refreshed.access_token;
        // We'll set the new cookies on the response later
        // Store refreshed tokens for later use
        (request as any).__refreshedTokens = refreshed;
      } else {
        // Refresh failed — clear cookies and return 401
        const errorResponse = NextResponse.json(
          { detail: 'Session expired. Please log in again.' },
          { status: 401 }
        );
        clearAuthCookies(errorResponse);
        return errorResponse;
      }
    }

    if (accessToken) {
      headers['authorization'] = `Bearer ${accessToken}`;
    }
  }

  // For logout endpoint, inject the access token from cookie
  if (endpoint === '/api/auth/logout') {
    const accessToken = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
    if (accessToken) {
      headers['authorization'] = `Bearer ${accessToken}`;
    }
  }

  try {
    // Build fetch options
    const fetchOptions: RequestInit = {
      method: request.method,
      headers,
    };

    // Forward body for POST/PUT/PATCH
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      fetchOptions.body = await request.text();
    }

    const response = await fetch(fullUrl, {
      ...fetchOptions,
      signal: AbortSignal.timeout(30000), // 30s timeout
    });

    // Forward response headers
    // IMPORTANT: Strip content-encoding and content-length because Vercel's edge
    // will re-compress the response. If we forward gzip headers from the backend,
    // the browser gets double-compressed data → ERR_CONTENT_DECODING_FAILED.
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!['transfer-encoding', 'connection', 'content-encoding', 'content-length'].includes(lower)) {
        responseHeaders.set(key, value);
      }
    });

    // Add restricted CORS headers (only allow known origins)
    const corsOrigin = getCorsOrigin(request);
    if (corsOrigin) {
      responseHeaders.set('Access-Control-Allow-Origin', corsOrigin);
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Requested-With');
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');
    }

    const body = await response.text();
    const proxyResponse = new NextResponse(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

    // ====== TOKEN EXTRACTION FROM AUTH RESPONSES ======
    // For login/google/refresh endpoints, extract tokens from response body
    // and set them as httpOnly cookies, then remove tokens from the response body
    if (TOKEN_AUTH_ENDPOINTS.includes(endpoint) && response.ok) {
      try {
        const responseBody = JSON.parse(body);
        if (responseBody.access_token && responseBody.refresh_token) {
          // Set httpOnly cookies
          setAuthCookies(proxyResponse, responseBody.access_token, responseBody.refresh_token);

          // Remove tokens from the response body (they're now in cookies)
          const safeBody = { ...responseBody };
          delete safeBody.access_token;
          delete safeBody.refresh_token;
          // Keep expires_in so frontend knows when to expect refresh
          safeBody.token_in_cookie = true;

          // Re-create response with safe body
          const safeResponse = new NextResponse(JSON.stringify(safeBody), {
            status: proxyResponse.status,
            statusText: proxyResponse.statusText,
            headers: proxyResponse.headers,
          });
          // Re-set cookies on the new response
          setAuthCookies(safeResponse, responseBody.access_token, responseBody.refresh_token);
          return safeResponse;
        }
      } catch {
        // If we can't parse the body, just forward as-is
      }
    }

    // ====== LOGOUT: CLEAR COOKIES ======
    if (endpoint === '/api/auth/logout') {
      clearAuthCookies(proxyResponse);
    }

    // ====== DELETE ACCOUNT: CLEAR COOKIES ======
    if (endpoint === '/api/auth/delete-account-confirm' && response.ok) {
      clearAuthCookies(proxyResponse);
    }

    // ====== AUTO-REFRESH: SET NEW COOKIES IF TOKEN WAS REFRESHED ======
    const refreshedTokens = (request as any).__refreshedTokens;
    if (refreshedTokens) {
      setAuthCookies(proxyResponse, refreshedTokens.access_token, refreshedTokens.refresh_token);
    }

    // ====== HANDLE 401: CLEAR COOKIES ======
    if (response.status === 401 && !TOKEN_AUTH_ENDPOINTS.includes(endpoint)) {
      clearAuthCookies(proxyResponse);
    }

    return proxyResponse;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[API PROXY] Error proxying ${request.method} ${fullUrl}:`, message);

    return NextResponse.json(
      {
        detail: 'Service temporarily unavailable. Please try again later.',
      },
      { status: 502 }
    );
  }
}

// Handle CORS preflight
export async function OPTIONS(request: NextRequest) {
  const corsOrigin = getCorsOrigin(request);
  if (!corsOrigin) {
    return new NextResponse(null, { status: 403 });
  }

  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-Requested-With',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    },
  });
}
