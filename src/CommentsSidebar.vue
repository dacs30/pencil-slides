<script setup lang="ts">
import { nextTick, reactive, ref, watch } from 'vue'
import type { CommentsController } from './useComments'

const props = defineProps<{ controller: CommentsController; busy: boolean; aiConfigured: boolean; currentSlideTitle: string }>()
const c = reactive(props.controller)
const draftInput = ref<HTMLTextAreaElement>()
watch(() => c.draftAnchor, async anchor => { if (anchor) { await nextTick(); draftInput.value?.focus() } }, { immediate: true })
function date(value: string) {
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
</script>

<template>
  <aside class="comments-sidebar" aria-label="Comments sidebar">
    <header class="panel-heading">Comments <span class="comment-count">{{ c.unresolvedCount }}</span><button type="button" class="icon-button" aria-label="Close comments" @click="c.open = false">×</button></header>
    <p class="comment-local-note">Your notes, saved locally. Ask Claude only when you choose.</p>
    <div class="comment-new-actions">
      <button type="button" :disabled="busy || c.saving || !c.loaded || c.pointMode" @click="c.startPoint">⌖ Pin a point</button>
      <button type="button" :disabled="busy || c.saving || !c.loaded || !c.canAttach || c.pointMode" @click="c.startObject">Comment on selection</button>
    </div>
    <label class="resolved-filter"><input type="checkbox" v-model="c.showResolved">Show resolved</label>
    <div v-if="c.error" class="comment-error" role="alert"><span>{{ c.error }}</span><button type="button" :disabled="c.saving || c.loading" @click="c.reload">Refresh comments</button></div>
    <p v-if="c.loading" class="comment-saving" role="status">Loading comments…</p>
    <p v-if="c.saving" class="comment-saving" role="status">Saving comment…</p>
    <div v-if="c.pointMode" class="comment-mode-help">Click inside the slide, or use arrow keys and Enter. Escape cancels.<button type="button" @click="c.pointMode = false">Cancel pinning</button></div>
    <form v-if="c.draftAnchor" class="comment-draft" @submit.prevent="c.post">
      <strong>{{ c.draftAnchor.kind === 'object' ? 'Comment on selected object' : 'Comment at this point' }}</strong>
      <small>{{ currentSlideTitle }}</small>
      <textarea ref="draftInput" v-model="c.draftBody" aria-label="New comment" placeholder="What would you like to change?" maxlength="2000" rows="4" :disabled="busy || c.saving" />
      <div class="comment-form-footer"><small>{{ c.draftBody.length }} / 2000</small><button type="button" :disabled="c.saving" @click="c.cancelDraft">Cancel</button><button type="submit" class="comment-primary" :disabled="busy || c.saving || !c.draftBody.trim()">Post comment</button></div>
    </form>
    <div class="comment-thread-list">
      <p v-if="c.loaded && !c.loading && !c.visible.length && !c.draftAnchor" class="comments-empty">{{ c.showResolved ? 'No comments yet.' : 'No open comments.' }} Pin a point or select an object to leave a note.</p>
      <article v-for="thread in c.visible" :key="thread.id" class="comment-thread" :class="{ focused: c.focusedId === thread.id, resolved: thread.resolved }">
        <button type="button" class="comment-thread-target" :disabled="busy || c.saving" @click="c.selectThread(thread)">
          <span class="comment-number">{{ c.number(thread.id) }}</span><span><strong>{{ c.slideTitle(thread) }}</strong><small>{{ c.locationLabel(thread) }}</small></span><span v-if="thread.resolved" class="resolved-badge">Resolved</span>
        </button>
        <div class="thread-message"><div class="comment-author">You <time :datetime="thread.messages[0]?.createdAt">{{ date(thread.createdAt) }}</time></div><p>{{ thread.messages[0]?.body }}</p></div>
        <template v-if="c.focusedId === thread.id">
          <div v-for="message in thread.messages.slice(1)" :key="message.id" class="thread-message reply-message"><div class="comment-author">You <time :datetime="message.createdAt">{{ date(message.createdAt) }}</time></div><p>{{ message.body }}</p></div>
          <p v-if="c.attachment(thread).detached" class="detachment-note">The original target is detached. Its original slide-local position is preserved; this thread will not attach to a replacement object.</p>
          <div class="comment-thread-actions">
            <button type="button" :disabled="busy || c.saving" @click="c.setResolved(thread, !thread.resolved)">{{ thread.resolved ? 'Reopen thread' : 'Resolve thread' }}</button>
            <button v-if="!thread.resolved" type="button" class="ask-comment" :disabled="busy || c.saving || !aiConfigured || c.attachment(thread).detached === 'slide_deleted'" @click="c.ask(thread)">Ask Claude to address this ↗</button>
          </div>
          <p v-if="!aiConfigured && !thread.resolved" class="comment-local-note">Claude isn’t connected. Comments still work without a key.</p>
          <form v-if="!thread.resolved" class="comment-reply" @submit.prevent="c.reply">
            <textarea v-model="c.replyBody" aria-label="Reply to comment" placeholder="Add a reply…" maxlength="2000" rows="2" :disabled="busy || c.saving" />
            <div class="comment-form-footer"><button v-if="c.replyBody" type="button" :disabled="c.saving" @click="c.cancelReply">Cancel reply</button><button type="submit" :disabled="busy || c.saving || !c.replyBody.trim()">Post reply</button></div>
          </form>
        </template>
        <button v-else-if="thread.messages.length > 1" type="button" class="comment-reply-count" :disabled="busy || c.saving" @click="c.selectThread(thread)">{{ thread.messages.length - 1 }} {{ thread.messages.length === 2 ? 'reply' : 'replies' }}</button>
      </article>
    </div>
  </aside>
</template>
