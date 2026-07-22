export default defineNuxtRouteMiddleware((to) => {
  // localStorage only exists on the client; never touch it during SSR/prerender.
  if (!import.meta.client) return;
  const hasToken = !!localStorage.getItem("admin_token");
  if (to.path === "/login") {
    if (hasToken) return navigateTo("/");
    return;
  }
  if (!hasToken) return navigateTo("/login");
});
