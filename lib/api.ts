/**
 * API Client Abstraction Layer
 * 
 * Centralized HTTP client for all API communication.
 * Auth tokens are now stored in httpOnly cookies — the browser sends them
 * automatically with credentials: 'include'. No localStorage needed.
 * 
 * Usage:
 *   import { api } from '@/lib/api';
 *   const data = await api.get('/api/signals');
 *   const result = await api.post('/api/signals/request', { pair: 'EUR/USD OTC' });
 */

import { getApiUrl } from './api-config';

const API_BASE_URL = getApiUrl();

class ApiClient {
  private baseUrl: string;
  
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }
  
  /**
   * Get standard headers. Auth is handled via httpOnly cookies
   * (sent automatically with credentials: 'include').
   */
  private getHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
    };
  }
  
  /**
   * GET request
   */
  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.getHeaders(),
      credentials: 'include',
    });
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
      credentials: 'include',
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
      credentials: 'include',
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
      credentials: 'include',
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
      credentials: 'include',
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
