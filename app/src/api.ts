import { createClient, createConfig } from '@gopherex/errotel-api'
export function apiClient(token: string) {
  return createClient(
    createConfig({ baseUrl: location.origin, headers: { Authorization: `Bearer ${token}` } })
  )
}
export type ApiClient = ReturnType<typeof apiClient>
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'code' in error)
    return String(error.code).replaceAll('_', ' ')
  return 'Request failed. Check the connection and try again.'
}
export function timeLabel(value: string) {
  try {
    return new Date(Number(BigInt(value) / 1_000_000n))
      .toISOString()
      .replace('T', ' ')
      .replace('Z', '')
  } catch {
    return value
  }
}
