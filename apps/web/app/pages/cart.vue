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

    <p v-if="status === 'pending'" class="card p-8 text-center text-muted">
      Loading your cart…
    </p>

    <p v-else-if="error" class="alert alert-danger">
      The cart is unavailable right now — please try again later.
    </p>

    <div v-else-if="items.length === 0" class="card p-8 text-center">
      <p class="text-muted">Your cart is empty.</p>
      <NuxtLink to="/" class="btn btn-primary mt-4">
        Browse the catalog
      </NuxtLink>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="item in items"
        :key="item.bookId"
        class="card flex items-center gap-4 p-4"
        :class="{
          'border-danger-300 bg-danger-50/50': isCartItemProblem(item)
        }"
      >
        <BookCover
          :title="item.bookName"
          :author="item.author"
          class="w-14 shrink-0 rounded-md"
        />

        <div class="min-w-0 flex-1">
          <template v-if="item.bookName">
            <NuxtLink
              :to="`/books/${item.bookId}`"
              class="font-semibold transition-colors duration-150 hover:text-primary-700"
            >
              {{ item.bookName }}
            </NuxtLink>
            <p class="text-sm text-muted">
              {{ item.author }}
            </p>
          </template>
          <p v-else class="text-sm text-muted">
            This book is no longer listed.
          </p>
          <p
            v-if="isCartItemProblem(item)"
            class="mt-1 text-xs font-medium text-danger-600"
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
          class="input w-16 px-2"
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
          class="btn btn-ghost px-2 text-danger-600 hover:text-danger-700"
          :disabled="mutating === item.bookId"
          @click="removeItem(item.bookId)"
        >
          Remove
        </button>
      </div>

      <div class="card p-4 sm:p-5">
        <div class="flex items-center justify-between">
          <span class="font-semibold">Total</span>
          <span class="text-lg font-bold">{{ formatPrice(total) }}</span>
        </div>

        <p v-if="mutationError" class="alert alert-danger mt-3">
          {{ mutationError }}
        </p>
        <p v-if="hasProblems" class="mt-2 text-sm text-danger-600">
          Fix the flagged positions before checking out.
        </p>

        <div class="mt-4 flex items-center justify-between">
          <button
            type="button"
            class="btn btn-ghost text-danger-600 hover:text-danger-700"
            @click="clearCart"
          >
            Clear cart
          </button>
          <NuxtLink
            to="/checkout"
            class="btn btn-primary"
            :class="{ 'pointer-events-none opacity-50': hasProblems }"
          >
            Proceed to checkout
          </NuxtLink>
        </div>
      </div>
    </div>
  </section>
</template>
