import type { EnrichedCart, RestUser } from "~/utils/api";

/**
 * Shared session state (spec 06 §4): `user`/`cart` useStates are populated
 * SSR-side by `plugins/session.ts` and refreshed here after every auth/cart
 * mutation so the header badge stays in sync.
 */
export function useSession() {
  const user = useState<RestUser | null>("user", () => null);
  const cart = useState<EnrichedCart | null>("cart", () => null);

  const isLoggedIn = computed(() => user.value !== null);
  const isAdmin = computed(
    () =>
      !!user.value &&
      (ADMIN_ROLES as readonly string[]).includes(user.value.role)
  );
  const cartCount = computed(() => cartItemCount(cart.value?.items));

  async function refreshUser(): Promise<void> {
    try {
      user.value = await $fetch<RestUser>("/api/auth/me");
    } catch {
      user.value = null;
    }
  }

  async function refreshCart(): Promise<void> {
    try {
      cart.value = await $fetch<EnrichedCart>("/api/cart");
    } catch {
      cart.value = null;
    }
  }

  /** Logout never fails client-side — the gateway clears cookies regardless. */
  async function logout(): Promise<void> {
    try {
      await $fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // session is gone anyway
    }
    user.value = null;
    await refreshCart();
    await navigateTo("/");
  }

  return {
    user,
    cart,
    isLoggedIn,
    isAdmin,
    cartCount,
    refreshUser,
    refreshCart,
    logout
  };
}
