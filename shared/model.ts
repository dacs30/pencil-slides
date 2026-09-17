import { z } from 'zod'

const id = z.string().min(1).max(120)
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const position = z.number().finite().min(-10000).max(250000)
const size = z.number().finite().min(1).max(10000)
export const elementProps = z.object({
  name: z.string().max(200).optional(),
  x: position.optional(), y: position.optional(),
  width: size.optional(), height: size.optional(),
  text: z.string().max(20000).optional(),
  fontSize: z.number().min(6).max(400).optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  italic: z.boolean().optional(),
  textDecoration: z.enum(['NONE', 'UNDERLINE', 'STRIKETHROUGH']).optional(),
  textAlignHorizontal: z.enum(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']).optional(),
  fill: color.optional(),
  stroke: color.optional(),
  strokeWidth: z.number().finite().min(0).max(40).optional(),
  cornerRadius: z.number().finite().min(0).max(500).optional(),
  rotation: z.number().min(-360).max(360).optional(),
}).strict()
export type ElementProperties = z.infer<typeof elementProps>
export const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_slide'), id, title: z.string().min(1).max(200), background: color.optional() }).strict(),
  z.object({ op: z.literal('update_slide'), id, title: z.string().min(1).max(200).optional(), background: color.optional() }).strict(),
  z.object({ op: z.literal('delete_slide'), id }).strict(),
  z.object({ op: z.literal('reorder_slides'), ids: z.array(id).min(1).max(100) }).strict(),
  z.object({ op: z.literal('create_element'), id, slideId: id, type: z.enum(['TEXT', 'RECTANGLE', 'ELLIPSE']), props: elementProps }).strict(),
  z.object({ op: z.literal('update_element'), id, props: elementProps }).strict(),
  z.object({ op: z.literal('delete_element'), id }).strict(),
])
export const batchSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  operations: z.array(operationSchema).min(1).max(100),
}).strict()
export type Operation = z.infer<typeof operationSchema>
export type Batch = z.infer<typeof batchSchema>
export const snapshotSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1).max(200),
  pageId: id,
  slides: z.array(z.object({ id, title: z.string().min(1).max(200) }).strict()).min(1).max(100),
  nodes: z.array(z.object({
    id, parentId: id,
    childIds: z.array(id).max(2000),
    type: z.enum(['FRAME', 'TEXT', 'RECTANGLE', 'ELLIPSE']),
    x: position, y: position, width: size, height: size,
  }).passthrough()).min(1).max(2000),
}).strict().superRefine((s, ctx) => {
  const nodes = new Map(s.nodes.map(n => [n.id, n]))
  const slides = new Set(s.slides.map(n => n.id))
  const bad = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (nodes.size !== s.nodes.length || slides.size !== s.slides.length || nodes.has(s.pageId)) bad('Duplicate IDs')
  for (const slide of s.slides) {
    const n = nodes.get(slide.id)
    if (!n || n.type !== 'FRAME' || n.parentId !== s.pageId || n.width !== 1920 || n.height !== 1080) bad('Invalid slide frame')
  }
  for (const n of s.nodes) {
    if (slides.has(n.id)) {
      if (n.childIds.some(c => nodes.get(c)?.parentId !== n.id)) bad('Broken child reference')
    } else {
      if (!slides.has(n.parentId) || n.type === 'FRAME' || !nodes.get(n.parentId)?.childIds.includes(n.id) || n.childIds.length) bad('Elements must belong directly to a slide')
    }
    if (new Set(n.childIds).size !== n.childIds.length) bad('Duplicate child reference')
  }
})
export type Snapshot = z.infer<typeof snapshotSchema>
export type Deck = { id: string; revision: number; snapshot: Snapshot }
export type Command = { id: string; name: 'read_context' | 'apply_batch'; input: unknown }
export type ToolResult = { ok: boolean; data?: unknown; error?: string }
export const readSchema = z.object({
  view: z.enum(['deck', 'slide', 'selection']),
  slideId: id.optional(),
}).strict()
export const saveSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  snapshot: snapshotSchema,
  commandId: id,
}).strict()
