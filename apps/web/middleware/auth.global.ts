export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/labels' || to.path === '/carton' || to.path === '/box') {
    return;
  }
  const { currentUser, restore } = useAuth();

  await restore();

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
