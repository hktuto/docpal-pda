// localStorage only exists on the client; never touch it during SSR/prerender.
// A stored token is not trusted on its own: it is validated against
// GET /auth/me, and the user must still belong to the admin group.
export default defineNuxtRouteMiddleware(async (to) => {
  if (!import.meta.client) return;

  const token = localStorage.getItem("admin_token");
  const clearSession = () => {
    localStorage.removeItem("admin_token");
    localStorage.removeItem("admin_user");
  };

  let valid = false;
  if (token) {
    try {
      const config = useRuntimeConfig();
      const res = await fetch(`${config.public.apiBaseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const user = await res.json();
        valid = Array.isArray(user?.groupCodes) && user.groupCodes.includes("admin");
      }
    } catch {
      valid = false;
    }
    if (!valid) clearSession();
  }

  if (to.path === "/login") {
    if (valid) return navigateTo("/");
    return;
  }
  // Token-login links validate and store their own session (the link may be
  // for a different user than any stored one).
  if (to.path === "/login-token") return;
  if (!valid) return navigateTo("/login");
});
