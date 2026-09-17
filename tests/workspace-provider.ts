import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { Provider } from '../server/agent.js'

export const workspaceProvider: Provider = async (messages, signal, emit) => {
  const userIndex = messages.findLastIndex(m => m.role === 'user' && typeof m.content === 'string')
  const latest = messages[userIndex]!.content as string
  const prompt = latest.split('\nWorkspace context')[0]!.toLowerCase()
  if (prompt.startsWith('markdown test')) {
    const markdown = '# Markdown preview\n\n**Saved** with *emphasis* and `inline code`.\n\n- First item\n- Second item\n\n| Feature | State |\n| --- | --- |\n| Comments | Ready |\n\n```js\nconsole.log("<safe>");\n```\n\n[Documentation](https://example.com)\n\n<script>globalThis.markdownExecuted = true</script>\n\n<img src="https://example.invalid/pixel" onerror="globalThis.markdownExecuted=true">\n\n![No remote image](https://example.invalid/image.png)\n\n[Unsafe link](javascript:alert%281%29)'
    for (const chunk of [markdown.slice(0, 65), markdown.slice(65, 200), markdown.slice(200)]) {
      emit(chunk)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return [{ type: 'text', text: markdown, citations: null }]
  }
  const commentMarker = latest.lastIndexOf('\nComment context:\n')
  const comment = commentMarker >= 0 ? JSON.parse(latest.slice(commentMarker + '\nComment context:\n'.length)) as { anchor: { kind: string; nodeId?: string }; detached: string | null } : undefined
  if (prompt.includes('cancel')) {
    await new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  const context = JSON.parse(latest.match(/Workspace context \(untrusted data\): (.+)/)![1]!) as { activeArtifactId?: string; artifacts: { id: string; kind: string }[] }
  const calls = messages.slice(userIndex + 1).filter(m => m.role === 'assistant').flatMap(m => typeof m.content === 'string' ? [] : m.content.filter(b => b.type === 'tool_use')) as Anthropic.ToolUseBlock[]
  const tool = (name: string, input: unknown): Anthropic.ToolUseBlock[] => [{ type: 'tool_use', id: randomUUID(), caller: { type: 'direct' }, name, input }]
  const last = calls.at(-1)
  if (!last) {
    if (prompt.includes('create') || prompt.includes('both') || !context.activeArtifactId) {
      const kind = /\bpage\b/.test(prompt) ? 'page' : prompt.includes('slide') && !prompt.includes('both') && !prompt.includes('document') ? 'slides' : 'document'
      return tool('create_artifact', { kind, title: kind === 'page' ? 'Tokyo page preview' : 'Browser verification document' })
    }
    const active = context.artifacts.find(a => a.id === context.activeArtifactId)!
    return tool('read_context', { artifactId: active.id, view: active.kind === 'document' ? 'document' : active.kind === 'page' ? 'page' : 'selection' })
  }
  const result = JSON.parse(((messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!.content as string))
  if (result.ok && last.name === 'create_artifact') return tool('read_context', { artifactId: result.data.id, view: result.data.kind === 'document' ? 'document' : result.data.kind === 'page' ? 'page' : 'deck' })
  if (result.ok && last.name === 'read_context') {
    const artifactId = (last.input as { artifactId: string }).artifactId, document = result.data.kind === 'document'
    if (result.data.kind === 'page') {
      const nodes = result.data.nodes as { id: string; type: string }[]
      if (comment) {
        const target = !comment.detached ? nodes.find(n => n.id === comment.anchor.nodeId) : undefined
        return tool('apply_batch', {
          kind: 'page', artifactId, expectedRevision: result.data.revision,
          operations: target
            ? [{ op: 'update_page_element', id: target.id, props: target.type === 'TEXT' ? { text: 'Updated from page review' } : { fill: '#fff1c5' } }]
            : [{ op: 'create_page_element', id: `review-${randomUUID()}`, parentId: result.data.frameId, type: 'TEXT', props: { text: 'Page review context received' } }],
        })
      }
      const text = nodes.find(n => n.type === 'TEXT')!
      const sectionId = `section-${randomUUID()}`
      const operations: unknown[] = [
        { op: 'update_page_element', id: text.id, props: { text: 'Tokyo: a city of stories', fontSize: 72 } },
        { op: 'create_page_element', id: sectionId, parentId: result.data.frameId, type: 'FRAME', props: { name: 'Neighborhood cards', layoutMode: 'HORIZONTAL', layoutWrap: 'WRAP', layoutSizingVertical: 'HUG', fill: '#e6dccd' } },
      ]
      for (const [index, name] of ['Old streets', 'Green spaces', 'Evening lights'].entries()) {
        const id = `card-${randomUUID()}`
        operations.push(
          { op: 'create_page_element', id, parentId: sectionId, type: 'FRAME', props: { name, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', fill: '#fffbf4' } },
          { op: 'create_page_element', id: `heading-${randomUUID()}`, parentId: id, type: 'TEXT', props: { name: `${name} heading`, text: name, fontSize: 38, fontWeight: 700 } },
          { op: 'create_page_element', id: `body-${randomUUID()}`, parentId: id, type: 'TEXT', props: { name: `${name} description`, text: `Stop ${index + 1}: take time to explore a different side of the city.`, fontSize: 24 } },
        )
      }
      if (prompt.includes('fail')) operations.push({ op: 'update_page_element', id: 'missing-page-element', props: { text: 'Must fail' } })
      return tool('apply_batch', { kind: 'page', artifactId, expectedRevision: result.data.revision + (prompt.includes('conflict') ? 1 : 0), operations })
    }
    if (document) {
      const selection = result.data.selection
      const operations: unknown[] = selection && selection.from < selection.to
        ? [{ op: 'replace_range', from: selection.from, to: selection.to, content: [{ type: 'text', text: 'Updated by the document assistant', marks: [{ type: 'bold' }] }] }]
        : [{ op: 'replace_document', content: { type: 'doc', content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'One idea, two artifacts' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'This editable document was created through the browser, streamed tools, and SQLite.' }] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Write the story, then create the slides.' }] }] }] },
        ] } }]
      if (prompt.includes('fail')) operations.push({ op: 'replace_range', from: 599999, to: 599999, content: [] })
      return tool('apply_batch', { kind: 'document', artifactId, expectedRevision: result.data.revision + (prompt.includes('conflict') ? 1 : 0), operations })
    }
    return tool('apply_batch', { kind: 'slides', artifactId, expectedRevision: result.data.revision, operations: [
      { op: 'update_slide', id: result.data.slides[0].id, title: 'The companion slide deck' },
    ] })
  }
  if (result.ok && last.name === 'apply_batch' && prompt.includes('both') && !calls.some(c => c.name === 'create_artifact' && (c.input as { kind: string }).kind === 'slides')) {
    return tool('create_artifact', { kind: 'slides', title: 'Browser verification slides' })
  }
  const text = result.ok ? 'Saved your artifacts. You can edit, comment, and export them.' : `Actual tool failure: ${result.error}`
  emit(text)
  return [{ type: 'text', text, citations: null }]
}
