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
  <section v-if="book" class="mx-auto max-w-4xl">
    <NuxtLink
      to="/"
      class="text-sm font-medium text-primary-600 transition-colors duration-150 hover:text-primary-700 hover:underline"
    >
      ← Back to catalog
    </NuxtLink>

    <div class="card mt-4 flex flex-col gap-8 p-6 sm:flex-row sm:p-8">
      <BookCover
        :cover-url="book.coverUrl"
        :title="book.bookName"
        :author="book.author"
        class="mx-auto w-full max-w-sm shrink-0 rounded-xl shadow-card sm:mx-0 sm:w-72"
      />

      <div class="flex-1">
        <h1 class="text-3xl font-bold tracking-tight">
          {{ book.bookName }}
        </h1>
        <p class="mt-2 text-lg text-muted">
          {{ book.author }}
        </p>
        <p v-if="book.genre" class="mt-3">
          <span class="badge badge-primary">{{ book.genre }}</span>
        </p>
        <p v-if="book.isbn" class="mt-3 text-xs text-faint">
          ISBN {{ book.isbn }}
        </p>
        <p v-if="book.year" class="text-xs text-faint">
          {{ book.year }}
        </p>

        <p v-if="book.description" class="mt-4 text-sm leading-relaxed">
          {{ book.description }}
        </p>

        <div class="mt-6 flex items-center gap-4">
          <span class="text-2xl font-semibold">{{
            formatPrice(book.price)
          }}</span>
          <span v-if="book.isDeleted" class="badge badge-neutral">
            Unavailable
          </span>
          <span v-else-if="book.available === 0" class="badge badge-danger">
            Out of stock
          </span>
          <span v-else class="text-sm font-medium text-success-700"
            >{{ book.available }} in stock</span
          >
        </div>

        <div v-if="purchasable" class="mt-5 flex flex-wrap items-center gap-3">
          <label class="text-sm text-muted">
            Qty
            <input
              v-model.number="amount"
              type="number"
              min="1"
              :max="maxAmount"
              class="input ml-1 inline-flex w-16"
            />
          </label>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="adding"
            @click="addToCart"
          >
            {{ adding ? "Adding…" : "Add to cart" }}
          </button>
          <NuxtLink
            v-if="added"
            to="/cart"
            class="text-sm font-medium text-primary-600 hover:underline"
          >
            In cart — go to cart →
          </NuxtLink>
        </div>
        <button v-else type="button" disabled class="btn btn-primary mt-5">
          Add to cart
        </button>
      </div>
    </div>
  </section>
</template>
