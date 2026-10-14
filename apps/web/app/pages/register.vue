<script setup lang="ts">
definePageMeta({ middleware: "guest" });

const { refreshUser, refreshCart } = useSession();

const userName = ref("");
const password = ref("");
const confirm = ref("");
const submitting = ref(false);
const error = ref("");

async function submit() {
  if (password.value !== confirm.value) {
    error.value = "Passwords do not match.";
    return;
  }
  submitting.value = true;
  error.value = "";
  try {
    await $fetch("/api/auth/register", {
      method: "POST",
      body: { userName: userName.value, password: password.value }
    });
    await Promise.all([refreshUser(), refreshCart()]);
    await navigateTo("/");
  } catch (e) {
    error.value = apiErrorMessage(e, "Registration failed — please try again.");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="mx-auto mt-8 max-w-sm">
    <h1 class="mb-6 text-center text-2xl font-bold">Sign up</h1>

    <form class="card space-y-4 p-6" @submit.prevent="submit">
      <label class="block text-sm font-medium">
        Username
        <input
          v-model="userName"
          required
          pattern="[A-Za-z0-9_]{3,32}"
          title="3-32 characters: letters, digits, underscore"
          autocomplete="username"
          class="input mt-1"
        />
        <span class="text-xs font-normal text-faint">
          3–32 characters: letters, digits, underscore
        </span>
      </label>
      <label class="block text-sm font-medium">
        Password
        <input
          v-model="password"
          type="password"
          required
          autocomplete="new-password"
          class="input mt-1"
        />
      </label>
      <label class="block text-sm font-medium">
        Confirm password
        <input
          v-model="confirm"
          type="password"
          required
          autocomplete="new-password"
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
        {{ submitting ? "Creating account…" : "Create account" }}
      </button>

      <p class="text-center text-sm text-muted">
        Already registered?
        <NuxtLink
          to="/login"
          class="font-medium text-primary-600 hover:underline"
        >
          Log in
        </NuxtLink>
      </p>
    </form>
  </section>
</template>
