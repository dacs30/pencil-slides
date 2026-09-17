import { z } from 'zod'
import { browserStore } from './local-store'
import { WorkspaceError } from '../shared/browser-storage'
import { createArtifactSchema, restoreWorkspaceMessage } from '../shared/artifacts'
import { snapshotSchema } from '../shared/model'

export async function localApi(path: string, options: RequestInit = {}): Promise<unknown> {
  const method = options.method ?? 'GET'
  if (options.body !== undefined && typeof options.body !== 'string') throw new WorkspaceError('Local workspace requests must contain JSON.')
  const body: unknown = options.body ? JSON.parse(String(options.body)) : undefined
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  if (parts[0] === 'decks') {
    if (parts.length === 1 && method === 'POST') {
      const snapshot = snapshotSchema.parse(body)
      const [conversationId] = await browserStore.importBackup({
        version: 1, conversations: [{ title: snapshot.title, artifacts: [{ artifact: { kind: 'slides', value: { id: crypto.randomUUID(), revision: 0, snapshot } }, comments: [] }], messages: [] }],
      })
      const conversation = await browserStore.conversation(conversationId!)
      return (await browserStore.open(conversation.id, conversation.artifacts[0]!.id)).value
    }
    if (parts.length === 1 && method === 'GET') {
      return (await browserStore.conversations()).flatMap(c => c.artifacts.filter(a => a.kind === 'slides'))
    }
    const artifactId = parts[1]
    if (!artifactId) throw new WorkspaceError('Use the conversation workspace to create a deck.')
    const conversationId = await browserStore.owner(artifactId)
    const artifact = await browserStore.open(conversationId, artifactId)
    if (artifact.kind !== 'slides') throw new WorkspaceError('Expected a slide deck.')
    if (parts[2] === 'chat' && parts.length === 3 && method === 'GET') {
      return (await browserStore.messages(conversationId)).map(restoreWorkspaceMessage).map(message => ({
        ...message,
        artifacts: message.artifacts?.filter(a => a.id === artifactId && a.kind === 'slides').map(a => ({ title: a.title, revision: a.revision, slideIds: artifact.value.snapshot.slides.map(s => s.id) })),
      }))
    }
    if (parts.length === 2 && method === 'GET') return artifact.value
    return localApi(`/conversations/${conversationId}/artifacts/${artifactId}${parts.length > 2 ? '/' + parts.slice(2).join('/') : ''}`, options)
  }
  if (parts[0] !== 'conversations') throw new WorkspaceError('Unknown local route.', 404)
  if (parts.length === 1) {
    if (method === 'GET') return browserStore.conversations()
    if (method === 'POST') return browserStore.createConversation()
  }
  const conversationId = parts[1]
  if (!conversationId) throw new WorkspaceError('Conversation ID is required.')
  if (parts.length === 2 && method === 'GET') return browserStore.conversation(conversationId)
  if (parts[2] === 'messages') {
    if (parts.length === 3 && method === 'GET') return browserStore.messages(conversationId)
    if (parts.length === 4 && method === 'PUT') return browserStore.putMessage(conversationId, parts[3]!, body)
  }
  if (parts[2] === 'artifacts') {
    if (parts.length === 3 && method === 'POST') {
      const input = createArtifactSchema.extend({ commandId: z.string().min(1).max(120) }).parse(body)
      return browserStore.createArtifact(conversationId, { kind: input.kind, title: input.title }, input.commandId)
    }
    const artifactId = parts[3]
    if (!artifactId) throw new WorkspaceError('Artifact ID is required.')
    if (parts.length === 4 && method === 'GET') return browserStore.open(conversationId, artifactId)
    if (parts.length === 4 && method === 'PUT') return browserStore.save(conversationId, artifactId, body)
    if (parts[4] === 'commands' && parts.length === 6 && method === 'GET') return { committed: await browserStore.receipt(conversationId, artifactId, parts[5]!) }
    if (parts[4] === 'comments') {
      if (parts.length === 5 && method === 'GET') return (await browserStore.comments(conversationId, artifactId)).map(c => c.thread)
      if (parts.length === 5 && method === 'POST') return browserStore.comment(conversationId, artifactId, body)
      if (parts.length === 6 && method === 'PATCH') return browserStore.updateComment(conversationId, artifactId, parts[5]!, body, false)
      if (parts.length === 7 && parts[6] === 'replies' && method === 'POST') return browserStore.updateComment(conversationId, artifactId, parts[5]!, body, true)
    }
  }
  throw new WorkspaceError('Unknown local workspace operation.', 404)
}
