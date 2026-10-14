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
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">Catalog</h1>
        <p class="mt-0.5 text-sm text-muted">
          {{ total }} {{ total === 1 ? "book" : "books" }} found
        </p>
      </div>
      <form
        class="flex flex-wrap items-center gap-2"
        @submit.prevent="applyFilters"
      >
        <input
          v-model="searchInput"
          type="search"
          placeholder="Search title or author…"
          class="input w-52"
        />
        <input
          v-model="genreInput"
          list="storefront-genres"
          placeholder="Genre (any)"
          class="input w-40"
        />
        <datalist id="storefront-genres">
          <option v-for="g in KNOWN_GENRES" :key="g" :value="g" />
        </datalist>
        <button type="submit" class="btn btn-primary">Filter</button>
        <NuxtLink v-if="query || genre" to="/" class="btn btn-ghost">
          Clear
        </NuxtLink>
      </form>
    </div>

    <p v-if="failed" class="alert alert-danger">
      The catalog is unavailable right now — please try again later.
    </p>

    <p
      v-else-if="status === 'success' && books.length === 0"
      class="card p-8 text-center text-muted"
    >
      No books found{{ query ? ` for “${query}”` : ""
      }}{{ genre ? ` in genre “${genre}”` : "" }}.
    </p>

    <div
      v-else
      class="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4"
      :class="{ 'animate-pulse opacity-50': status === 'pending' }"
    >
      <BookCard v-for="book in books" :key="book.bookId" :book="book" />
    </div>

    <PaginationBar :page="page" :pages="pages" @go="goTo" />
  </section>
</template>
