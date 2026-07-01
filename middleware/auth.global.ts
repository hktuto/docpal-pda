export default defineNuxtRouteMiddleware((to) => {
  const { currentUser } = useAuth();

  // Login page is the only public route.
  if (to.path === "/") {
    if (currentUser.value) {
      return navigateTo("/home");
    }
    return;
  }

  if (!currentUser.value) {
    return navigateTo("/");
  }
});
