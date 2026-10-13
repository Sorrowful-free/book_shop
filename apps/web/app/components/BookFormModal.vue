<script setup lang="ts">
import type { RestBook } from "~/utils/api";

const props = defineProps<{ book: RestBook | null; error?: string }>();
const emit = defineEmits<{
  save: [payload: Record<string, unknown>];
  close: [];
}>();

interface BookForm {
  bookName: string;
  author: string;
  isbn: string;
  description: string;
  genre: string;
  year: string;
  coverUrl: string;
  price: string;
  stock: string;
}

function toForm(book: RestBook | null): BookForm {
  return {
    bookName: book?.bookName ?? "",
    author: book?.author ?? "",
    isbn: book?.isbn ?? "",
    description: book?.description ?? "",
    genre: book?.genre ?? "",
    year: book?.year !== undefined ? String(book.year) : "",
    coverUrl: book?.coverUrl ?? "",
    price: book !== null ? String(book.price) : "",
    stock: book !== null ? String(book.stock) : ""
  };
}

const form = ref<BookForm>(toForm(props.book));
const submitting = ref(false);

async function submit() {
  submitting.value = true;
  const payload: Record<string, unknown> = {
    bookName: form.value.bookName.trim(),
    author: form.value.author.trim(),
    price: Number(form.value.price),
    stock: Number.parseInt(form.value.stock, 10)
  };
  if (form.value.isbn.trim()) payload.isbn = form.value.isbn.trim();
  if (form.value.description.trim()) {
    payload.description = form.value.description.trim();
  }
  if (form.value.genre.trim()) payload.genre = form.value.genre.trim();
  if (form.value.year.trim()) {
    payload.year = Number.parseInt(form.value.year, 10);
  }
  if (form.value.coverUrl.trim()) payload.coverUrl = form.value.coverUrl.trim();
  emit("save", payload);
  submitting.value = false;
}
</script>

<template>
  <div
    class="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
      <h2 class="mb-4 text-lg font-semibold">
        {{ book ? "Edit book" : "New book" }}
      </h2>

      <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
        <label class="col-span-2 text-sm">
          Title *
          <input
            v-model="form.bookName"
            required
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
          />
        </label>
        <label class="col-span-2 text-sm">
          Author *
          <input
            v-model="form.author"
            required
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
          />
        </label>
        <label class="text-sm">
          ISBN
          <input
            v-model="form.isbn"
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
          />
        </label>
        <label class="text-sm">
          Genre
          <input
            v-model="form.genre"
            list="known-genres"
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
          />
          <datalist id="known-genres">
            <option v-for="g in KNOWN_GENRES" :key="g" :value="g" />
          </datalist>
        </label>
        <label class="text-sm">
          Year
          <input
            v-model="form.year"
            type="number"
            min="0"
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
          />
        </label>
        <label class="text-sm">
          Cover URL
          <input
            v-model="form.coverUrl"
            type="url"
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
          />
        </label>
        <label class="text-sm">
          Price (USD) *
          <input
            v-model="form.price"
            type="number"
            min="0"
            step="0.01"
            required
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
          />
        </label>
        <label class="text-sm">
          Stock *
          <input
            v-model="form.stock"
            type="number"
            min="0"
            required
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
          />
        </label>
        <label class="col-span-2 text-sm">
          Description
          <textarea
            v-model="form.description"
            rows="3"
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
          />
        </label>

        <p v-if="props.error" class="col-span-2 text-sm text-red-600">
          {{ props.error }}
        </p>

        <div class="col-span-2 mt-2 flex justify-end gap-2">
          <button
            type="button"
            class="rounded border border-gray-300 px-4 py-1.5 text-sm"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="rounded bg-indigo-600 px-4 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
            :disabled="submitting"
          >
            {{ book ? "Save changes" : "Create book" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
