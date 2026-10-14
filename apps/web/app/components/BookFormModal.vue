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
const coverPreviewOk = ref(true);

watch(
  () => form.value.coverUrl,
  () => {
    // a broken URL typed/pasted by hand re-arms the preview check
    coverPreviewOk.value = true;
  }
);

const previewSrc = computed(() => {
  if (!coverPreviewOk.value) {
    return null;
  }
  const manual = form.value.coverUrl.trim();
  if (!manual) {
    return null;
  }
  // instant local preview for the just-uploaded file — no proxy round-trip
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
    coverPreviewOk.value = true;
  } catch (error) {
    uploadError.value =
      error instanceof Error ? error.message : "Cover upload failed";
  } finally {
    uploading.value = false;
  }
}

function onCoverPreviewError() {
  coverPreviewOk.value = false;
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
        <div class="col-span-2 text-sm">
          <label>
            Cover URL
            <input
              v-model="form.coverUrl"
              type="text"
              class="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
            />
          </label>
          <div class="mt-2 flex items-center gap-3">
            <input
              type="file"
              :accept="COVER_ACCEPT"
              :disabled="uploading"
              class="text-xs"
              @change="onCoverSelected"
            />
            <span v-if="uploading" class="text-xs text-gray-500">
              Uploading…
            </span>
            <img
              v-if="previewSrc"
              :src="previewSrc"
              alt="cover preview"
              class="h-16 w-12 rounded border border-gray-200 object-cover"
              @error="onCoverPreviewError"
            />
            <div
              v-else
              class="flex h-16 w-12 items-center justify-center rounded bg-indigo-50 text-[10px] text-indigo-300"
            >
              No cover
            </div>
          </div>
          <p v-if="uploadError" class="mt-1 text-xs text-red-600">
            {{ uploadError }}
          </p>
        </div>
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
            :disabled="submitting || uploading"
          >
            {{ book ? "Save changes" : "Create book" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
