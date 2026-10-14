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
    class="card flex flex-col overflow-hidden transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-card-hover"
    :class="{ 'opacity-60': book.isDeleted }"
  >
    <NuxtLink :to="`/books/${book.bookId}`" class="block">
      <BookCover
        :cover-url="book.coverUrl"
        :title="book.bookName"
        :author="book.author"
        class="w-full"
      />
    </NuxtLink>

    <div class="flex flex-1 flex-col gap-1 p-4">
      <NuxtLink
        :to="`/books/${book.bookId}`"
        class="line-clamp-2 font-semibold leading-snug transition-colors duration-150 hover:text-primary-700"
      >
        {{ book.bookName }}
      </NuxtLink>
      <p class="text-sm text-muted">
        {{ book.author }}
      </p>
      <p v-if="book.genre" class="mt-1">
        <span class="badge badge-neutral">{{ book.genre }}</span>
      </p>

      <div class="mt-auto flex items-center justify-between gap-2 pt-3">
        <span class="font-semibold">{{ formatPrice(book.price) }}</span>
        <span v-if="!purchasable" class="badge badge-neutral">
          Unavailable
        </span>
        <span v-else-if="book.available <= 5" class="badge badge-warning">
          Only {{ book.available }} left
        </span>
      </div>

      <button
        type="button"
        class="btn btn-primary mt-3 w-full"
        :disabled="!purchasable || adding"
        @click="addToCart"
      >
        {{ added ? "Added ✓" : adding ? "Adding…" : "Add to cart" }}
      </button>
    </div>
  </article>
</template>
