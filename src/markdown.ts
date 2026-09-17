import { Marked, Renderer } from 'marked'
import type { Config } from 'dompurify'
import { safeLink } from '../shared/rich-text'

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const renderer = new Renderer()
renderer.html = ({ text }) => escape(text)
renderer.image = ({ text }) => escape(`Image: ${text}`)
renderer.checkbox = ({ checked }) => checked ? '[x] ' : '[ ] '
renderer.link = function ({ href, title, tokens }) {
  const label = this.parser.parseInline(tokens)
  if (!safeLink(href)) return label
  return `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`
}
const parser = new Marked({ renderer, gfm: true, breaks: true, async: false })
export function markdownHtml(content: string): string {
  return parser.parse(content, { async: false })
}
export const markdownSanitizerConfig: Config = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'align', 'start'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
}
