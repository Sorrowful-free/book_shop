<script setup lang="ts">
import type { EnrichedCart } from "~/utils/api";
import { hasCookie } from "../../server/utils/proxy";

const { refreshCart, isLoggedIn } = useSession();

// An SSR fetch by a visitor with no cookies would mint an empty guest cart
// in Redis whose set-cookie is dropped with the sub-response — such carts
// load client-side instead, where the cookie is delivered for real.
const cookie = useRequestHeader("cookie") ?? "";
const { data, status, error, refresh } = await useFetch<EnrichedCart>(
  "/api/cart",
  {
    default: () => ({ items: [] }),
    server: isLoggedIn.value || hasCookie(cookie, "cart_id")
  }
);
const items = computed(() => data.value?.items ?? []);
const total = computed(() => cartTotal(items.value));
const hasProblems = computed(() => items.value.some(isCartItemProblem));

const mutating = ref<string | null>(null);
const mutationError = ref("");

async function sync() {
  await Promise.all([refresh(), refreshCart()]);
}

async function updateAmount(bookId: string, amount: number) {
  mutating.value = bookId;
  mutationError.value = "";
  try {
    await $fetch(`/api/cart/items/${bookId}`, {
      method: "PATCH",
      body: { amount }
    });
    await sync();
  } catch {
    mutationError.value = "Could not update the cart — please try again.";
  } finally {
    mutating.value = null;
  }
}

async function removeItem(bookId: string) {
  mutating.value = bookId;
  mutationError.value = "";
  try {
    await $fetch(`/api/cart/items/${bookId}`, { method: "DELETE" });
    await sync();
  } catch {
    mutationError.value = "Could not remove the item — please try again.";
  } finally {
    mutating.value = null;
  }
}

async function clearCart() {
  mutationError.value = "";
  try {
    await $fetch("/api/cart", { method: "DELETE" });
    await sync();
  } catch {
    mutationError.value = "Could not clear the cart — please try again.";
  }
}
</script>

<template>
  <section class="mx-auto max-w-3xl">
    <h1 class="mb-6 text-2xl font-bold">Your cart</h1>

    <p
      v-if="status === 'pending'"
      class="rounded border border-gray-200 bg-white p-8 text-center text-gray-500"
    >
      Loading your cart…
    </p>

    <p
      v-else-if="error"
      class="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700"
    >
      The cart is unavailable right now — please try again later.
    </p>

    <div
      v-else-if="items.length === 0"
      class="rounded border border-gray-200 bg-white p-8 text-center text-gray-500"
    >
      <p>Your cart is empty.</p>
      <NuxtLink
        to="/"
        class="mt-2 inline-block text-indigo-600 hover:underline"
      >
        Browse the catalog →
      </NuxtLink>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="item in items"
        :key="item.bookId"
        class="flex items-center gap-4 rounded-lg border border-gray-200 bg-white p-4"
        :class="{ 'border-red-300 bg-red-50/50': isCartItemProblem(item) }"
      >
        <div class="min-w-0 flex-1">
          <template v-if="item.bookName">
            <NuxtLink
              :to="`/books/${item.bookId}`"
              class="font-semibold hover:text-indigo-700"
            >
              {{ item.bookName }}
            </NuxtLink>
            <p class="text-sm text-gray-500">
              {{ item.author }}
            </p>
          </template>
          <p v-else class="text-sm text-gray-500">
            This book is no longer listed.
          </p>
          <p
            v-if="isCartItemProblem(item)"
            class="mt-1 text-xs font-medium text-red-600"
          >
            <template v-if="item.available === false">
              Unavailable — remove this item before checkout.
            </template>
            <template v-else>
              Only {{ item.available }} left in stock — reduce the quantity.
            </template>
          </p>
        </div>

        <input
          type="number"
          min="0"
          :value="item.amount"
          :disabled="mutating === item.bookId"
          class="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
          @change="
            updateAmount(
              item.bookId,
              Number(($event.target as HTMLInputElement).value)
            )
          "
        />

        <span class="w-20 text-right text-sm font-semibold">
          {{
            typeof item.price === "number"
              ? formatPrice(item.price * item.amount)
              : "—"
          }}
        </span>

        <button
          type="button"
          class="text-sm text-gray-400 hover:text-red-600"
          :disabled="mutating === item.bookId"
          @click="removeItem(item.bookId)"
        >
          Remove
        </button>
      </div>

      <div
        class="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-4"
      >
        <span class="font-semibold">Total</span>
        <span class="text-lg font-bold">{{ formatPrice(total) }}</span>
      </div>

      <p v-if="mutationError" class="text-sm text-red-600">
        {{ mutationError }}
      </p>
      <p v-if="hasProblems" class="text-sm text-red-600">
        Fix the flagged positions before checking out.
      </p>

      <div class="flex justify-between">
        <button
          type="button"
          class="text-sm text-gray-500 hover:text-red-600"
          @click="clearCart"
        >
          Clear cart
        </button>
        <NuxtLink
          to="/checkout"
          class="rounded bg-indigo-600 px-5 py-2 text-sm text-white"
          :class="
            hasProblems
              ? 'pointer-events-none bg-gray-300'
              : 'hover:bg-indigo-700'
          "
        >
          Proceed to checkout
        </NuxtLink>
      </div>
    </div>
  </section>
</template>
