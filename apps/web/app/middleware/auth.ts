import type { RestUser } from "~/utils/api";

export default defineNuxtRouteMiddleware(() => {
  const user = useState<RestUser | null>("user");
  const redirect = resolveAuthRedirect(user.value);
  if (redirect) {
    return navigateTo(redirect);
  }
});
