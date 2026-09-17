import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import { z } from 'zod'
import { snapshotSchema, saveSchema } from '../shared/model'
import { textSnapshotSchema, replayTextSteps, mapTextAnchor, richSchema, blankDocument } from '../shared/rich-text'
import { pageSaveSchema, pageSnapshotSchema } from '../shared/page'
import { createCommentSchema, createPageCommentSchema, replyCommentSchema, resolveCommentSchema } from '../shared/comments'
import { textCommentSchema } from '../shared/text-comments'
import { createArtifactSchema, normalizeArtifactCards, type Conversation, type OpenArtifact, type ArtifactInfo, type WorkspaceMessage } from '../shared/artifacts'
import { openArtifactSchema, workspaceMessageSchema, workspaceBackupSchema, WorkspaceError, type StoredComment, type WorkspaceBackup } from '../shared/browser-storage'
import { blankDeck } from './document'
import { blankPage } from './page-document'
import { createLocalComment, reconcileCanvasComments, commentHandoff, commentCreationIdentity, commentOwner } from './local-comments'

type ConversationRecord = { id: string; title: string; createdAt: number; sequence: number }
type ArtifactRecord = { conversationId: string; artifact: OpenArtifact; order: number }
type MessageRecord = { id: string; conversationId: string; sequence: number; message: WorkspaceMessage }
type CommentRecord = { id: string; artifactId: string; comment: StoredComment; creationHash: string; order: number }
type Receipt = { commandId: string; conversationId: string; artifactId: string; hash: string; revision: number; result?: ArtifactInfo }
interface PencilDB extends DBSchema {
  conversations: { key: string; value: ConversationRecord }
  artifacts: { key: string; value: ArtifactRecord; indexes: { conversation: string } }
  messages: { key: string; value: MessageRecord; indexes: { conversation: string } }
  comments: { key: string; value: CommentRecord; indexes: { artifact: string } }
  receipts: { key: string; value: Receipt }
}
const stores = ['conversations', 'artifacts', 'messages', 'comments', 'receipts'] as const
type WriteTransaction = IDBPTransaction<PencilDB, typeof stores, 'readwrite'>
const textSaveSchema = z.object({ expectedRevision: z.number().int().nonnegative(), commandId: z.string().min(1).max(120), snapshot: textSnapshotSchema, steps: z.array(z.unknown()).max(2000) }).strict()
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}
function owned(record: ArtifactRecord | undefined, conversationId: string): OpenArtifact {
  if (!record || record.conversationId !== conversationId) throw new WorkspaceError('Artifact not found in this browser conversation.', 404)
  return openArtifactSchema.parse(record.artifact)
}
function info(artifact: OpenArtifact): ArtifactInfo { return { id: artifact.value.id, kind: artifact.kind, title: artifact.value.snapshot.title, revision: artifact.value.revision } }
function commentRecordMatches(record: CommentRecord | undefined, artifactId: string): CommentRecord {
  if (!record || record.artifactId !== artifactId) throw new WorkspaceError('Comment not found in this artifact.', 404)
  return record
}
export class BrowserStore {
  private connection?: Promise<IDBPDatabase<PencilDB>>
  constructor(readonly name = 'pencil-workspace-v1') {}
  private db() {
    if (typeof window !== 'undefined' && !window.isSecureContext) throw new WorkspaceError('Use HTTPS or localhost for browser workspace storage.', 503)
    if (!globalThis.indexedDB) throw new WorkspaceError('Browser storage is unavailable. Use HTTPS or localhost and allow site storage.', 503)
    return this.connection ??= openDB<PencilDB>(this.name, 1, {
      upgrade(db) {
        db.createObjectStore('conversations', { keyPath: 'id' })
        db.createObjectStore('artifacts', { keyPath: 'artifact.value.id' }).createIndex('conversation', 'conversationId')
        db.createObjectStore('messages', { keyPath: 'id' }).createIndex('conversation', 'conversationId')
        db.createObjectStore('comments', { keyPath: 'id' }).createIndex('artifact', 'artifactId')
        db.createObjectStore('receipts', { keyPath: 'commandId' })
      },
      blocking: () => { void this.connection?.then(db => db.close()) },
    })
  }
  async close() { if (this.connection) (await this.connection).close() }
  private async write<T>(action: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    const tx = (await this.db()).transaction(stores, 'readwrite', { durability: 'strict' })
    try { const result = await action(tx); await tx.done; return result }
    catch (error) {
      try { tx.abort() } catch (abortError) { if (!(abortError instanceof DOMException && abortError.name === 'InvalidStateError')) throw abortError }
      await tx.done.catch(() => { /* Preserve the original transaction failure. */ })
      throw error
    }
  }
  async createConversation(title = 'New conversation'): Promise<Conversation> {
    const record: ConversationRecord = { id: crypto.randomUUID(), title: z.string().trim().min(1).max(200).parse(title), createdAt: Date.now(), sequence: 0 }
    await (await this.db()).add('conversations', record)
    return { id: record.id, title: record.title, artifacts: [] }
  }
  async conversations(): Promise<Conversation[]> {
    const records = await (await this.db()).getAll('conversations')
    return Promise.all(records.sort((a, b) => b.createdAt - a.createdAt).map(c => this.conversation(c.id)))
  }
  async conversation(id: string): Promise<Conversation> {
    const tx = (await this.db()).transaction(['conversations', 'artifacts'])
    const record = await tx.objectStore('conversations').get(id)
    if (!record) throw new WorkspaceError('Conversation not found in this browser.', 404)
    const artifacts = await tx.objectStore('artifacts').index('conversation').getAll(id)
    return { id, title: record.title, artifacts: artifacts.sort((a, b) => a.order - b.order).map(a => info(a.artifact)) }
  }
  async open(conversationId: string, artifactId: string) { return owned(await (await this.db()).get('artifacts', artifactId), conversationId) }
  async owner(artifactId: string) {
    const record = await (await this.db()).get('artifacts', artifactId)
    if (!record) throw new WorkspaceError('Artifact not found in this browser.', 404)
    return record.conversationId
  }
  async createArtifact(conversationId: string, raw: unknown, commandId: string): Promise<ArtifactInfo> {
    const input = createArtifactSchema.parse(raw)
    z.string().min(1).max(120).parse(commandId)
    const hash = await digest(['create', conversationId, input])
    const id = crypto.randomUUID()
    const artifact: OpenArtifact = input.kind === 'slides'
      ? { kind: 'slides', value: { id, revision: 0, snapshot: { ...blankDeck(), title: input.title } } }
      : input.kind === 'page' ? { kind: 'page', value: { id, revision: 0, snapshot: blankPage(input.title) } }
        : { kind: 'document', value: { id, revision: 0, snapshot: blankDocument(input.title) } }
    return this.write(async tx => {
      const receipt = await tx.objectStore('receipts').get(commandId)
      if (receipt) {
        if (receipt.hash !== hash || !receipt.result) throw new WorkspaceError('Command ID already used with different content.', 409)
        return receipt.result
      }
      if (!await tx.objectStore('conversations').get(conversationId)) throw new WorkspaceError('Conversation not found.', 404)
      const order = await tx.objectStore('artifacts').index('conversation').count(conversationId)
      if (order >= 100) throw new WorkspaceError('Limit reached: 100 artifacts per conversation.')
      const result = info(artifact)
      await tx.objectStore('artifacts').add({ conversationId, artifact, order })
      await tx.objectStore('receipts').add({ commandId, conversationId, artifactId: id, revision: 0, hash, result })
      return result
    })
  }
  async receipt(conversationId: string, artifactId: string, commandId: string) {
    await this.open(conversationId, artifactId)
    const receipt = await (await this.db()).get('receipts', commandId)
    return receipt?.conversationId === conversationId && receipt.artifactId === artifactId ? { revision: receipt.revision } : null
  }
  async save(conversationId: string, artifactId: string, raw: unknown) {
    const artifact = await this.open(conversationId, artifactId)
    const input = artifact.kind === 'document' ? textSaveSchema.parse(raw) : artifact.kind === 'page' ? pageSaveSchema.parse(raw) : saveSchema.parse(raw)
    const hash = await digest(['save', artifactId, input])
    return this.write(async tx => {
      const prior = await tx.objectStore('receipts').get(input.commandId)
      if (prior) {
        if (prior.hash !== hash || prior.artifactId !== artifactId || prior.conversationId !== conversationId) throw new WorkspaceError('Command ID already used with different content.', 409)
        return { revision: prior.revision }
      }
      const record = await tx.objectStore('artifacts').get(artifactId)
      const current = owned(record, conversationId)
      if (current.value.revision !== input.expectedRevision) throw new WorkspaceError('Revision conflict. Another tab changed this artifact; reload before editing.', 409)
      const revision = current.value.revision + 1
      const commentRecords = await tx.objectStore('comments').index('artifact').getAll(artifactId)
      let next: OpenArtifact
      if (current.kind === 'document') {
        const parsed = textSaveSchema.parse(input), replay = replayTextSteps(current.value.snapshot, parsed.steps)
        if (replay.title !== parsed.snapshot.title || !replay.doc.eq(richSchema.nodeFromJSON(parsed.snapshot.content))) throw new WorkspaceError('Document snapshot does not match its transaction steps.')
        next = { kind: 'document', value: { id: artifactId, revision, snapshot: parsed.snapshot } }
        for (const record of commentRecords) {
          if (record.comment.kind !== 'document') throw new WorkspaceError('Stored comment type mismatch.')
          const anchor = mapTextAnchor(record.comment.thread.anchor, replay.maps)
          if (JSON.stringify(anchor) !== JSON.stringify(record.comment.thread.anchor)) {
            record.comment.thread.anchor = anchor; record.comment.thread.version++
            await tx.objectStore('comments').put(record)
          }
        }
      } else {
        next = current.kind === 'page'
          ? { kind: 'page', value: { id: artifactId, revision, snapshot: pageSnapshotSchema.parse(input.snapshot) } }
          : { kind: 'slides', value: { id: artifactId, revision, snapshot: snapshotSchema.parse(input.snapshot) } }
        if (commentRecords.length) {
          const reconciled = reconcileCanvasComments(next, commentRecords.map(r => r.comment))
          for (const [i, record] of commentRecords.entries()) await tx.objectStore('comments').put({ ...record, comment: reconciled[i]! })
        }
      }
      await tx.objectStore('artifacts').put({ conversationId, artifact: next, order: record!.order })
      await tx.objectStore('receipts').add({ commandId: input.commandId, conversationId, artifactId, hash, revision })
      return { revision }
    })
  }
  async messages(conversationId: string): Promise<WorkspaceMessage[]> {
    await this.conversation(conversationId)
    const records = await (await this.db()).getAllFromIndex('messages', 'conversation', conversationId)
    return records.sort((a, b) => a.sequence - b.sequence).slice(-100).map(r => normalizeArtifactCards(r.message))
  }
  async putMessage(conversationId: string, id: string, raw: unknown) {
    z.string().min(1).max(120).parse(id)
    const message = normalizeArtifactCards(workspaceMessageSchema.parse(clone(raw)))
    return this.write(async tx => {
      const conversation = await tx.objectStore('conversations').get(conversationId)
      if (!conversation) throw new WorkspaceError('Conversation not found.', 404)
      const existing = await tx.objectStore('messages').get(id)
      if (existing && existing.conversationId !== conversationId) throw new WorkspaceError('Message belongs to another conversation.', 409)
      if (existing) await tx.objectStore('messages').put({ ...existing, message })
      else {
        await tx.objectStore('messages').add({ id, conversationId, sequence: conversation.sequence++, message })
        if (message.role === 'user' && conversation.title === 'New conversation') conversation.title = message.content.slice(0, 80) || conversation.title
        await tx.objectStore('conversations').put(conversation)
      }
      return { id }
    })
  }
  async comments(conversationId: string, artifactId: string): Promise<StoredComment[]> {
    await this.open(conversationId, artifactId)
    return (await (await this.db()).getAllFromIndex('comments', 'artifact', artifactId)).sort((a, b) => a.order - b.order).map(r => r.comment)
  }
  async comment(conversationId: string, artifactId: string, raw: unknown) {
    const artifact = await this.open(conversationId, artifactId)
    const input = artifact.kind === 'document' ? textCommentSchema.parse(raw) : artifact.kind === 'page' ? createPageCommentSchema.parse(raw) : createCommentSchema.parse(raw)
    const identity = 'anchor' in input ? { artifactId, anchor: input.anchor, body: input.body } : { artifactId, from: input.from, to: input.to, body: input.body }
    const hash = await digest(identity)
    return this.write(async tx => {
      const previous = await tx.objectStore('comments').get(input.id)
      if (previous) {
        if (previous.artifactId !== artifactId || previous.creationHash !== hash) throw new WorkspaceError('Comment ID used with different content.', 409)
        return previous.comment.thread
      }
      const current = owned(await tx.objectStore('artifacts').get(artifactId), conversationId)
      const order = await tx.objectStore('comments').index('artifact').count(artifactId)
      if (order >= 100) throw new WorkspaceError('Limit reached: 100 threads per artifact.')
      const comment = createLocalComment(current, input)
      await tx.objectStore('comments').add({ id: comment.thread.id, artifactId, comment, creationHash: hash, order })
      return comment.thread
    })
  }
  async updateComment(conversationId: string, artifactId: string, threadId: string, raw: unknown, reply: boolean) {
    const input = reply ? replyCommentSchema.parse(raw) : resolveCommentSchema.parse(raw)
    return this.write(async tx => {
      owned(await tx.objectStore('artifacts').get(artifactId), conversationId)
      const record = commentRecordMatches(await tx.objectStore('comments').get(threadId), artifactId), thread = record.comment.thread
      if ('body' in input) {
        const previous = thread.messages.find(m => m.id === input.id)
        if (previous) {
          if (previous.body !== input.body) throw new WorkspaceError('Reply ID used with different content.', 409)
          return thread
        }
        if (thread.resolved || thread.version !== input.expectedVersion) throw new WorkspaceError('Thread changed or resolved. Refresh comments.', 409)
        if (thread.messages.length >= 50) throw new WorkspaceError('Limit reached: 50 messages per thread.')
        if (record.comment.kind === 'canvas') record.comment.thread.messages.push({ id: input.id, body: input.body, createdAt: new Date().toISOString() })
        else record.comment.thread.messages.push({ id: input.id, body: input.body })
      } else {
        if (thread.resolved === input.resolved && thread.version === input.expectedVersion + 1) return thread
        if (thread.version !== input.expectedVersion) throw new WorkspaceError('Thread changed. Refresh comments.', 409)
        thread.resolved = input.resolved
      }
      thread.version++
      if (record.comment.kind === 'canvas') record.comment.thread.updatedAt = new Date().toISOString()
      await tx.objectStore('comments').put(record)
      return thread
    })
  }
  async handoff(conversationId: string, artifactId: string, threadId: string, expectedVersion: number) {
    const artifact = await this.open(conversationId, artifactId)
    const record = commentRecordMatches(await (await this.db()).get('comments', threadId), artifactId)
    return commentHandoff(artifact, record.comment, expectedVersion)
  }
  async exportBackup(): Promise<WorkspaceBackup> {
    const tx = (await this.db()).transaction(stores)
    const [conversations, artifacts, comments, messages] = await Promise.all([
      tx.objectStore('conversations').getAll(), tx.objectStore('artifacts').getAll(),
      tx.objectStore('comments').getAll(), tx.objectStore('messages').getAll(),
    ])
    return {
      version: 1, conversations: conversations.map(c => ({
        title: c.title,
        artifacts: artifacts.filter(a => a.conversationId === c.id).sort((a, b) => a.order - b.order).map(a => ({ artifact: a.artifact, comments: comments.filter(t => t.artifactId === a.artifact.value.id).sort((a, b) => a.order - b.order).map(t => t.comment) })),
        messages: messages.filter(m => m.conversationId === c.id).sort((a, b) => a.sequence - b.sequence).map(m => normalizeArtifactCards(m.message)),
      })),
    }
  }
  async importBackup(raw: unknown): Promise<string[]> {
    const safe = JSON.parse(JSON.stringify(raw), (key, value: unknown) => {
      if (key === '__proto__') throw new WorkspaceError('Backup contains an unsafe object property.')
      return value
    })
    const backup = workspaceBackupSchema.parse(safe)
    const imported: { conversation: ConversationRecord; artifacts: ArtifactRecord[]; comments: CommentRecord[]; messages: MessageRecord[] }[] = []
    for (const source of backup.conversations) {
      const conversation: ConversationRecord = { id: crypto.randomUUID(), title: source.title, createdAt: Date.now(), sequence: source.messages.length }
      const ids = new Map<string, string>(), artifacts: ArtifactRecord[] = [], comments: CommentRecord[] = []
      for (const item of source.artifacts) {
        const oldId = item.artifact.value.id
        if (ids.has(oldId)) throw new WorkspaceError('Backup has duplicate artifact IDs.')
        const id = crypto.randomUUID(); ids.set(oldId, id)
        const artifact = clone(item.artifact); artifact.value.id = id
        artifacts.push({ conversationId: conversation.id, artifact, order: artifacts.length })
        for (const [order, value] of item.comments.entries()) {
          if (commentOwner(value) !== oldId || (artifact.kind === 'document') !== (value.kind === 'document')) throw new WorkspaceError('Backup comment belongs to a different artifact.')
          const comment = clone(value), threadId = crypto.randomUUID()
          comment.thread.id = threadId
          if (comment.kind === 'document') comment.thread.documentId = id
          else comment.thread.deckId = id
          for (const [i, message] of comment.thread.messages.entries()) message.id = i ? crypto.randomUUID() : threadId
          comments.push({ id: threadId, artifactId: id, comment, creationHash: await digest(commentCreationIdentity(comment)), order })
        }
      }
      const messages = source.messages.map((message, sequence) => {
        const next = clone(message)
        if (next.artifacts) next.artifacts = next.artifacts.map(card => {
          const id = ids.get(card.id)
          if (!id || artifacts.find(a => a.artifact.value.id === id)?.artifact.kind !== card.kind) throw new WorkspaceError('Backup card references a missing or mismatched artifact.')
          return { ...card, id }
        })
        return { id: crypto.randomUUID(), conversationId: conversation.id, sequence, message: normalizeArtifactCards(next) }
      })
      imported.push({ conversation, artifacts, comments, messages })
    }
    await this.write(async tx => {
      for (const item of imported) {
        await tx.objectStore('conversations').add(item.conversation)
        for (const record of item.artifacts) await tx.objectStore('artifacts').add(record)
        for (const record of item.comments) await tx.objectStore('comments').add(record)
        for (const record of item.messages) await tx.objectStore('messages').add(record)
      }
    })
    return imported.map(item => item.conversation.id)
  }
}
export const browserStore = new BrowserStore()
