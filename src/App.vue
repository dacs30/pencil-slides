<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from './api'
import type { Conversation } from '../shared/artifacts'
import ConversationWorkspace from './ConversationWorkspace.vue'

const conversations = ref<Conversation[]>([]), current = ref<Conversation>()
const error = ref(''), busy = ref(false), locked = ref(false)
async function refresh() { conversations.value = await api('/conversations') }
async function open(id: string) {
  if (busy.value || locked.value) return
  busy.value = true
  try {
    current.value = await api<Conversation>(`/conversations/${id}`)
    localStorage.setItem('pencil:conversation', id); error.value = ''
  } catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
async function create() {
  if (busy.value || locked.value) return
  busy.value = true
  try {
    const conversation = await api<Conversation>('/conversations', { method: 'POST' })
    await refresh(); current.value = conversation; localStorage.setItem('pencil:conversation', conversation.id)
  } catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
async function refreshSafely() { try { await refresh() } catch (e) { error.value = String(e) } }
onMounted(async () => {
  try {
    await refresh()
    const previous = localStorage.getItem('pencil:conversation') ?? localStorage.getItem('pencil-slides:last')
    if (!conversations.value.length) await create()
    else await open(conversations.value.find(c => c.id === previous)?.id ?? conversations.value[0]!.id)
  } catch (e) { error.value = String(e) }
})
</script>
<template>
  <header class="app-header">
    <div class="brand"><strong>Pencil</strong><small>Documents, slides &amp; pages · Local workspace</small></div>
    <div class="deck-picker">
      <select aria-label="Choose conversation" :value="current?.id" :disabled="busy || locked" @change="open(($event.target as HTMLSelectElement).value)">
        <option v-for="conversation in conversations" :key="conversation.id" :value="conversation.id">{{ conversation.title }}</option>
      </select>
      <button :disabled="busy || locked" @click="create">+ New conversation</button>
    </div>
  </header>
  <div v-if="error" class="error" role="alert">{{ error }}<button @click="refreshSafely">Retry</button></div>
  <ConversationWorkspace v-if="current" :key="current.id" :conversation="current" @refresh="refreshSafely" @lock="locked = $event" />
  <main v-else class="loading">Opening your local studio...</main>
</template>
