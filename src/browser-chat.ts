import { browserChatSchema, type BrowserChatRequest } from '../shared/browser-chat'
import type { WorkspaceMessage } from '../shared/artifacts'
import type { CommentHandoff } from '../shared/comments'
import type { ToolResult } from '../shared/model'
import { browserStore, type BrowserStore } from './local-store'

export async function prepareBrowserChat(conversationId: string, message: string, artifactId: string | undefined, previous: WorkspaceMessage[], handoff?: CommentHandoff): Promise<BrowserChatRequest> {
  const conversation = await browserStore.conversation(conversationId)
  const history: { role: 'user' | 'assistant'; content: string }[] = []
  let budget = 120000
  for (const item of previous.slice(-40).reverse()) {
    if (!item.content) continue
    const content = item.content.length <= 60000 ? item.content : item.content.slice(0, 59950) + '\n[Earlier message shortened for context.]'
    if (content.length > budget) break
    history.unshift({ role: item.role, content }); budget -= content.length
  }
  if (handoff && !artifactId) throw new Error('A comment handoff requires an active artifact.')
  return browserChatSchema.parse({
    message, artifactId, history, artifacts: conversation.artifacts,
    handoff: handoff ? await browserStore.handoff(conversationId, artifactId!, handoff.commentThreadId, handoff.expectedCommentVersion) : undefined,
  })
}
export async function committedBrowserResult(conversationId: string, artifactId: string, commandId: string, result: ToolResult): Promise<ToolResult> {
  if (!result.ok) return result
  const receipt = await browserStore.receipt(conversationId, artifactId, commandId)
  if (!receipt) return { ok: false, error: 'No matching durable browser commit was found.' }
  const artifact = await browserStore.open(conversationId, artifactId)
  return { ok: true, data: { artifactId, id: artifactId, kind: artifact.kind, title: artifact.value.snapshot.title, revision: receipt.revision, durable: true, commandId } }
}
export class MessageWriter {
  private tail: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private failure?: unknown
  private dirty = false
  constructor(private conversationId: string, private id: string, private current: () => WorkspaceMessage, private onError: (error: unknown) => void, private storage: Pick<BrowserStore, 'putMessage'> = browserStore) {}
  changed() {
    this.dirty = true
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => { /* onError surfaces the persistence failure. */ }) }, 250)
  }
  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined
    if (this.failure) return Promise.reject(this.failure)
    if (!this.dirty) return this.tail
    this.dirty = false
    const snapshot: WorkspaceMessage = JSON.parse(JSON.stringify(this.current()))
    this.tail = this.tail.then(async () => { await this.storage.putMessage(this.conversationId, this.id, snapshot) })
    void this.tail.catch(error => { if (!this.failure) { this.failure = error; this.onError(error) } })
    return this.tail
  }
}
