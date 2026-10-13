<script setup lang="ts">
import type { OrderList } from "~/utils/api";

definePageMeta({ middleware: "auth" });

const LIMIT = 12;
const route = useRoute();
const page = computed(() => parsePage(route.query.page));

const { data, status, error, refresh } = await useFetch<OrderList>(
  "/api/orders",
  {
    query: computed(() => ({
      offset: (page.value - 1) * LIMIT,
      limit: LIMIT
    }))
  }
);
const orders = computed(() => data.value?.orders ?? []);
const pages = computed(() => pageCount(data.value?.total ?? 0, LIMIT));

const acting = ref<string | null>(null);
const actionError = ref("");

async function act(orderId: string, action: "pay" | "cancel") {
  acting.value = orderId;
  actionError.value = "";
  try {
    await $fetch(`/api/orders/${orderId}/${action}`, { method: "POST" });
    await refresh();
  } catch (e) {
    const message = (e as { data?: { message?: string | string[] } })?.data
      ?.message;
    actionError.value = Array.isArray(message)
      ? message.join(", ")
      : (message ?? `Could not ${action} the order — please try again.`);
  } finally {
    acting.value = null;
  }
}

function goTo(nextPage: number) {
  navigateTo({ path: "/orders", query: { page: nextPage } });
}
</script>

<template>
  <section class="mx-auto max-w-3xl">
    <h1 class="mb-6 text-2xl font-bold">My orders</h1>

    <p
      v-if="error"
      class="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700"
    >
      Orders are unavailable right now — please try again later.
    </p>

    <div
      v-else-if="status === 'success' && orders.length === 0"
      class="rounded border border-gray-200 bg-white p-8 text-center text-gray-500"
    >
      <p>No orders yet.</p>
      <NuxtLink
        to="/"
        class="mt-2 inline-block text-indigo-600 hover:underline"
      >
        Browse the catalog →
      </NuxtLink>
    </div>

    <div v-else class="space-y-4">
      <article
        v-for="order in orders"
        :key="order.orderId"
        class="rounded-lg border border-gray-200 bg-white p-4"
      >
        <header class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span class="font-mono text-sm text-gray-500">{{
              order.orderId
            }}</span>
            <p v-if="order.createdAt" class="text-xs text-gray-400">
              {{ new Date(order.createdAt).toLocaleString("en-US") }}
            </p>
          </div>
          <span
            class="rounded px-2 py-0.5 text-xs font-semibold"
            :class="orderStatusBadge(order.status).classes"
          >
            {{ orderStatusBadge(order.status).label }}
          </span>
        </header>

        <ul class="mt-3 divide-y divide-gray-100 text-sm">
          <li
            v-for="item in order.items"
            :key="item.bookId"
            class="flex items-center justify-between py-1.5"
          >
            <span
              >{{ item.bookName }} — {{ item.author }} × {{ item.amount }}</span
            >
            <span>{{ formatPrice(item.price * item.amount) }}</span>
          </li>
        </ul>

        <footer class="mt-3 flex items-center justify-between">
          <span class="font-semibold"
            >Total: {{ formatPrice(order.totalPrice) }}</span
          >
          <div v-if="isOrderActionable(order.status)" class="flex gap-2">
            <button
              type="button"
              class="rounded border border-gray-300 px-3 py-1 text-sm text-gray-600 hover:border-red-300 hover:text-red-600 disabled:opacity-40"
              :disabled="acting === order.orderId"
              @click="act(order.orderId, 'cancel')"
            >
              Cancel
            </button>
            <button
              type="button"
              class="rounded bg-green-600 px-3 py-1 text-sm text-white hover:bg-green-700 disabled:bg-gray-300"
              :disabled="acting === order.orderId"
              @click="act(order.orderId, 'pay')"
            >
              Pay {{ formatPrice(order.totalPrice) }}
            </button>
          </div>
        </footer>
      </article>

      <p v-if="actionError" class="text-sm text-red-600">
        {{ actionError }}
      </p>
    </div>

    <PaginationBar :page="page" :pages="pages" @go="goTo" />
  </section>
</template>
