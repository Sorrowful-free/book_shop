<script setup lang="ts">
import type { RestBook } from "~/utils/api";

const route = useRoute();
const { refreshCart } = useSession();

const { data: book, error } = await useFetch<RestBook>(
  `/api/books/${route.params.id}`
);
if (error.value) {
  throw createError({
    statusCode: error.value.statusCode ?? 500,
    statusMessage: error.value.statusCode === 404 ? "Book not found" : "Error"
  });
}

// spec 08 §6.3: broken cover URLs degrade to the placeholder.
const coverOk = ref(true);

const amount = ref(1);
const adding = ref(false);
const added = ref(false);
const purchasable = computed(() =>
  book.value ? isBookPurchasable(book.value) : false
);
const maxAmount = computed(() =>
  book.value ? Math.max(1, Math.min(book.value.available, 99)) : 1
);

async function addToCart() {
  if (!book.value) {
    return;
  }
  adding.value = true;
  try {
    await $fetch("/api/cart/items", {
      method: "POST",
      body: { bookId: book.value.bookId, amount: amount.value }
    });
    await refreshCart();
    added.value = true;
  } catch {
    // guest/session errors surface via the cart badge staying stale
  } finally {
    adding.value = false;
  }
}
</script>

<template>
  <section v-if="book" class="mx-auto max-w-3xl">
    <NuxtLink to="/" class="text-sm text-indigo-600 hover:underline">
      ← Back to catalog
    </NuxtLink>

    <div
      class="mt-4 flex flex-col gap-6 rounded-lg border border-gray-200 bg-white p-6 sm:flex-row"
    >
      <img
        v-if="book.coverUrl && coverOk"
        :src="book.coverUrl"
        :alt="book.bookName"
        class="h-64 w-48 rounded object-cover"
        @error="coverOk = false"
      />
      <div
        v-else
        class="flex h-64 w-48 items-center justify-center rounded bg-indigo-50 text-sm text-indigo-300"
      >
        No cover
      </div>

      <div class="flex-1">
        <h1 class="text-2xl font-bold">
          {{ book.bookName }}
        </h1>
        <p class="mt-1 text-gray-600">
          {{ book.author }}
        </p>
        <p
          v-if="book.genre"
          class="mt-1 text-xs uppercase tracking-wide text-gray-400"
        >
          {{ book.genre }}
        </p>
        <p v-if="book.isbn" class="mt-1 text-xs text-gray-400">
          ISBN {{ book.isbn }}
        </p>
        <p v-if="book.year" class="text-xs text-gray-400">
          {{ book.year }}
        </p>

        <p v-if="book.description" class="mt-4 text-sm text-gray-700">
          {{ book.description }}
        </p>

        <div class="mt-6 flex items-center gap-4">
          <span class="text-xl font-semibold">{{
            formatPrice(book.price)
          }}</span>
          <span
            v-if="book.isDeleted"
            class="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-600"
          >
            Unavailable
          </span>
          <span
            v-else-if="book.available === 0"
            class="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-600"
          >
            Out of stock
          </span>
          <span v-else class="text-sm text-green-700"
            >{{ book.available }} in stock</span
          >
        </div>

        <div v-if="purchasable" class="mt-4 flex items-center gap-3">
          <label class="text-sm text-gray-600">
            Qty
            <input
              v-model.number="amount"
              type="number"
              min="1"
              :max="maxAmount"
              class="ml-1 w-16 rounded border border-gray-300 px-2 py-1.5"
            />
          </label>
          <button
            type="button"
            class="rounded bg-indigo-600 px-5 py-2 text-sm text-white hover:bg-indigo-700 disabled:bg-gray-300"
            :disabled="adding"
            @click="addToCart"
          >
            {{ adding ? "Adding…" : "Add to cart" }}
          </button>
          <NuxtLink
            v-if="added"
            to="/cart"
            class="text-sm text-indigo-600 hover:underline"
          >
            In cart — go to cart →
          </NuxtLink>
        </div>
        <button
          v-else
          type="button"
          disabled
          class="mt-4 cursor-not-allowed rounded bg-gray-300 px-5 py-2 text-sm text-white"
        >
          Add to cart
        </button>
      </div>
    </div>
  </section>
</template>
