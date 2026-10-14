<script setup lang="ts">
// spec 09 §4.1 — shared cover: fixed 2:3 book ratio, `@error` fallback
// (spec 08 §6.3) to a neutral gradient with up to two initials from the
// title's first words ("The Hobbit" → "TH"), then the author's initials,
// then the bare gradient. Pass `class` for sizing/rounding.
const props = defineProps<{
  coverUrl?: string | null;
  title?: string;
  author?: string;
}>();

const coverOk = ref(true);
watch(
  () => props.coverUrl,
  () => {
    coverOk.value = true;
  }
);

const initials = computed(() => {
  const source = props.title?.trim() || props.author?.trim() || "";
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
});
</script>

<template>
  <div
    class="relative aspect-[2/3] overflow-hidden bg-gradient-to-br from-zinc-100 to-zinc-200"
  >
    <img
      v-if="coverUrl && coverOk"
      :src="coverUrl"
      :alt="title ?? ''"
      class="absolute inset-0 h-full w-full object-cover"
      @error="coverOk = false"
    />
    <div
      v-else-if="initials"
      class="absolute inset-0 flex items-center justify-center text-2xl font-semibold tracking-wider text-faint"
    >
      {{ initials }}
    </div>
  </div>
</template>
