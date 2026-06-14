/**
 * API URL Configuration — Single Source of Truth
 *
 * In production (deployed on Vercel), API calls go to the same domain
 * via Next.js API route proxy (app/api/[[...path]]/route.ts).
 * This solves CORS and network accessibility issues.
 *
 * In local development, calls go directly to the backend on localhost:8000.
 *
 * To override, set NEXT_PUBLIC_API_URL in your Vercel environment variables.
 */

export function getApiUrl(): string {
  // In browser on deployed domain: always use same-domain proxy (empty string = relative)
  // The Next.js API proxy (app/api/[[...path]]/route.ts) forwards to the backend.
  // This avoids CORS issues since browser ↔ Vercel is same-origin.
  if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
    return '';
  }

  // Server-side (SSR / API routes): use NEXT_PUBLIC_API_URL to call backend directly
  // (On Vercel, the API proxy needs the absolute backend URL)
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }

  // Local development fallback
  return 'http://localhost:8000';
}
