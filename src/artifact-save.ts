import { api } from './api'

export class UnknownSaveOutcome extends Error {}
export async function saveWithReceipt(base: string, body: string, commandId: string): Promise<{ revision: number }> {
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await api<{ revision: number }>(base, { method: 'PUT', body }) }
    catch (e) { failure = e }
  }
  try {
    const result = await api<{ committed: { revision: number } | null }>(`${base}/commands/${commandId}`)
    if (result.committed) return result.committed
  } catch {
    throw new UnknownSaveOutcome('Save outcome unknown. Editing is paused; reload when the server is reachable.')
  }
  throw failure
}
