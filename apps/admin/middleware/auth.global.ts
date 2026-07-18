export default defineNuxtRouteMiddleware((to) => {
  // localStorage only exists on the client; never touch it during SSR/prerender.
  if (!import.meta.client) return;
  const hasUser = !!localStorage.getItem("admin_user");
  if (to.path === "/login") {
    if (hasUser) return navigateTo("/");
    return;
  }
  if (!hasUser) return navigateTo("/login");
});
