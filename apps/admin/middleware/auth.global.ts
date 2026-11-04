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
      if (res.status === 401 || res.status === 403) {
        clearSession();
      } else if (res.ok) {
        const user = await res.json();
        valid = Array.isArray(user?.groupCodes) && user.groupCodes.includes("admin");
        if (!valid) clearSession();
      } else {
        // Server-side blip (backend restart / 5xx): keep the session — the
        // next API call decides (audit 2026-11-03 #10). Safe since the
        // backend enforces the admin group on /admin/* itself.
        valid = true;
      }
    } catch {
      // Network error ≠ invalid token: bouncing to /login mid-edit here lost
      // admins their work on every deploy (audit 2026-11-03 #10).
      valid = true;
    }
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
