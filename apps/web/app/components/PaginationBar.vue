<script setup lang="ts">
defineProps<{ page: number; pages: number }>();
const emit = defineEmits<{ go: [page: number] }>();
</script>

<template>
  <nav v-if="pages > 1" class="mt-6 flex items-center justify-center gap-2">
    <button
      type="button"
      class="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-40"
      :disabled="page <= 1"
      @click="emit('go', page - 1)"
    >
      ← Prev
    </button>
    <span class="text-sm text-gray-600">Page {{ page }} of {{ pages }}</span>
    <button
      type="button"
      class="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-40"
      :disabled="page >= pages"
      @click="emit('go', page + 1)"
    >
      Next →
    </button>
  </nav>
</template>
