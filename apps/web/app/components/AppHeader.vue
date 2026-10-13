<script setup lang="ts">
const { user, isLoggedIn, isStaff, cartCount, logout } = useSession();
const route = useRoute();
const search = ref(
  typeof route.query.query === "string" ? route.query.query : ""
);

watch(
  () => route.query.query,
  (value) => {
    search.value = typeof value === "string" ? value : "";
  }
);

function submitSearch() {
  navigateTo({
    path: "/",
    query: search.value.trim() ? { query: search.value.trim() } : {}
  });
}
</script>

<template>
  <header class="sticky top-0 z-10 border-b border-gray-200 bg-white">
    <div class="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
      <NuxtLink to="/" class="text-xl font-bold text-indigo-700">
        Book Shop
      </NuxtLink>

      <form
        class="flex flex-1 items-center gap-2"
        @submit.prevent="submitSearch"
      >
        <input
          v-model="search"
          type="search"
          placeholder="Search books or authors…"
          class="w-full max-w-xs rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
        />
      </form>

      <nav class="ml-auto flex items-center gap-4 text-sm">
        <NuxtLink
          to="/cart"
          class="relative inline-flex items-center gap-1 hover:text-indigo-700"
        >
          Cart
          <span
            v-if="cartCount > 0"
            class="rounded-full bg-indigo-600 px-1.5 py-0.5 text-xs font-semibold text-white"
          >
            {{ cartCount }}
          </span>
        </NuxtLink>

        <template v-if="isLoggedIn">
          <NuxtLink to="/orders" class="hover:text-indigo-700">
            Orders
          </NuxtLink>
          <NuxtLink
            v-if="isStaff"
            to="/admin/books"
            class="hover:text-indigo-700"
          >
            Admin
          </NuxtLink>
          <span class="text-gray-500">{{ user?.userName }}</span>
          <button type="button" class="hover:text-indigo-700" @click="logout">
            Log out
          </button>
        </template>
        <template v-else>
          <NuxtLink to="/login" class="hover:text-indigo-700">
            Log in
          </NuxtLink>
          <NuxtLink
            to="/register"
            class="rounded bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-700"
          >
            Sign up
          </NuxtLink>
        </template>
      </nav>
    </div>
  </header>
</template>
