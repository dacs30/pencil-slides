<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from './api'
import { blankDeck } from './document'
import type { Deck } from '../shared/model'
import Workspace from './Workspace.vue'

const decks = ref<{ id: string; title: string }[]>([])
const deck = ref<Deck>()
const error = ref('')
const busy = ref(false)
const locked = ref(false)
async function refresh() { decks.value = await api('/decks') }
async function open(id: string) {
  if (busy.value || locked.value) return
  busy.value = true
  try {
    deck.value = await api(`/decks/${id}`)
    localStorage.setItem('pencil-slides:last', id)
    error.value = ''
  } catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
async function create() {
  if (locked.value) return
  try {
    const created = await api<Deck>('/decks', { method: 'POST', body: JSON.stringify(blankDeck()) })
    await refresh()
    await open(created.id)
  } catch (e) { error.value = String(e) }
}
onMounted(async () => {
  try {
    await refresh()
    const last = localStorage.getItem('pencil-slides:last')
    if (!decks.value.length) await create()
    else await open(decks.value.find(d => d.id === last)?.id ?? decks.value[0]!.id)
  } catch (e) { error.value = String(e) }
})
</script>

<template>
  <header class="app-header">
    <div class="brand"><span class="brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="m6 16 9-10 3 3-9 10-4 1 1-4Z"/><path d="m13 8 3 3"/></svg></span><span>Pencil Slides</span><small>Local workspace</small></div>
    <div class="deck-picker">
      <select aria-label="Choose deck" :value="deck?.id" :disabled="busy || locked" @change="open(($event.target as HTMLSelectElement).value)">
        <option v-for="item in decks" :key="item.id" :value="item.id">{{ item.title }}</option>
      </select>
      <button :disabled="locked" @click="create">+ New deck</button>
    </div>
  </header>
  <div v-if="error" class="error" role="alert">{{ error }} <button @click="refresh">Retry</button></div>
  <Workspace v-if="deck" :key="deck.id" :deck="deck" @saved="refresh" @lock="locked = $event" />
  <main v-else class="loading">Opening your local studio…</main>
</template>
