<script setup lang="ts">
import type { BookList } from "~/utils/api";

const route = useRoute();
const LIMIT = 12;

const page = computed(() => parsePage(route.query.page));
const query = computed(() =>
  typeof route.query.query === "string" && route.query.query !== ""
    ? route.query.query
    : undefined
);
const genre = computed(() =>
  typeof route.query.genre === "string" && route.query.genre !== ""
    ? route.query.genre
    : undefined
);

const { data, status, error } = await useFetch<BookList>("/api/books", {
  query: computed(() => ({
    offset: (page.value - 1) * LIMIT,
    limit: LIMIT,
    query: query.value,
    genre: genre.value
  }))
});

const books = computed(() => data.value?.books ?? []);
const total = computed(() => data.value?.total ?? 0);
const pages = computed(() => pageCount(total.value, LIMIT));
const failed = computed(() => !!error.value);

const searchInput = ref(query.value ?? "");
const genreInput = ref(genre.value ?? "");
watch([query, genre], () => {
  searchInput.value = query.value ?? "";
  genreInput.value = genre.value ?? "";
});

function applyFilters() {
  navigateTo({
    path: "/",
    query: {
      ...(searchInput.value.trim() ? { query: searchInput.value.trim() } : {}),
      ...(genreInput.value.trim() ? { genre: genreInput.value.trim() } : {})
    }
  });
}

function goTo(nextPage: number) {
  navigateTo({
    path: "/",
    query: { ...route.query, page: nextPage }
  });
}
</script>

<template>
  <section>
    <div class="mb-6 flex flex-wrap items-end gap-3">
      <h1 class="text-2xl font-bold">Catalog</h1>
      <form
        class="flex flex-wrap items-center gap-2"
        @submit.prevent="applyFilters"
      >
        <input
          v-model="searchInput"
          type="search"
          placeholder="Search title or author…"
          class="rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
        />
        <input
          v-model="genreInput"
          list="storefront-genres"
          placeholder="Genre (any)"
          class="w-40 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
        />
        <datalist id="storefront-genres">
          <option v-for="g in KNOWN_GENRES" :key="g" :value="g" />
        </datalist>
        <button
          type="submit"
          class="rounded bg-indigo-600 px-4 py-1.5 text-sm text-white hover:bg-indigo-700"
        >
          Filter
        </button>
        <NuxtLink
          v-if="query || genre"
          to="/"
          class="text-sm text-gray-500 hover:underline"
        >
          Clear
        </NuxtLink>
      </form>
    </div>

    <p
      v-if="failed"
      class="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700"
    >
      The catalog is unavailable right now — please try again later.
    </p>

    <p
      v-else-if="status === 'success' && books.length === 0"
      class="rounded border border-gray-200 bg-white p-8 text-center text-gray-500"
    >
      No books found{{ query ? ` for “${query}”` : ""
      }}{{ genre ? ` in genre “${genre}”` : "" }}.
    </p>

    <div
      v-else
      class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
      :class="{ 'opacity-50': status === 'pending' }"
    >
      <BookCard v-for="book in books" :key="book.bookId" :book="book" />
    </div>

    <PaginationBar :page="page" :pages="pages" @go="goTo" />
  </section>
</template>
