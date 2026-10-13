<script setup lang="ts">
definePageMeta({ middleware: "guest" });

const { refreshUser, refreshCart } = useSession();

const userName = ref("");
const password = ref("");
const submitting = ref(false);
const error = ref("");

async function submit() {
  submitting.value = true;
  error.value = "";
  try {
    await $fetch("/api/auth/login", {
      method: "POST",
      body: { userName: userName.value, password: password.value }
    });
    // cookies are set by the gateway through the proxy; refresh shared state
    await Promise.all([refreshUser(), refreshCart()]);
    await navigateTo("/");
  } catch (e) {
    error.value = apiErrorMessage(e, "Login failed — check your credentials.");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="mx-auto max-w-sm">
    <h1 class="mb-6 text-2xl font-bold">Log in</h1>

    <form
      class="space-y-4 rounded-lg border border-gray-200 bg-white p-6"
      @submit.prevent="submit"
    >
      <label class="block text-sm">
        Username
        <input
          v-model="userName"
          required
          pattern="[A-Za-z0-9_]{3,32}"
          autocomplete="username"
          class="mt-1 w-full rounded border border-gray-300 px-3 py-1.5 focus:border-indigo-500 focus:outline-none"
        />
      </label>
      <label class="block text-sm">
        Password
        <input
          v-model="password"
          type="password"
          required
          autocomplete="current-password"
          class="mt-1 w-full rounded border border-gray-300 px-3 py-1.5 focus:border-indigo-500 focus:outline-none"
        />
      </label>

      <p v-if="error" class="text-sm text-red-600">
        {{ error }}
      </p>

      <button
        type="submit"
        class="w-full rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:bg-gray-300"
        :disabled="submitting"
      >
        {{ submitting ? "Logging in…" : "Log in" }}
      </button>

      <p class="text-center text-sm text-gray-500">
        No account?
        <NuxtLink to="/register" class="text-indigo-600 hover:underline">
          Sign up
        </NuxtLink>
      </p>
    </form>
  </section>
</template>
