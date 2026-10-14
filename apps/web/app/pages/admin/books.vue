<script setup lang="ts">
import type { BookList, RestBook } from "~/utils/api";

definePageMeta({ middleware: "admin" });

const { user } = useSession();
/** EMPLOYER sees the table + create/edit; delete/restore stay Admin-only. */
const isAdmin = computed(() => user.value?.role === "ADMIN");

const route = useRoute();
const LIMIT = 12;
const page = computed(() => parsePage(route.query.page));
const searchQuery = computed(() =>
  typeof route.query.query === "string" && route.query.query !== ""
    ? route.query.query
    : undefined
);

const { data, status, error, refresh } = await useFetch<BookList>(
  "/api/books",
  {
    query: computed(() => ({
      offset: (page.value - 1) * LIMIT,
      limit: LIMIT,
      query: searchQuery.value
    }))
  }
);
const books = computed(() => data.value?.books ?? []);
const pages = computed(() => pageCount(data.value?.total ?? 0, LIMIT));

const searchInput = ref(searchQuery.value ?? "");
watch(searchQuery, () => {
  searchInput.value = searchQuery.value ?? "";
});

function applySearch() {
  navigateTo({
    path: "/admin/books",
    query: searchInput.value.trim() ? { query: searchInput.value.trim() } : {}
  });
}

function goTo(nextPage: number) {
  navigateTo({
    path: "/admin/books",
    query: { ...route.query, page: nextPage }
  });
}

const modalOpen = ref(false);
const editing = ref<RestBook | null>(null);
const formError = ref("");

function openCreate() {
  editing.value = null;
  formError.value = "";
  modalOpen.value = true;
}

function openEdit(book: RestBook) {
  editing.value = book;
  formError.value = "";
  modalOpen.value = true;
}

async function save(payload: Record<string, unknown>) {
  try {
    if (editing.value) {
      await $fetch(`/api/books/${editing.value.bookId}`, {
        method: "PATCH",
        body: payload
      });
    } else {
      await $fetch("/api/books", { method: "POST", body: payload });
    }
    modalOpen.value = false;
    await refresh();
  } catch (e) {
    formError.value = apiErrorMessage(e, "Request failed.");
  }
}

const actionError = ref("");

async function remove(book: RestBook) {
  if (!window.confirm(`Delete “${book.bookName}” by ${book.author}?`)) {
    return;
  }
  actionError.value = "";
  try {
    await $fetch(`/api/books/${book.bookId}`, { method: "DELETE" });
    await refresh();
  } catch (e) {
    actionError.value = apiErrorMessage(e, "Request failed.");
  }
}

async function restore(book: RestBook) {
  actionError.value = "";
  try {
    await $fetch(`/api/books/${book.bookId}/restore`, { method: "POST" });
    await refresh();
  } catch (e) {
    actionError.value = apiErrorMessage(e, "Request failed.");
  }
}
</script>

<template>
  <section>
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-bold">Books</h1>
      <div class="flex items-center gap-2">
        <form class="flex items-center gap-2" @submit.prevent="applySearch">
          <input
            v-model="searchInput"
            type="search"
            placeholder="Search title or author…"
            class="input w-56"
          />
          <button type="submit" class="btn btn-secondary">Search</button>
        </form>
        <button type="button" class="btn btn-primary" @click="openCreate">
          + New book
        </button>
      </div>
    </div>

    <p v-if="error" class="alert alert-danger">
      The catalog is unavailable right now — please try again later.
    </p>

    <div v-else class="card overflow-x-auto">
      <table class="min-w-full divide-y divide-line text-sm">
        <thead
          class="bg-page text-left text-xs font-medium uppercase tracking-wide text-muted"
        >
          <tr>
            <th class="px-4 py-3">Title</th>
            <th class="px-4 py-3">Author</th>
            <th class="px-4 py-3">Genre</th>
            <th class="px-4 py-3 text-right">Price</th>
            <th class="px-4 py-3 text-right">Stock</th>
            <th class="px-4 py-3 text-right">Available</th>
            <th class="px-4 py-3">Status</th>
            <th class="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-line">
          <tr
            v-for="book in books"
            :key="book.bookId"
            class="transition-colors duration-150 hover:bg-page"
            :class="{ 'bg-page text-faint': book.isDeleted }"
          >
            <td class="px-4 py-2.5 font-medium">
              <NuxtLink
                :to="`/books/${book.bookId}`"
                class="transition-colors duration-150 hover:text-primary-700 hover:underline"
              >
                {{ book.bookName }}
              </NuxtLink>
            </td>
            <td class="px-4 py-2.5">
              {{ book.author }}
            </td>
            <td class="px-4 py-2.5">
              {{ book.genre || "—" }}
            </td>
            <td class="px-4 py-2.5 text-right">
              {{ formatPrice(book.price) }}
            </td>
            <td class="px-4 py-2.5 text-right">
              {{ book.stock }}
            </td>
            <td class="px-4 py-2.5 text-right">
              {{ book.available }}
            </td>
            <td class="px-4 py-2.5">
              <span v-if="book.isDeleted" class="badge badge-neutral">
                Deleted
              </span>
              <span v-else class="badge badge-success">Active</span>
            </td>
            <td class="px-4 py-2.5 text-right">
              <div class="flex justify-end gap-1">
                <button
                  type="button"
                  class="btn btn-ghost text-primary-600 hover:text-primary-700"
                  @click="openEdit(book)"
                >
                  Edit
                </button>
                <template v-if="isAdmin">
                  <button
                    v-if="book.isDeleted"
                    type="button"
                    class="btn btn-ghost text-success-700 hover:text-success-800"
                    @click="restore(book)"
                  >
                    Restore
                  </button>
                  <button
                    v-else
                    type="button"
                    class="btn btn-ghost text-danger-600 hover:text-danger-700"
                    @click="remove(book)"
                  >
                    Delete
                  </button>
                </template>
              </div>
            </td>
          </tr>
          <tr v-if="status === 'success' && books.length === 0">
            <td colspan="8" class="px-4 py-8 text-center text-muted">
              No books found.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="actionError" class="alert alert-danger mt-3">
      {{ actionError }}
    </p>

    <PaginationBar :page="page" :pages="pages" @go="goTo" />

    <BookFormModal
      v-if="modalOpen"
      :book="editing"
      :error="formError"
      @save="save"
      @close="modalOpen = false"
    />
  </section>
</template>
