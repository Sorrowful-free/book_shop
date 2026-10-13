<script setup lang="ts">
import type { RestBook } from "~/utils/api";

const props = defineProps<{ book: RestBook }>();
const { refreshCart } = useSession();

const adding = ref(false);
const added = ref(false);
const purchasable = computed(() => isBookPurchasable(props.book));

async function addToCart() {
  adding.value = true;
  try {
    await $fetch("/api/cart/items", {
      method: "POST",
      body: { bookId: props.book.bookId, amount: 1 }
    });
    await refreshCart();
    added.value = true;
    setTimeout(() => {
      added.value = false;
    }, 1500);
  } catch {
    // surfaced via the badge/cart state; keep the card quiet
  } finally {
    adding.value = false;
  }
}
</script>

<template>
  <article
    class="flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm"
    :class="{ 'opacity-60': book.isDeleted }"
  >
    <NuxtLink :to="`/books/${book.bookId}`" class="block">
      <img
        v-if="book.coverUrl"
        :src="book.coverUrl"
        :alt="book.bookName"
        class="h-44 w-full object-cover"
      />
      <div
        v-else
        class="flex h-44 w-full items-center justify-center bg-indigo-50 text-sm text-indigo-300"
      >
        No cover
      </div>
    </NuxtLink>

    <div class="flex flex-1 flex-col gap-1 p-3">
      <NuxtLink
        :to="`/books/${book.bookId}`"
        class="font-semibold leading-snug hover:text-indigo-700"
      >
        {{ book.bookName }}
      </NuxtLink>
      <p class="text-sm text-gray-500">
        {{ book.author }}
      </p>
      <p
        v-if="book.genre"
        class="text-xs uppercase tracking-wide text-gray-400"
      >
        {{ book.genre }}
      </p>

      <div class="mt-auto flex items-center justify-between pt-2">
        <span class="font-semibold">{{ formatPrice(book.price) }}</span>
        <span
          v-if="!purchasable"
          class="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-600"
        >
          Unavailable
        </span>
        <span v-else-if="book.available <= 5" class="text-xs text-amber-600">
          Only {{ book.available }} left
        </span>
      </div>

      <button
        type="button"
        class="mt-2 w-full rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        :disabled="!purchasable || adding"
        @click="addToCart"
      >
        {{ added ? "Added ✓" : adding ? "Adding…" : "Add to cart" }}
      </button>
    </div>
  </article>
</template>
