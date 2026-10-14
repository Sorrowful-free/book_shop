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
  <section class="mx-auto mt-8 max-w-sm">
    <h1 class="mb-6 text-center text-2xl font-bold">Log in</h1>

    <form class="card space-y-4 p-6" @submit.prevent="submit">
      <label class="block text-sm font-medium">
        Username
        <input
          v-model="userName"
          required
          pattern="[A-Za-z0-9_]{3,32}"
          autocomplete="username"
          class="input mt-1"
        />
      </label>
      <label class="block text-sm font-medium">
        Password
        <input
          v-model="password"
          type="password"
          required
          autocomplete="current-password"
          class="input mt-1"
        />
      </label>

      <p v-if="error" class="alert alert-danger">
        {{ error }}
      </p>

      <button
        type="submit"
        class="btn btn-primary w-full"
        :disabled="submitting"
      >
        {{ submitting ? "Logging in…" : "Log in" }}
      </button>

      <p class="text-center text-sm text-muted">
        No account?
        <NuxtLink
          to="/register"
          class="font-medium text-primary-600 hover:underline"
        >
          Sign up
        </NuxtLink>
      </p>
    </form>
  </section>
</template>
