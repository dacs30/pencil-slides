import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdownHtml, markdownSanitizerConfig } from '../src/markdown.js'

test('assistant Markdown supports headings, emphasis, lists, tables and fenced code', () => {
  const html = markdownHtml('# A heading\n\n**Bold** and *italic* with `code`.\n\n- First\n- Second\n\n| Name | Value |\n| --- | --- |\n| Item | 1 |\n\n```js\nconst a = "<tag>";\n```')
  for (const tag of ['h1', 'strong', 'em', 'ul', 'li', 'table', 'th', 'td', 'pre', 'code']) assert.match(html, new RegExp(`<${tag}[ >]`))
  assert.match(html, /&lt;tag&gt;/)
  assert.doesNotThrow(() => markdownHtml('**Streaming\n\n```js\nconst partial ='))
})
test('Markdown escapes raw HTML, refuses unsafe links, and does not load images', () => {
  const html = markdownHtml('<script>alert(1)</script>\n\n<img src="https://example.invalid/tracker" onerror="alert(1)">\n\n[bad](javascript:alert%281%29) ![Alt text](https://example.invalid/image.png)\n\n[Good](https://example.com)')
  assert.doesNotMatch(html, /<script|<img|href="javascript:/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /Image: Alt text/)
  assert.match(html, /href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/)
  assert(!markdownSanitizerConfig.ALLOWED_TAGS?.includes('script'))
  assert(!markdownSanitizerConfig.ALLOWED_TAGS?.includes('img'))
  assert(!markdownSanitizerConfig.ALLOWED_ATTR?.includes('style'))
})
