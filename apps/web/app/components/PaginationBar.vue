<script setup lang="ts">
defineProps<{ page: number; pages: number }>();
const emit = defineEmits<{ go: [page: number] }>();
</script>

<template>
  <nav v-if="pages > 1" class="mt-8 flex items-center justify-center gap-3">
    <button
      type="button"
      class="btn btn-secondary"
      :disabled="page <= 1"
      @click="emit('go', page - 1)"
    >
      <span aria-hidden="true">‹</span> Prev
    </button>
    <span class="text-sm text-muted"
      >Page <span class="font-semibold text-primary-600">{{ page }}</span> of
      {{ pages }}</span
    >
    <button
      type="button"
      class="btn btn-secondary"
      :disabled="page >= pages"
      @click="emit('go', page + 1)"
    >
      Next <span aria-hidden="true">›</span>
    </button>
  </nav>
</template>
