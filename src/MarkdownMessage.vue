<script setup lang="ts">
import { computed } from 'vue'
import DOMPurify from 'dompurify'
import { markdownHtml, markdownSanitizerConfig } from './markdown'

const props = defineProps<{ content: string }>()
const rendered = computed(() => DOMPurify.sanitize(markdownHtml(props.content), markdownSanitizerConfig))
</script>

<template>
  <div class="markdown-message" v-html="rendered" />
</template>

<style>
.markdown-message { overflow-wrap: anywhere; min-width: 0; }
.markdown-message > :first-child { margin-top: 0; }
.markdown-message > :last-child { margin-bottom: 0; }
.markdown-message p { margin: .7em 0; }
.markdown-message h1, .markdown-message h2, .markdown-message h3, .markdown-message h4, .markdown-message h5, .markdown-message h6 { font-size: 1.12em; line-height: 1.4; margin: 1.2em 0 .5em; }
.markdown-message h1 { font-size: 1.35em; }.markdown-message h2 { font-size: 1.2em; }
.markdown-message ul, .markdown-message ol { padding-left: 1.6em; margin: .6em 0; }
.markdown-message li { margin: .3em 0; }
.markdown-message blockquote { margin: .8em 0; padding: 0 0 0 12px; border-left: 3px solid var(--line); color: var(--muted); }
.markdown-message pre { overflow-x: auto; max-width: 100%; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: #f3f0e9; line-height: 1.55; }
.markdown-message code { font-family: Consolas, 'Courier New', monospace; font-size: .9em; padding: 2px 4px; border-radius: 3px; background: #f0ebe1; }
.markdown-message pre code { padding: 0; border-radius: 0; background: transparent; white-space: pre; }
.markdown-message table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; font-size: .9em; margin: .8em 0; }
.markdown-message th, .markdown-message td { border: 1px solid var(--line); padding: 6px 9px; text-align: left; }
.markdown-message th { background: #f3f0e9; }
.markdown-message a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.markdown-message hr { border: 0; border-top: 1px solid var(--line); margin: 1em 0; }
</style>
