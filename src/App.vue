<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from './api'
import type { Conversation } from '../shared/artifacts'
import ConversationWorkspace from './ConversationWorkspace.vue'
import { browserStore } from './local-store'

const conversations = ref<Conversation[]>([]), current = ref<Conversation>()
const error = ref(''), busy = ref(false), locked = ref(false)
const backupInput = ref<HTMLInputElement>(), backupStatus = ref('')
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
async function exportBackup() {
  if (busy.value || locked.value) return
  busy.value = true
  try {
    const backup = await browserStore.exportBackup()
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = `pencil-${new Date().toISOString().slice(0, 10)}.pencil-backup.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    backupStatus.value = 'Workspace backup exported.'
  } catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
async function importBackup(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (!file || busy.value || locked.value) { input.value = ''; return }
  busy.value = true
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error('Workspace backups must be smaller than 50 MiB.')
    const ids = await browserStore.importBackup(JSON.parse(await file.text()))
    await refresh()
    if (ids[0]) {
      current.value = await browserStore.conversation(ids[0])
      localStorage.setItem('pencil:conversation', ids[0])
    }
    error.value = ''; backupStatus.value = `Imported ${ids.length} new conversation${ids.length === 1 ? '' : 's'}. Existing work was not replaced.`
  } catch (e) { error.value = `Import failed: ${String(e)}` }
  finally { busy.value = false; input.value = '' }
}
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
  <div v-if="error" class="error" role="alert">{{ error }}<button @click="refreshSafely">Retry</button></div>
  <ConversationWorkspace v-if="current" :key="current.id" :conversation="current" @refresh="refreshSafely" @lock="locked = $event">
    <template #header>
      <div class="panel-header">
        <div class="brand"><strong>Pencil</strong><small>Documents, slides &amp; pages · This browser</small></div>
        <div class="deck-picker">
          <select aria-label="Choose conversation" :value="current?.id" :disabled="busy || locked" @change="open(($event.target as HTMLSelectElement).value)">
            <option v-for="conversation in conversations" :key="conversation.id" :value="conversation.id">{{ conversation.title }}</option>
          </select>
          <button :disabled="busy || locked" @click="create" title="New conversation" aria-label="New conversation">+ New</button>
          <details class="shape-menu browser-storage-menu">
            <summary>Storage</summary>
            <div class="shape-options">
              <p>Work is saved only in this browser profile and site. Export a backup before clearing browser data or changing devices.</p>
              <button :disabled="busy || locked" @click="exportBackup">Export workspace backup</button>
              <button :disabled="busy || locked" @click="backupInput?.click()">Import workspace backup</button>
              <small v-if="backupStatus" role="status">{{ backupStatus }}</small>
            </div>
          </details>
          <input ref="backupInput" class="backup-file-input" type="file" accept=".json,application/json" aria-label="Import workspace backup file" @change="importBackup">
        </div>
      </div>
    </template>
  </ConversationWorkspace>
  <main v-else class="loading"><div class="brand"><strong>Pencil</strong></div>Opening your local studio...</main>
</template>

<style>
.browser-storage-menu > summary { padding: 8px; font-size: 11px; }
.browser-storage-menu .shape-options { width: 270px; padding: 12px; z-index: 90; left: 0; right: auto; }
.browser-storage-menu p { margin: 0 0 8px; font-size: 11px; line-height: 1.6; color: var(--muted); white-space: normal; }
.browser-storage-menu small { display: block; padding: 8px 0; white-space: normal; }
.backup-file-input { display: none; }
</style>
