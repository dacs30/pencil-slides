import { getSchema, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import { EditorState } from '@tiptap/pm/state'
import { Step, StepResult, type StepMap } from '@tiptap/pm/transform'
import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import { z } from 'zod'

export const documentExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: { openOnClick: false, autolink: false, linkOnPaste: false },
    trailingNode: false,
  }),
  Highlight,
]
export const richSchema = getSchema(documentExtensions)
export type RichNode = JSONContent
export const safeLink = (href: string) => /^(https?:\/\/|mailto:)/i.test(href) && !/[\u0000-\u0020]/.test(href)
const attrs: Record<string, string[]> = {
  heading: ['level'], orderedList: ['start', 'type'], codeBlock: ['language'],
  link: ['href', 'target', 'rel', 'class'],
}
const titleSchema = z.string().trim().min(1).max(200)
export class TitleStep extends Step {
  constructor(readonly before: string, readonly after: string) { super() }
  apply(doc: ProseMirrorNode) { return StepResult.ok(doc) }
  invert() { return new TitleStep(this.after, this.before) }
  map() { return this }
  toJSON() { return { stepType: 'pencilTitle', before: this.before, after: this.after } }
  static fromJSON(_schema: Schema, value: unknown) {
    const input = z.object({ stepType: z.literal('pencilTitle'), before: titleSchema, after: titleSchema }).strict().parse(value)
    return new TitleStep(input.before, input.after)
  }
}
Step.jsonID('pencilTitle', TitleStep)
function checkJSON(value: unknown, depth = 0, count = { nodes: 0 }): void {
  if (++count.nodes > 5000 || depth > 24) throw new Error('Document limit: 5,000 nodes and 24 nested levels.')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid document node.')
  const node = value as Record<string, unknown>
  if (Object.keys(node).some(k => !['type', 'attrs', 'content', 'marks', 'text'].includes(k))) throw new Error('Unknown document property.')
  if (typeof node.type !== 'string' || !(node.type in richSchema.nodes || node.type in richSchema.marks)) throw new Error('Unsupported document node or mark.')
  if (node.text !== undefined && (typeof node.text !== 'string' || node.text.length > 100000)) throw new Error('Invalid document text.')
  if (node.type === 'link' && !node.attrs) throw new Error('Links require a safe URL.')
  if (node.attrs !== undefined) {
    if (!node.attrs || typeof node.attrs !== 'object' || Array.isArray(node.attrs)) throw new Error('Invalid attributes.')
    for (const key of Object.keys(node.attrs)) if (!(attrs[node.type] ?? []).includes(key)) throw new Error(`Unsupported ${node.type} attribute: ${key}`)
    const a = node.attrs as Record<string, unknown>
    if (node.type === 'heading' && (typeof a.level !== 'number' || ![1, 2, 3].includes(a.level))) throw new Error('Only heading levels 1-3 are supported.')
    if (node.type === 'orderedList' && a.start !== undefined && (!Number.isInteger(a.start) || Number(a.start) < 1 || Number(a.start) > 10000)) throw new Error('Invalid list start.')
    if (node.type === 'link' && (typeof a.href !== 'string' || !safeLink(a.href))) throw new Error('Links must use https, http or mailto.')
    if (node.type === 'link' && Object.entries(a).some(([k, v]) => k !== 'href' && v !== null && typeof v !== 'string')) throw new Error('Invalid link attributes.')
  }
  for (const key of ['content', 'marks']) {
    if (node[key] !== undefined) {
      if (!Array.isArray(node[key])) throw new Error('Invalid node content.')
      for (const child of node[key]) checkJSON(child, depth + 1, count)
    }
  }
}
export const richContentSchema = z.unknown().transform((value, ctx): RichNode => {
  try {
    if (JSON.stringify(value)?.length > 600000) throw new Error('Document content exceeds 600 KB.')
    checkJSON(value)
    const node = richSchema.nodeFromJSON(value)
    if (node.type.name !== 'doc') throw new Error('Expected a document root.')
    node.check()
    return node.toJSON()
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : 'Invalid document.' })
    return z.NEVER
  }
})
export const textSnapshotSchema = z.object({
  version: z.literal(1), title: z.string().trim().min(1).max(200), content: richContentSchema,
}).strict()
export type TextSnapshot = z.infer<typeof textSnapshotSchema>
export function blankDocument(title = 'Untitled document'): TextSnapshot {
  return { version: 1, title, content: { type: 'doc', content: [{ type: 'paragraph' }] } }
}
const pos = z.number().int().min(0).max(600000)
export const textOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replace_range'), from: pos, to: pos, content: z.array(z.record(z.string(), z.unknown())).max(5000) }).strict(),
  z.object({ op: z.literal('replace_document'), content: richContentSchema }).strict(),
  z.object({ op: z.literal('set_title'), title: z.string().trim().min(1).max(200) }).strict(),
])
export const textBatchSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  operations: z.array(textOperationSchema).min(1).max(100),
}).strict()
export type TextBatch = z.infer<typeof textBatchSchema>
export type TextAnchor = { from: number; to: number; quote: string; detached: boolean }
export function mapTextAnchor(anchor: TextAnchor, maps: readonly StepMap[]): TextAnchor {
  if (anchor.detached) return { ...anchor }
  let { from, to } = anchor
  for (const map of maps) {
    let replaced = false
    map.forEach((oldStart, oldEnd) => { if (oldEnd > oldStart && oldStart <= from && oldEnd >= to) replaced = true })
    if (replaced) return { ...anchor, detached: true }
    const start = map.mapResult(from, 1), end = map.mapResult(to, -1)
    from = start.pos; to = end.pos
    if (from >= to || (start.deletedAcross && end.deletedAcross)) return { ...anchor, detached: true }
  }
  return { ...anchor, from, to }
}
export function applyTextBatch(before: TextSnapshot, operations: TextBatch['operations']) {
  let title = before.title
  const state = EditorState.create({ schema: richSchema, doc: richSchema.nodeFromJSON(before.content) })
  const tr = state.tr
  for (const op of operations) {
    if (op.op === 'set_title') { tr.step(new TitleStep(title, op.title)); title = op.title; continue }
    if (op.op === 'replace_document') {
      tr.replaceWith(0, tr.doc.content.size, richSchema.nodeFromJSON(op.content).content)
    } else {
      if (op.from > op.to || op.to > tr.doc.content.size) throw new Error('Text range is outside the current document.')
      for (const node of op.content) checkJSON(node)
      tr.replaceWith(op.from, op.to, op.content.map(n => richSchema.nodeFromJSON(n)))
    }
    tr.doc.check()
  }
  return { snapshot: textSnapshotSchema.parse({ version: 1, title, content: tr.doc.toJSON() }), steps: tr.steps.map(s => s.toJSON()) }
}
export function replayTextSteps(before: TextSnapshot, steps: unknown[]) {
  let doc = richSchema.nodeFromJSON(before.content)
  let title = before.title
  const maps: StepMap[] = []
  for (const raw of steps) {
    const step = Step.fromJSON(richSchema, raw)
    if (step instanceof TitleStep) {
      if (step.before !== title) throw new Error('Title step does not match the current title.')
      title = step.after
    }
    const result = step.apply(doc)
    if (result.failed || !result.doc) throw new Error(result.failed ?? 'Invalid document step.')
    doc = result.doc
    doc.check()
    maps.push(step.getMap())
  }
  richContentSchema.parse(doc.toJSON())
  return { doc, maps, title }
}
