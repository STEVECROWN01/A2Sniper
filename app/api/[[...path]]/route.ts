/**
 * Next.js API Proxy — forwards /api/* requests to the A2Sniper backend.
 *
 * This solves the CORS and network accessibility problem:
 * - Frontend on Vercel calls its own domain's /api/*
 * - This serverless function proxies to the actual backend
 * - The backend URL is configured via API_BACKEND_URL env var
 * - Falls back to http://localhost:8000 for local development
 */

import { NextRequest, NextResponse } from 'next/server';

// The proxy needs the REAL backend URL (not the relative proxy URL).
// On the server side (Vercel serverless function), we need the absolute URL.
// Priority: API_BACKEND_URL > NEXT_PUBLIC_API_URL > localhost fallback
const BACKEND_URL = process.env.API_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

// Allowed origins for CORS — restrict to known domains
const ALLOWED_ORIGINS = [
  'https://a2sniper.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
];

// Only forward these headers to the backend (security: prevent header injection)
const ALLOWED_REQUEST_HEADERS = ['authorization', 'content-type', 'accept'];

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

function getCorSOrigin(request: NextRequest): string {
  const origin = request.headers.get('origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  // Default: allow same-origin (no CORS header = browser blocks cross-origin)
  return '';
}

async function proxyRequest(request: NextRequest, path?: string[]) {
  // Build the target URL
  const pathStr = path ? path.join('/') : '';
  const targetUrl = `${BACKEND_URL}/api/${pathStr}`;

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
    const corsOrigin = getCorSOrigin(request);
    if (corsOrigin) {
      responseHeaders.set('Access-Control-Allow-Origin', corsOrigin);
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');
    }

    const body = await response.text();
    return new NextResponse(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
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
  const corsOrigin = getCorSOrigin(request);
  if (!corsOrigin) {
    return new NextResponse(null, { status: 403 });
  }

  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    },
  });
}
