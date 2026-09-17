<script setup lang="ts">
import type { SlideArtifact } from '../shared/chat'
defineProps<{ artifact: SlideArtifact; disabled?: boolean; current?: boolean }>()
defineEmits<{ open: [] }>()
</script>

<template>
  <button class="artifact-card" :disabled="disabled" @click="$emit('open')" :aria-label="`Open slide deck: ${artifact.title}`">
    <span class="artifact-card-icon" aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none"><rect x="8" y="7" width="26" height="20" rx="3" /><path d="M5 14v17a3 3 0 0 0 3 3h22M13 14h15M13 19h9" /></svg>
    </span>
    <span class="artifact-card-copy"><strong>{{ artifact.title }}</strong><small>{{ artifact.slideIds.length }} {{ artifact.slideIds.length === 1 ? 'slide' : 'slides' }} · {{ current ? 'Current deck' : `Saved revision ${artifact.revision}` }}</small><span>{{ current ? 'Open your canvas' : 'Open current deck' }} <span aria-hidden="true">↗</span></span></span>
  </button>
</template>
