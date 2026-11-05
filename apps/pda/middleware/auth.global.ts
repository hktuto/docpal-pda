export default defineNuxtRouteMiddleware(async (to) => {
  // Server picker is always reachable (logged in or out) so the environment
  // can be switched from any state.
  if (to.path === '/server') {
    return;
  }
  const { currentUser, restore } = useAuth();

  // A network blip / backend restart must not crash the navigation into
  // Nuxt's built-in error screen (which also removes <ServerDownOverlay>) —
  // restore() already seeded the stored session synchronously (audit
  // 2026-11-03 #4). Only a real 401 clears it inside getCurrentUser.
  try {
    await restore();
  } catch {
    // keep the stored session; the next API call / overlay handles the outage
  }

  // Login page is the only public route.
  if (to.path === "/login") {
    if (currentUser.value) {
      return navigateTo("/");
    }
    return;
  }

  if (!currentUser.value) {
    return navigateTo("/login");
  }
});
