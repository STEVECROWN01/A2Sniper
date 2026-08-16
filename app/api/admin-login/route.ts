/**
 * /api/admin-login — Server-side route handler that sets the admin_token cookie.
 *
 * The browser cannot set httpOnly cookies directly, so the frontend posts the
 * signed admin token (returned by the backend's /api/admin/login/verify) to
 * this same-origin route handler. We then set the httpOnly admin_token cookie
 * with a 10-minute TTL, scoped to /admin-dawes-stevens-2026.
 *
 * Security:
 *   - httpOnly: not accessible to JS (XSS cannot exfiltrate)
 *   - secure: HTTPS only in production
 *   - sameSite=lax: sent on same-site navigations to /admin-dawes-stevens-2026/*
 *   - path=/admin-dawes-stevens-2026: only sent on admin routes (minimizes exposure)
 *
 * The cookie value is a signed JWT (HS256) produced by the backend using
 * ADMIN_SECRET_TOKEN. The edge middleware verifies it via crypto.subtle.
 */
import { NextRequest, NextResponse } from 'next/server';

const ADMIN_TOKEN_COOKIE = 'admin_token';
const ADMIN_TOKEN_TTL_SECONDS = 10 * 60; // 10 minutes — matches backend

export async function POST(request: NextRequest) {
  let body: { admin_token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { admin_token } = body;
  if (!admin_token || typeof admin_token !== 'string' || admin_token.length < 20) {
    return NextResponse.json({ error: 'admin_token is required' }, { status: 400 });
  }

  // Basic shape check: JWTs have exactly 3 dot-separated base64url segments.
  const parts = admin_token.split('.');
  if (parts.length !== 3) {
    return NextResponse.json({ error: 'Malformed admin_token' }, { status: 400 });
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const response = NextResponse.json({ ok: true });

  response.cookies.set({
    name: ADMIN_TOKEN_COOKIE,
    value: admin_token,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/admin-dawes-stevens-2026',
    maxAge: ADMIN_TOKEN_TTL_SECONDS,
  });

  return response;
}

export async function DELETE() {
  // Logout: clear the admin_token cookie.
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: ADMIN_TOKEN_COOKIE,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/admin-dawes-stevens-2026',
    maxAge: 0, // delete
  });
  return response;
}
