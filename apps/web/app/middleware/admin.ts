import type { RestUser } from "~/utils/api";

export default defineNuxtRouteMiddleware(() => {
  const user = useState<RestUser | null>("user");
  const redirect = resolveAdminRedirect(user.value);
  if (redirect) {
    return navigateTo(redirect);
  }
});
