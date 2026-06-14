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
  // Explicit override takes priority
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }

  // In browser: if not localhost, use same-domain proxy (empty string = relative)
  if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
    return '';
  }

  // Local development fallback
  return 'http://localhost:8000';
}
