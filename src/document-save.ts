import { textSnapshotSchema, type TextSnapshot } from '../shared/rich-text'

export class DocumentSaveQueue {
  private pending: unknown[] = []
  private inFlight?: Promise<void>
  revision: number
  saved: TextSnapshot

  constructor(snapshot: TextSnapshot, revision: number, private persist: (body: string, commandId: string) => Promise<{ revision: number }>) {
    this.saved = textSnapshotSchema.parse(snapshot)
    this.revision = revision
  }
  get steps(): readonly unknown[] { return this.pending }
  append(steps: unknown[]) { this.pending.push(...steps) }
  reset(snapshot: TextSnapshot, revision: number) {
    if (this.inFlight) throw new Error('Cannot reset a document while a save is pending.')
    this.saved = textSnapshotSchema.parse(snapshot)
    this.revision = revision
    this.pending = []
  }
  save(snapshot: TextSnapshot): Promise<void> {
    if (this.inFlight) return this.inFlight
    const submitted = textSnapshotSchema.parse(snapshot)
    const count = this.pending.length
    const commandId = crypto.randomUUID()
    // Freeze exactly this prefix; later transactions remain relative to the newly saved revision.
    const body = JSON.stringify({ expectedRevision: this.revision, commandId, snapshot: submitted, steps: this.pending.slice(0, count) })
    const request = Promise.resolve().then(() => this.persist(body, commandId)).then(result => {
      this.revision = result.revision
      this.saved = submitted
      this.pending.splice(0, count)
    })
    this.inFlight = request.finally(() => { this.inFlight = undefined })
    return this.inFlight
  }
}
