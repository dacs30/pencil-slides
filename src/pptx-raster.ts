import { getWorldMatrix, TransformMatrix, type SceneGraph } from '@open-pencil/scene-graph'
import type { SkiaRenderer } from '@open-pencil/core/canvas'
import { computeContentBounds, renderNodesToImage } from '@open-pencil/core/io/formats/raster'

/** Crop the SDK's visual-bounds export to the actual 1920×1080 artboard, not the viewport mask. */
export async function rasterizePowerPointSlide(graph: SceneGraph, pageId: string, id: string, renderer: SkiaRenderer): Promise<string> {
  const frame = graph.getNode(id)
  const bounds = computeContentBounds(graph, [id])
  if (!frame || !bounds) throw new Error(`Slide could not be rendered: ${id}`)
  const toSlide = TransformMatrix.invert(getWorldMatrix(frame, graph))
  if (!toSlide) throw new Error(`Slide has a non-invertible transform: ${frame.name}`)
  const bytes = renderNodesToImage(renderer.ck, renderer, graph, pageId, [id], { scale: 1, format: 'PNG', trimTransparent: false })
  if (!bytes) throw new Error(`PNG rendering failed for "${frame.name}".`)
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1920
    canvas.height = 1080
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('A 2D canvas is required for PowerPoint image export.')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(toSlide[0], toSlide[3], toSlide[1], toSlide[4], toSlide[2], toSlide[5])
    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
    const data = canvas.toDataURL('image/png')
    if (!data.startsWith('data:image/png;base64,')) throw new Error('Slide PNG encoding failed.')
    return data
  } finally { bitmap.close() }
}
