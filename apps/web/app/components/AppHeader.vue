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
  <header
    class="sticky top-0 z-10 border-b border-line bg-surface/80 backdrop-blur"
  >
    <div class="page flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <NuxtLink to="/" class="shrink-0 text-lg font-bold text-primary-700">
        Book Shop
      </NuxtLink>

      <nav
        class="order-2 ml-auto flex flex-wrap items-center justify-end gap-1.5"
      >
        <NuxtLink
          to="/cart"
          class="nav-link inline-flex items-center gap-1.5"
          active-class="nav-link-active"
        >
          Cart
          <span
            v-if="cartCount > 0"
            class="rounded-full bg-primary px-1.5 py-0.5 text-xs font-semibold leading-none text-white"
          >
            {{ cartCount }}
          </span>
        </NuxtLink>

        <template v-if="isLoggedIn">
          <NuxtLink
            to="/orders"
            class="nav-link"
            active-class="nav-link-active"
          >
            Orders
          </NuxtLink>
          <NuxtLink
            v-if="isStaff"
            to="/admin/books"
            class="nav-link"
            active-class="nav-link-active"
          >
            Admin
          </NuxtLink>
          <span class="hidden px-1 text-sm text-faint sm:inline">{{
            user?.userName
          }}</span>
          <button type="button" class="btn btn-secondary" @click="logout">
            Log out
          </button>
        </template>
        <template v-else>
          <NuxtLink to="/login" class="btn btn-secondary">Log in</NuxtLink>
          <NuxtLink to="/register" class="btn btn-primary">Sign up</NuxtLink>
        </template>
      </nav>

      <form
        class="order-3 w-full min-w-0 sm:order-none sm:w-auto sm:flex-1"
        @submit.prevent="submitSearch"
      >
        <input
          v-model="search"
          type="search"
          placeholder="Search books or authors…"
          class="input sm:mx-auto sm:max-w-md"
        />
      </form>
    </div>
  </header>
</template>
