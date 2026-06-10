/**
 * API Client Abstraction Layer
 * 
 * Centralized HTTP client for all API communication.
 * Handles authentication headers, base URL configuration, and error handling.
 * 
 * Usage:
 *   import { api } from '@/lib/api';
 *   const data = await api.get('/api/signals');
 *   const result = await api.post('/api/signals/request', { pair: 'EUR/USD OTC' });
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

class ApiClient {
  private baseUrl: string;
  
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }
  
  /**
   * Get auth headers with JWT token from localStorage.
   * Checks token expiry before including it.
   */
  private getHeaders(): HeadersInit {
    const token = typeof window !== 'undefined' ? this.getValidToken() : null;
    return {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    };
  }

  /**
   * Get a valid (non-expired) token from localStorage.
   * Returns null if token is missing or expired.
   */
  private getValidToken(): string | null {
    try {
      const token = localStorage.getItem('a2sniper_token');
      if (!token) return null;

      // Check JWT expiry
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp && Date.now() >= payload.exp * 1000) {
        localStorage.removeItem('a2sniper_token');
        return null;
      }
      return token;
    } catch {
      return null;
    }
  }
  
  /**
   * GET request
   */
  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.getHeaders() });
    if (!res.ok) {
      throw new ApiError(`API Error: ${res.status}`, res.status, await res.text().catch(() => ''));
    }
    return res.json();
  }
  
  /**
   * POST request
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new ApiError(`API Error: ${res.status}`, res.status, await res.text().catch(() => ''));
    }
    return res.json();
  }

  /**
   * PUT request
   */
  async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new ApiError(`API Error: ${res.status}`, res.status, await res.text().catch(() => ''));
    }
    return res.json();
  }
  
  /**
   * PATCH request
   */
  async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new ApiError(`API Error: ${res.status}`, res.status, await res.text().catch(() => ''));
    }
    return res.json();
  }

  /**
   * DELETE request
   */
  async delete<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      throw new ApiError(`API Error: ${res.status}`, res.status, await res.text().catch(() => ''));
    }
    return res.json();
  }
}

/**
 * Custom API error class with status code and response body
 */
export class ApiError extends Error {
  status: number;
  body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export const api = new ApiClient(API_BASE_URL);
export default api;
