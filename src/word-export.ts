import { Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel, LevelFormat, AlignmentType, BorderStyle, type IRunOptions } from 'docx'
import { textSnapshotSchema, safeLink, type RichNode, type TextSnapshot } from '../shared/rich-text'

export async function exportWord(snapshot: TextSnapshot) {
  const data = textSnapshotSchema.parse(snapshot)
  let listId = 0
  const numbering: { reference: string; levels: { level: number; format: typeof LevelFormat.BULLET | typeof LevelFormat.DECIMAL; text: string; alignment: typeof AlignmentType.LEFT; start: number; style: { paragraph: { indent: { left: number; hanging: number } } } }[] }[] = []
  function inline(nodes: RichNode[] = []): (TextRun | ExternalHyperlink)[] {
    return nodes.flatMap(node => {
      if (node.type === 'hardBreak') return new TextRun({ break: 1 })
      if (node.type !== 'text') throw new Error(`Unsupported inline content: ${node.type}`)
      const options: IRunOptions = {
        bold: node.marks?.some(m => m.type === 'bold'),
        italics: node.marks?.some(m => m.type === 'italic'),
        underline: node.marks?.some(m => m.type === 'underline') ? {} : undefined,
        strike: node.marks?.some(m => m.type === 'strike'),
        highlight: node.marks?.some(m => m.type === 'highlight') ? 'yellow' : undefined,
        font: node.marks?.some(m => m.type === 'code') ? 'Consolas' : undefined,
      }
      const link = node.marks?.find(m => m.type === 'link')?.attrs?.href
      const runs = (node.text ?? '').split(/\r?\n/).map((text, i) => new TextRun({ ...options, text, ...(link ? { style: 'Hyperlink' } : {}), ...(i ? { break: 1 } : {}) }))
      if (link !== undefined) {
        if (typeof link !== 'string' || !safeLink(link)) throw new Error('Cannot export unsafe link.')
        return new ExternalHyperlink({ link, children: runs })
      }
      return runs
    })
  }
  function blocks(nodes: RichNode[], depth = 0, list?: { reference: string; level: number }, quote = false): Paragraph[] {
    return nodes.flatMap(node => {
      if (node.type === 'bulletList' || node.type === 'orderedList') {
        if (depth >= 9) throw new Error('Word export supports at most nine nested list levels.')
        const reference = `list-${++listId}`, ordered = node.type === 'orderedList'
        numbering.push({ reference, levels: Array.from({ length: 9 }, (_, level) => ({
          level, format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: ordered ? `%${level + 1}.` : '\u2022', alignment: AlignmentType.LEFT,
          start: ordered ? Number(node.attrs?.start ?? 1) : 1,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })) })
        return (node.content ?? []).flatMap(item => blocks(item.content ?? [], depth + 1, { reference, level: depth }, quote))
      }
      if (node.type === 'blockquote') return blocks(node.content ?? [], depth, list, true)
      if (node.type === 'codeBlock') {
        return (node.content ?? []).map(n => n.text ?? '').join('').split('\n').map(text => new Paragraph({ children: [new TextRun({ text, font: 'Consolas' })], spacing: { after: 0 } }))
      }
      if (node.type === 'horizontalRule') return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, color: 'D6D1C7', size: 6 } } })]
      if (node.type !== 'paragraph' && node.type !== 'heading') throw new Error(`Unsupported Word content: ${node.type}`)
      const heading = node.type === 'heading' ? [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][Number(node.attrs?.level) - 1] : undefined
      const paragraph = new Paragraph({
        heading, children: inline(node.content),
        numbering: list,
        indent: quote ? { left: 360 } : undefined,
        spacing: { after: 180 },
      })
      // Only the first paragraph of each list item receives a number.
      list = undefined
      return [paragraph]
    })
  }
  const children = blocks(data.content.content ?? [])
  const document = new Document({
    title: data.title, creator: 'Pencil', description: 'Editable document exported from Pencil',
    styles: {
      default: { document: { run: { font: 'Arial', size: 24 } } },
      paragraphStyles: [1, 2, 3].map((level, i) => ({
        id: `Heading${level}`, name: `Heading ${level}`, basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: 'Arial', size: [40, 32, 28][i], bold: true, color: '202020' },
        paragraph: { outlineLevel: i, spacing: { before: 240, after: 160 } },
      })),
    },
    numbering: { config: numbering },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children,
    }],
  })
  return new Uint8Array(await Packer.toArrayBuffer(document))
}
