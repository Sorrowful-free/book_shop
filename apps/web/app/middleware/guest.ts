import type { RestUser } from "~/utils/api";

export default defineNuxtRouteMiddleware(() => {
  const user = useState<RestUser | null>("user");
  const redirect = resolveGuestRedirect(user.value);
  if (redirect) {
    return navigateTo(redirect);
  }
});
