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
const { refreshCart } = useSession();

async function act(orderId: string, action: "pay" | "cancel") {
  acting.value = orderId;
  actionError.value = "";
  try {
    await $fetch(`/api/orders/${orderId}/${action}`, { method: "POST" });
    await refresh();
    if (action === "pay") {
      // F-W1: by pay time the cart-service consumer has long applied the
      // event — reconcile the badge with the server state.
      await refreshCart();
    }
  } catch (e) {
    actionError.value = apiErrorMessage(
      e,
      `Could not ${action} the order — please try again.`
    );
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

    <p v-if="error" class="alert alert-danger">
      Orders are unavailable right now — please try again later.
    </p>

    <div
      v-else-if="status === 'success' && orders.length === 0"
      class="card p-8 text-center"
    >
      <p class="text-muted">No orders yet.</p>
      <NuxtLink to="/" class="btn btn-primary mt-4">
        Browse the catalog
      </NuxtLink>
    </div>

    <div v-else class="space-y-4">
      <article
        v-for="order in orders"
        :key="order.orderId"
        class="card p-4 sm:p-5"
      >
        <header class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span class="font-mono text-sm text-muted">{{
              order.orderId
            }}</span>
            <p v-if="order.createdAt" class="text-xs text-faint">
              {{ new Date(order.createdAt).toLocaleString("en-US") }}
            </p>
          </div>
          <span class="badge" :class="orderStatusBadge(order.status).classes">
            {{ orderStatusBadge(order.status).label }}
          </span>
        </header>

        <ul class="mt-3 divide-y divide-line text-sm">
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
              class="btn btn-secondary"
              :disabled="acting === order.orderId"
              @click="act(order.orderId, 'cancel')"
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-primary"
              :disabled="acting === order.orderId"
              @click="act(order.orderId, 'pay')"
            >
              Pay {{ formatPrice(order.totalPrice) }}
            </button>
          </div>
        </footer>
      </article>

      <p v-if="actionError" class="alert alert-danger">
        {{ actionError }}
      </p>
    </div>

    <PaginationBar :page="page" :pages="pages" @go="goTo" />
  </section>
</template>
