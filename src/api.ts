export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message) }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (/^\/(?:conversations|decks)(?:\/|$)/.test(path) && !(path.endsWith('/chat') && options.method === 'POST')) {
    try {
      const { localApi } = await import('./local-api')
      return await localApi(path, options) as T
    } catch (error) {
      if (error instanceof WorkspaceError) throw new ApiError(error.message, error.status)
      if (error instanceof z.ZodError) throw new ApiError(error.message, 400)
      if (error instanceof DOMException && error.name === 'QuotaExceededError') throw new ApiError('Browser storage is full. Export a backup and free space before saving again.', 507)
      throw new ApiError(`Browser storage failed: ${error instanceof Error ? error.message : String(error)}`, 500)
    }
  }
  const response = await fetch(`/api${path}`, {
    ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    signal: options.signal ?? AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new ApiError(body.error || `HTTP ${response.status}`, response.status)
  }
  return response.json()
}
import { WorkspaceError } from '../shared/browser-storage'
import { z } from 'zod'
