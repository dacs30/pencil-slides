import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { snapshotSchema, type Deck, type Snapshot } from '../shared/model.js'
import type { ChatDetails, ChatMessage } from '../shared/chat.js'
import { initializeComments, reconcileCommentAnchors } from './comments.js'
import { initializeWorkspace } from './workspace-store.js'

export class Conflict extends Error {}
export class Store {
  db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS decks(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, deck_id TEXT NOT NULL REFERENCES decks(id), hash TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY, deck_id TEXT NOT NULL REFERENCES decks(id), role TEXT NOT NULL, content TEXT NOT NULL);`)
    const columns = this.db.prepare('PRAGMA table_info(chat)').all() as { name: string }[]
    if (!columns.some(column => column.name === 'details')) this.db.exec("ALTER TABLE chat ADD COLUMN details TEXT NOT NULL DEFAULT '{}'")
    initializeComments(this.db)
    initializeWorkspace(this.db)
  }
  list() {
    return (this.db.prepare('SELECT id, revision, snapshot, updated FROM decks ORDER BY updated DESC').all() as unknown as { id: string; revision: number; snapshot: string; updated: string }[])
      .map(r => ({ id: r.id, revision: r.revision, title: JSON.parse(r.snapshot).title, updated: r.updated }))
  }
  get(id: string): Deck {
    const r = this.db.prepare('SELECT revision,snapshot FROM decks WHERE id=?').get(id) as { revision: number; snapshot: string } | undefined
    if (!r) throw new Error('Deck not found')
    return { id, revision: r.revision, snapshot: JSON.parse(r.snapshot) }
  }
  create(snapshot: Snapshot) {
    snapshot = snapshotSchema.parse(snapshot)
    const id = randomUUID()
    this.db.prepare('INSERT INTO decks VALUES(?,?,?,?)').run(id, 0, JSON.stringify(snapshot), new Date().toISOString())
    return this.get(id)
  }
  save(id: string, expectedRevision: number, snapshot: Snapshot, commandId: string) {
    snapshot = snapshotSchema.parse(snapshot)
    const json = JSON.stringify(snapshot)
    const hash = createHash('sha256').update(JSON.stringify([id, expectedRevision, json])).digest('hex')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.db.prepare('SELECT hash, revision FROM commands WHERE id=?').get(commandId) as { hash: string; revision: number } | undefined
      if (prior) {
        if (prior.hash !== hash) throw new Conflict('Command ID was already used with different content')
        this.db.exec('COMMIT')
        return { revision: prior.revision }
      }
      const result = this.db.prepare('UPDATE decks SET revision=revision+1,snapshot=?,updated=? WHERE id=? AND revision=?')
        .run(json, new Date().toISOString(), id, expectedRevision)
      if (result.changes !== 1) throw new Conflict('Revision conflict. Reload the deck before editing.')
      const revision = expectedRevision + 1
      this.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(commandId, id, hash, revision)
      reconcileCommentAnchors(this.db, id, snapshot)
      this.db.exec('COMMIT')
      return { revision }
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  committed(commandId: string, deckId: string) {
    return this.db.prepare('SELECT revision FROM commands WHERE id=? AND deck_id=?').get(commandId, deckId) as { revision: number } | undefined
  }
  messages(id: string) {
    const rows = this.db.prepare('SELECT role,content,details FROM (SELECT id,role,content,details FROM chat WHERE deck_id=? ORDER BY id DESC LIMIT 40) ORDER BY id').all(id) as unknown as { role: ChatMessage['role']; content: string; details: string }[]
    return rows.map(({ role, content, details }): ChatMessage => ({ role, content, ...JSON.parse(details) }))
  }
  append(id: string, role: string, content: string, details: ChatDetails = {}) {
    this.db.prepare('INSERT INTO chat(deck_id,role,content,details) VALUES(?,?,?,?)').run(id, role, content, JSON.stringify(details))
  }
  close() { this.db.close() }
}
