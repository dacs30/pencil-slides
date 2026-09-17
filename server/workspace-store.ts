import { randomUUID, createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { Store } from './store.js'
import { CommentError, initializeComments, reconcileCommentAnchors, pageCommentSnapshot } from './comments.js'
import { blankDeck } from '../src/document.js'
import { blankDocument, textSnapshotSchema, replayTextSteps, mapTextAnchor, richSchema } from '../shared/rich-text.js'
import type { ArtifactInfo, ArtifactKind, Conversation, TextDocument, WorkspaceMessage, OpenArtifact } from '../shared/artifacts.js'
import { normalizeArtifactCards } from '../shared/artifacts.js'
import { textCommentSchema, type TextThread } from '../shared/text-comments.js'
import { replyCommentSchema, resolveCommentSchema } from '../shared/comments.js'
import { pageSaveSchema, type PageArtifact } from '../shared/page.js'
import { blankPage } from '../src/page-document.js'

export function initializeWorkspace(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS artifact_links(id TEXT PRIMARY KEY, kind TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id));
    CREATE TABLE IF NOT EXISTS conversation_chat(id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), message TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS artifact_commands(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, artifact_id TEXT NOT NULL, hash TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS text_threads(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), thread TEXT NOT NULL, request TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS artifacts_by_conversation ON artifact_links(conversation_id);
    CREATE INDEX IF NOT EXISTS chat_by_conversation ON conversation_chat(conversation_id);`)
  initializeComments(db, true)
  db.exec('BEGIN IMMEDIATE')
  try {
    const decks = db.prepare('SELECT id,snapshot FROM decks WHERE id NOT IN (SELECT id FROM artifact_links)').all() as { id: string; snapshot: string }[]
    for (const deck of decks) {
      db.prepare('INSERT INTO conversations VALUES(?,?)').run(deck.id, JSON.parse(deck.snapshot).title)
      db.prepare("INSERT INTO artifact_links VALUES(?,'slides',?)").run(deck.id, deck.id)
      const messages = db.prepare('SELECT role,content,details FROM chat WHERE deck_id=? ORDER BY id').all(deck.id) as { role: string; content: string; details: string }[]
      for (const m of messages) {
        const details = JSON.parse(m.details)
        if (details.artifacts) details.artifacts = details.artifacts.map((a: { title: string; revision: number }) => ({ id: deck.id, kind: 'slides', title: a.title, revision: a.revision }))
        db.prepare('INSERT INTO conversation_chat(conversation_id,message) VALUES(?,?)').run(deck.id, JSON.stringify({ role: m.role, content: m.content, ...details }))
      }
    }
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}
export const textSaveSchema = z.object({
  expectedRevision: z.number().int().nonnegative(), commandId: z.string().min(1).max(120),
  snapshot: textSnapshotSchema, steps: z.array(z.unknown()).max(2000),
}).strict()
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
export class WorkspaceStore {
  constructor(readonly store: Store) {}
  get db() { return this.store.db }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = fn(); this.db.exec('COMMIT'); return value } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  createConversation(title = 'New conversation') {
    const id = randomUUID()
    this.db.prepare('INSERT INTO conversations VALUES(?,?)').run(id, title)
    return this.conversation(id)
  }
  conversations(): Conversation[] {
    return (this.db.prepare('SELECT id FROM conversations ORDER BY rowid DESC').all() as { id: string }[]).map(row => this.conversation(row.id))
  }
  conversation(id: string): Conversation {
    const row = this.db.prepare('SELECT id,title FROM conversations WHERE id=?').get(id) as { id: string; title: string } | undefined
    if (!row) throw new CommentError('Conversation not found.', 404)
    const links = this.db.prepare('SELECT id,kind FROM artifact_links WHERE conversation_id=? ORDER BY rowid').all(id) as { id: string; kind: ArtifactKind }[]
    return { ...row, artifacts: links.map(link => {
      const { value } = this.open(id, link.id)
      return { ...link, title: value.snapshot.title, revision: value.revision }
    }) }
  }
  kind(conversationId: string, id: string): ArtifactKind {
    const row = this.db.prepare('SELECT kind FROM artifact_links WHERE conversation_id=? AND id=?').get(conversationId, id) as { kind: ArtifactKind } | undefined
    if (!row) throw new CommentError('Artifact not found in this conversation.', 404)
    return row.kind
  }
  open(conversationId: string, id: string): OpenArtifact {
    const kind = this.kind(conversationId, id)
    return kind === 'slides' ? { kind, value: this.store.get(id) } : kind === 'page' ? { kind, value: this.page(id) } : { kind, value: this.document(id) }
  }
  page(id: string): PageArtifact {
    const row = this.db.prepare('SELECT revision,snapshot FROM pages WHERE id=?').get(id) as { revision: number; snapshot: string } | undefined
    if (!row) throw new CommentError('Page not found.', 404)
    return { id, revision: row.revision, snapshot: JSON.parse(row.snapshot) }
  }
  document(id: string): TextDocument {
    const row = this.db.prepare('SELECT revision,snapshot FROM documents WHERE id=?').get(id) as { revision: number; snapshot: string } | undefined
    if (!row) throw new CommentError('Document not found.', 404)
    return { id, revision: row.revision, snapshot: JSON.parse(row.snapshot) }
  }
  createArtifact(conversationId: string, kind: ArtifactKind, title: string, commandId: string): ArtifactInfo {
    this.conversation(conversationId)
    const digest = hash([conversationId, kind, title])
    return this.transaction(() => {
      const prior = this.receipt(conversationId, commandId)
      if (prior) {
        if (prior.hash !== digest) throw new CommentError('Command ID used with different content.', 409)
        const opened = this.open(conversationId, prior.artifactId)
        return { id: prior.artifactId, kind: opened.kind, title: opened.value.snapshot.title, revision: prior.revision }
      }
      if (this.conversation(conversationId).artifacts.length >= 100) throw new CommentError('Limit reached: 100 artifacts per conversation.')
      const id = randomUUID()
      if (kind === 'document') this.db.prepare('INSERT INTO documents VALUES(?,0,?)').run(id, JSON.stringify(blankDocument(title)))
      else if (kind === 'page') this.db.prepare('INSERT INTO pages VALUES(?,0,?)').run(id, JSON.stringify(blankPage(title)))
      else this.db.prepare('INSERT INTO decks VALUES(?,0,?,?)').run(id, JSON.stringify({ ...blankDeck(), title }), new Date().toISOString())
      this.db.prepare('INSERT INTO artifact_links VALUES(?,?,?)').run(id, kind, conversationId)
      this.db.prepare('INSERT INTO artifact_commands VALUES(?,?,?,?,0)').run(commandId, conversationId, id, digest)
      return { id, kind, title, revision: 0 }
    })
  }
  receipt(conversationId: string, commandId: string) {
    return this.db.prepare('SELECT artifact_id AS artifactId,hash,revision FROM artifact_commands WHERE id=? AND conversation_id=?').get(commandId, conversationId) as { artifactId: string; hash: string; revision: number } | undefined
  }
  saveDocument(conversationId: string, id: string, raw: unknown) {
    if (this.kind(conversationId, id) !== 'document') throw new CommentError('Expected a document.')
    const input = textSaveSchema.parse(raw)
    const digest = hash([id, input])
    return this.transaction(() => {
      const prior = this.receipt(conversationId, input.commandId)
      if (prior) {
        if (prior.hash !== digest || prior.artifactId !== id) throw new CommentError('Command ID used with different content.', 409)
        return { revision: prior.revision }
      }
      const before = this.document(id)
      if (input.expectedRevision !== before.revision) throw new CommentError('Revision conflict. Reload the artifact before editing.', 409)
      let replay: ReturnType<typeof replayTextSteps>
      try { replay = replayTextSteps(before.snapshot, input.steps) }
      catch (e) { throw new CommentError(e instanceof Error ? e.message : 'Invalid document steps.') }
      const { doc, maps, title } = replay
      if (title !== input.snapshot.title || !doc.eq(richSchema.nodeFromJSON(input.snapshot.content))) throw new CommentError('Document snapshot does not match the submitted steps.')
      const revision = before.revision + 1
      this.db.prepare('UPDATE documents SET revision=?,snapshot=? WHERE id=?').run(revision, JSON.stringify(input.snapshot), id)
      for (const thread of this.threads(id)) {
        const mapped = mapTextAnchor(thread.anchor, maps)
        if (JSON.stringify(mapped) !== JSON.stringify(thread.anchor)) {
          thread.anchor = mapped
          thread.version++
          this.writeThread(thread)
        }
      }
      this.db.prepare('INSERT INTO artifact_commands VALUES(?,?,?,?,?)').run(input.commandId, conversationId, id, digest, revision)
      return { revision }
    })
  }
  savePage(conversationId: string, id: string, raw: unknown) {
    if (this.kind(conversationId, id) !== 'page') throw new CommentError('Expected a page.')
    const input = pageSaveSchema.parse(raw), digest = hash([id, input])
    return this.transaction(() => {
      const prior = this.receipt(conversationId, input.commandId)
      if (prior) {
        if (prior.hash !== digest || prior.artifactId !== id) throw new CommentError('Command ID used with different content.', 409)
        return { revision: prior.revision }
      }
      const result = this.db.prepare('UPDATE pages SET revision=revision+1,snapshot=? WHERE id=? AND revision=?')
        .run(JSON.stringify(input.snapshot), id, input.expectedRevision)
      if (result.changes !== 1) throw new CommentError('Revision conflict. Reload the page before editing.', 409)
      const revision = input.expectedRevision + 1
      reconcileCommentAnchors(this.db, id, pageCommentSnapshot(input.snapshot), true)
      this.db.prepare('INSERT INTO artifact_commands VALUES(?,?,?,?,?)').run(input.commandId, conversationId, id, digest, revision)
      return { revision }
    })
  }
  messages(id: string): WorkspaceMessage[] {
    this.conversation(id)
    return (this.db.prepare('SELECT message FROM (SELECT id,message FROM conversation_chat WHERE conversation_id=? ORDER BY id DESC LIMIT 100) ORDER BY id').all(id) as { message: string }[]).map(row => normalizeArtifactCards(JSON.parse(row.message)))
  }
  append(id: string, message: WorkspaceMessage) {
    this.db.prepare('INSERT INTO conversation_chat(conversation_id,message) VALUES(?,?)').run(id, JSON.stringify(normalizeArtifactCards(message)))
    if (message.role === 'user') this.db.prepare("UPDATE conversations SET title=? WHERE id=? AND title='New conversation'").run(message.content.slice(0, 80), id)
  }
  threads(documentId: string): TextThread[] {
    this.document(documentId)
    return (this.db.prepare('SELECT thread FROM text_threads WHERE document_id=? ORDER BY rowid').all(documentId) as { thread: string }[]).map(r => JSON.parse(r.thread))
  }
  thread(documentId: string, id: string) {
    const row = this.db.prepare('SELECT thread FROM text_threads WHERE document_id=? AND id=?').get(documentId, id) as { thread: string } | undefined
    if (!row) throw new CommentError('Comment not found in this document.', 404)
    return JSON.parse(row.thread) as TextThread
  }
  private writeThread(thread: TextThread) { this.db.prepare('UPDATE text_threads SET thread=? WHERE id=?').run(JSON.stringify(thread), thread.id) }
  comment(documentId: string, raw: unknown) {
    const input = textCommentSchema.parse(raw)
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT request,document_id FROM text_threads WHERE id=?').get(input.id) as { request: string; document_id: string } | undefined
      if (prior) {
        if (prior.request !== JSON.stringify(input) || prior.document_id !== documentId) throw new CommentError('Comment ID used with different content.', 409)
        return this.thread(documentId, input.id)
      }
      const current = this.document(documentId)
      if (current.revision !== input.expectedRevision) throw new CommentError('Document changed. Reload before commenting.', 409)
      if (this.threads(documentId).length >= 100) throw new CommentError('Limit reached: 100 comments per document.')
      const doc = richSchema.nodeFromJSON(current.snapshot.content)
      if (input.to > doc.content.size || input.from >= input.to) throw new CommentError('Invalid comment range.')
      const quote = doc.textBetween(input.from, input.to, '\n')
      if (!quote.trim() || quote.length > 2000) throw new CommentError('Select between 1 and 2,000 characters to comment.')
      const thread: TextThread = { id: input.id, documentId, version: 1, resolved: false, anchor: { from: input.from, to: input.to, quote, detached: false }, messages: [{ id: input.id, body: input.body }] }
      this.db.prepare('INSERT INTO text_threads VALUES(?,?,?,?)').run(input.id, documentId, JSON.stringify(thread), JSON.stringify(input))
      return thread
    })
  }
  updateThread(documentId: string, id: string, raw: unknown, reply: boolean) {
    return this.transaction(() => {
      const thread = this.thread(documentId, id)
      if (reply) {
        const input = replyCommentSchema.parse(raw)
        const prior = thread.messages.find(m => m.id === input.id)
        if (prior) {
          if (prior.body !== input.body) throw new CommentError('Reply ID used with different content.', 409)
          return thread
        }
        if (thread.resolved || thread.version !== input.expectedVersion) throw new CommentError('Thread changed or resolved. Refresh comments.', 409)
        if (thread.messages.length >= 50) throw new CommentError('Limit reached: 50 messages per thread.')
        thread.messages.push({ id: input.id, body: input.body })
      } else {
        const input = resolveCommentSchema.parse(raw)
        if (thread.version === input.expectedVersion + 1 && thread.resolved === input.resolved) return thread
        if (thread.version !== input.expectedVersion) throw new CommentError('Thread changed. Refresh comments.', 409)
        thread.resolved = input.resolved
      }
      thread.version++
      this.writeThread(thread)
      return thread
    })
  }
}
