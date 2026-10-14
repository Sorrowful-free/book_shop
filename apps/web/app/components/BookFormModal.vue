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

// ---- cover upload (spec 08 §6.2): presign via the BFF, then a direct
// multipart POST to MinIO; the returned coverUrl lands in the URL field.
const uploading = ref(false);
const uploadError = ref("");
const coverPreview = ref<string | null>(null); // createObjectURL of the file
const uploadedCoverUrl = ref<string | null>(null); // server path it maps to

const previewSrc = computed(() => {
  const manual = form.value.coverUrl.trim();
  if (!manual) {
    return null;
  }
  // instant local preview for the just-uploaded file — no proxy round-trip;
  // a broken manual URL falls back to the BookCover placeholder by itself
  return manual === uploadedCoverUrl.value
    ? (coverPreview.value ?? manual)
    : manual;
});

async function onCoverSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // re-selecting the same file must fire again
  if (!file) {
    return;
  }
  uploadError.value = "";
  const invalid = validateCoverFile(file);
  if (invalid) {
    uploadError.value = invalid;
    return;
  }
  uploading.value = true;
  try {
    const coverUrl = await uploadCover(file);
    form.value.coverUrl = coverUrl;
    uploadedCoverUrl.value = coverUrl;
    if (coverPreview.value) {
      URL.revokeObjectURL(coverPreview.value);
    }
    coverPreview.value = URL.createObjectURL(file);
  } catch (error) {
    uploadError.value =
      error instanceof Error ? error.message : "Cover upload failed";
  } finally {
    uploading.value = false;
  }
}

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
    class="fixed inset-0 z-20 flex items-center justify-center bg-ink/40 p-4"
    @click.self="emit('close')"
  >
    <div
      class="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl"
    >
      <h2 class="mb-4 text-lg font-semibold">
        {{ book ? "Edit book" : "New book" }}
      </h2>

      <form class="grid grid-cols-2 gap-4" @submit.prevent="submit">
        <label class="col-span-2 text-sm font-medium">
          Title *
          <input v-model="form.bookName" required class="input mt-1" />
        </label>
        <label class="col-span-2 text-sm font-medium">
          Author *
          <input v-model="form.author" required class="input mt-1" />
        </label>
        <label class="text-sm font-medium">
          ISBN
          <input v-model="form.isbn" class="input mt-1" />
        </label>
        <label class="text-sm font-medium">
          Genre
          <input v-model="form.genre" list="known-genres" class="input mt-1" />
          <datalist id="known-genres">
            <option v-for="g in KNOWN_GENRES" :key="g" :value="g" />
          </datalist>
        </label>
        <label class="text-sm font-medium">
          Year
          <input v-model="form.year" type="number" min="0" class="input mt-1" />
        </label>
        <label class="text-sm font-medium">
          Price (USD) *
          <input
            v-model="form.price"
            type="number"
            min="0"
            step="0.01"
            required
            class="input mt-1"
          />
        </label>
        <label class="text-sm font-medium">
          Stock *
          <input
            v-model="form.stock"
            type="number"
            min="0"
            required
            class="input mt-1"
          />
        </label>
        <div class="col-span-2 text-sm font-medium">
          <label>
            Cover URL
            <input v-model="form.coverUrl" type="text" class="input mt-1" />
          </label>
          <div class="mt-2 flex items-center gap-3">
            <input
              type="file"
              :accept="COVER_ACCEPT"
              :disabled="uploading"
              class="w-full max-w-xs text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-primary-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-700 file:transition-colors hover:file:bg-primary-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50"
              @change="onCoverSelected"
            />
            <span v-if="uploading" class="text-xs font-normal text-muted">
              Uploading…
            </span>
            <BookCover
              :cover-url="previewSrc"
              :title="form.bookName"
              :author="form.author"
              class="w-24 shrink-0 rounded-lg border border-line"
            />
          </div>
          <p
            v-if="uploadError"
            class="mt-1 text-xs font-normal text-danger-600"
          >
            {{ uploadError }}
          </p>
        </div>
        <label class="col-span-2 text-sm font-medium">
          Description
          <textarea
            v-model="form.description"
            rows="3"
            class="input mt-1 h-auto py-2"
          />
        </label>

        <p v-if="props.error" class="alert alert-danger col-span-2">
          {{ props.error }}
        </p>

        <div class="col-span-2 mt-2 flex justify-end gap-2">
          <button
            type="button"
            class="btn btn-secondary"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="btn btn-primary"
            :disabled="submitting || uploading"
          >
            {{ book ? "Save changes" : "Create book" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
