<script setup lang="ts">
import type { EnrichedCart, RestOrder } from "~/utils/api";

definePageMeta({ middleware: "auth" });

const { refreshCart } = useSession();

const { data: cartData, error: cartError } = await useFetch<EnrichedCart>(
  "/api/cart",
  { default: () => ({ items: [] }) }
);
const items = computed(() => cartData.value?.items ?? []);
const total = computed(() => cartTotal(items.value));
const hasProblems = computed(() => items.value.some(isCartItemProblem));

const order = ref<RestOrder | null>(null);
const placing = ref(false);
const paying = ref(false);
const flowError = ref("");

/**
 * One idempotency key per page mount (crypto.randomUUID), reused across
 * retries — a retried "Place order" click can never create a duplicate.
 */
const idempotencyKey = ref("");
onMounted(() => {
  idempotencyKey.value = crypto.randomUUID();
});

async function placeOrder() {
  if (!idempotencyKey.value) {
    idempotencyKey.value = crypto.randomUUID();
  }
  placing.value = true;
  flowError.value = "";
  try {
    order.value = await $fetch<RestOrder>("/api/orders/checkout", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey.value }
    });
    await refreshCart();
  } catch (e) {
    flowError.value = apiErrorMessage(
      e,
      "Something went wrong — please try again."
    );
  } finally {
    placing.value = false;
  }
}

async function pay() {
  if (!order.value) {
    return;
  }
  paying.value = true;
  flowError.value = "";
  try {
    await $fetch(`/api/orders/${order.value.orderId}/pay`, { method: "POST" });
    await navigateTo("/orders");
  } catch (e) {
    flowError.value = apiErrorMessage(
      e,
      "Something went wrong — please try again."
    );
  } finally {
    paying.value = false;
  }
}
</script>

<template>
  <section class="mx-auto max-w-2xl">
    <h1 class="mb-6 text-2xl font-bold">Checkout</h1>

    <p
      v-if="cartError"
      class="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700"
    >
      The cart is unavailable right now — please try again later.
    </p>

    <div v-else-if="!order" class="space-y-4">
      <div
        v-if="items.length === 0"
        class="rounded border border-gray-200 bg-white p-8 text-center text-gray-500"
      >
        <p>Your cart is empty.</p>
        <NuxtLink
          to="/"
          class="mt-2 inline-block text-indigo-600 hover:underline"
        >
          Back to the catalog →
        </NuxtLink>
      </div>

      <template v-else>
        <div
          class="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white"
        >
          <div
            v-for="item in items"
            :key="item.bookId"
            class="flex items-center justify-between gap-4 p-4"
          >
            <div>
              <p class="font-semibold">
                {{ item.bookName ?? "Unlisted book" }}
              </p>
              <p class="text-sm text-gray-500">
                {{ item.author }} — {{ item.amount }} ×
                {{
                  typeof item.price === "number" ? formatPrice(item.price) : "—"
                }}
              </p>
              <p
                v-if="isCartItemProblem(item)"
                class="text-xs font-medium text-red-600"
              >
                Not enough stock — adjust the cart first.
              </p>
            </div>
            <span class="text-sm font-semibold">
              {{
                typeof item.price === "number"
                  ? formatPrice(item.price * item.amount)
                  : "—"
              }}
            </span>
          </div>
          <div class="flex items-center justify-between p-4">
            <span class="font-semibold">Total</span>
            <span class="text-lg font-bold">{{ formatPrice(total) }}</span>
          </div>
        </div>

        <p v-if="flowError" class="text-sm text-red-600">
          {{ flowError }}
        </p>

        <div class="flex justify-end">
          <button
            type="button"
            class="rounded bg-indigo-600 px-5 py-2 text-sm text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            :disabled="placing || hasProblems"
            @click="placeOrder"
          >
            {{ placing ? "Placing order…" : "Place order" }}
          </button>
        </div>
      </template>
    </div>

    <div v-else class="space-y-4">
      <div class="rounded-lg border border-green-200 bg-green-50 p-4">
        <p class="font-semibold text-green-800">Order created</p>
        <p class="text-sm text-green-700">
          Order <span class="font-mono">{{ order.orderId }}</span> —
          {{ order.items.length }} item(s), total
          {{ formatPrice(order.totalPrice) }}.
        </p>
      </div>

      <ul
        class="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white"
      >
        <li
          v-for="item in order.items"
          :key="item.bookId"
          class="flex items-center justify-between p-4 text-sm"
        >
          <span
            >{{ item.bookName }} — {{ item.author }} × {{ item.amount }}</span
          >
          <span class="font-semibold">{{
            formatPrice(item.price * item.amount)
          }}</span>
        </li>
      </ul>

      <p v-if="flowError" class="text-sm text-red-600">
        {{ flowError }}
      </p>

      <div class="flex justify-end gap-3">
        <NuxtLink
          to="/orders"
          class="rounded border border-gray-300 px-5 py-2 text-sm"
        >
          Pay later
        </NuxtLink>
        <button
          type="button"
          class="rounded bg-green-600 px-5 py-2 text-sm text-white hover:bg-green-700 disabled:bg-gray-300"
          :disabled="paying"
          @click="pay"
        >
          {{ paying ? "Paying…" : `Pay ${formatPrice(order.totalPrice)}` }}
        </button>
      </div>
    </div>
  </section>
</template>
