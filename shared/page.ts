import { z } from 'zod'
import { elementProps } from './model.js'

const id = z.string().min(1).max(120)
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const solidFill = z.object({
  type: z.literal('SOLID'), visible: z.boolean(), opacity: z.number().finite().min(0).max(1),
  color: z.object({ r: z.number().finite().min(0).max(1), g: z.number().finite().min(0).max(1), b: z.number().finite().min(0).max(1), a: z.number().finite().min(0).max(1) }),
}).passthrough()
const nodeStyle = z.object({
  fills: z.array(solidFill).max(1), visible: z.boolean(), opacity: z.number().finite().min(0).max(1),
  rotation: z.number().finite().min(-360).max(360), cornerRadius: z.number().finite().min(0).max(500),
  layoutMode: z.enum(['NONE', 'VERTICAL', 'HORIZONTAL']), layoutWrap: z.enum(['WRAP', 'NO_WRAP']),
}).passthrough()
const pageTextStyle = z.object({
  text: z.string().max(20000), fontSize: z.number().finite().min(6).max(400), fontWeight: z.number().int().min(100).max(900),
  textAlignHorizontal: z.enum(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']), italic: z.boolean(),
}).passthrough()
export const pageReadSchema = z.object({ view: z.enum(['page', 'selection']), slideId: id.optional() }).strict()
export const pageElementProps = elementProps.extend({
  layoutMode: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL']).optional(),
  layoutWrap: z.enum(['NO_WRAP', 'WRAP']).optional(),
  layoutSizingHorizontal: z.enum(['FIXED', 'FILL', 'HUG']).optional(),
  layoutSizingVertical: z.enum(['FIXED', 'FILL', 'HUG']).optional(),
  itemSpacing: z.number().finite().min(0).max(200).optional(),
  paddingTop: z.number().finite().min(0).max(200).optional(),
  paddingRight: z.number().finite().min(0).max(200).optional(),
  paddingBottom: z.number().finite().min(0).max(200).optional(),
  paddingLeft: z.number().finite().min(0).max(200).optional(),
  textAutoResize: z.enum(['NONE', 'HEIGHT', 'WIDTH_AND_HEIGHT']).optional(),
})
export type PageElementProperties = z.infer<typeof pageElementProps>
export const pageOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('update_page'), title: z.string().trim().min(1).max(200).optional(), width: z.number().int().min(320).max(1920).optional(), background: color.optional() }).strict(),
  z.object({ op: z.literal('create_page_element'), id, parentId: id, type: z.enum(['FRAME', 'TEXT', 'RECTANGLE', 'ELLIPSE']), props: pageElementProps }).strict(),
  z.object({ op: z.literal('update_page_element'), id, props: pageElementProps }).strict(),
  z.object({ op: z.literal('delete_page_element'), id }).strict(),
  z.object({ op: z.literal('move_page_element'), id, parentId: id, index: z.number().int().min(0).max(499) }).strict(),
])
export const pageBatchSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  operations: z.array(pageOperationSchema).min(1).max(100),
}).strict()
export type PageOperation = z.infer<typeof pageOperationSchema>
export const pageSnapshotSchema = z.object({
  version: z.literal(1), title: z.string().trim().min(1).max(200), pageId: id, frameId: id,
  nodes: z.array(z.object({
    id, parentId: id, childIds: z.array(id).max(500),
    type: z.enum(['FRAME', 'TEXT', 'RECTANGLE', 'ELLIPSE']),
    x: z.number().finite().min(-20000).max(20000), y: z.number().finite().min(-20000).max(20000),
    width: z.number().finite().min(0).max(20000), height: z.number().finite().min(0).max(20000),
  }).passthrough()).min(1).max(500),
}).strict().superRefine((snapshot, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
  const nodes = new Map(snapshot.nodes.map(n => [n.id, n]))
  const root = nodes.get(snapshot.frameId)
  if (nodes.size !== snapshot.nodes.length || nodes.has(snapshot.pageId)) fail('Page node IDs must be unique.')
  if (!root || root.type !== 'FRAME' || root.parentId !== snapshot.pageId || root.width < 320 || root.width > 1920) fail('Invalid page artboard.')
  for (const n of snapshot.nodes) {
    if (!nodeStyle.safeParse(n).success) fail('Page element has unsupported or invalid styling.')
    const horizontalSizing = n.layoutMode === 'VERTICAL' ? n.counterAxisSizing : n.primaryAxisSizing
    const verticalSizing = n.layoutMode === 'HORIZONTAL' ? n.counterAxisSizing : n.primaryAxisSizing
    if (n.width === 0 && !(n.type === 'FRAME' && n.layoutMode !== 'NONE' && horizontalSizing === 'HUG')) fail('Only a hug-sized auto-layout frame can have zero width.')
    if (n.height === 0 && !(n.type === 'FRAME' && n.layoutMode !== 'NONE' && verticalSizing === 'HUG')) fail('Only a hug-sized auto-layout frame can have zero height.')
    if (n.type === 'TEXT' && !pageTextStyle.safeParse(n).success) fail('Page text has invalid content or typography.')
    if (new Set(n.childIds).size !== n.childIds.length || n.childIds.some(c => nodes.get(c)?.parentId !== n.id)) fail('Broken page child reference.')
    if (n.type !== 'FRAME' && n.childIds.length) fail('Only frames can contain page elements.')
    if (n.id !== snapshot.frameId) {
      const parent = nodes.get(n.parentId)
      if (!parent || parent.type !== 'FRAME' || !parent.childIds.includes(n.id)) fail('Invalid page parent.')
      const seen = new Set<string>()
      let current: typeof n | undefined = n
      while (current && current.id !== snapshot.frameId) {
        if (seen.has(current.id) || seen.size >= 12) { fail('Page hierarchy is cyclic or exceeds 12 levels.'); break }
        seen.add(current.id); current = nodes.get(current.parentId)
      }
    }
    if (typeof n.text === 'string' && n.text.length > 20000) fail('Page text exceeds 20,000 characters.')
  }
  if (JSON.stringify(snapshot).length > 4 * 1024 * 1024) fail('Page exceeds the 4 MiB snapshot limit.')
})
export type PageSnapshot = z.infer<typeof pageSnapshotSchema>
export type PageArtifact = { id: string; revision: number; snapshot: PageSnapshot }
export const pageSaveSchema = z.object({
  expectedRevision: z.number().int().nonnegative(), commandId: id, snapshot: pageSnapshotSchema,
}).strict()
