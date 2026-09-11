<script setup lang="ts">
// Sign-in via a token link: /login-token#token=<docpal-access-token>
// (fragment preferred — it is never sent to servers or written to logs) or
// /login-token?token=<docpal-access-token>. The DocPal token is exchanged at
// POST /auth/login-token for a warehouse session, with the same admin-group
// requirement as the password login.
const { t } = useI18n();
const route = useRoute();
const error = ref("");

function tokenFromUrl(): string | null {
  const match = window.location.hash.match(/(?:^|[#&])token=([^&]+)/);
  if (match) return decodeURIComponent(match[1]);
  const query = route.query.token;
  return typeof query === "string" && query ? query : null;
}

onMounted(async () => {
  const docpalToken = tokenFromUrl();
  // Strip the token from the URL immediately so it never lingers in history.
  window.history.replaceState(null, "", window.location.pathname);
  if (!docpalToken) {
    error.value = t("admin.auth.invalidOrExpiredLink");
    return;
  }
  try {
    const config = useRuntimeConfig();
    const res = await fetch(`${config.public.apiBaseUrl}/auth/login-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: docpalToken }),
    });
    if (!res.ok) {
      // 401: DocPal rejected the token; 403: no WMS/admin access.
      error.value = res.status === 403
        ? t("admin.auth.noAdminAccess")
        : t("admin.auth.invalidOrExpiredLink");
      return;
    }
    const body = await res.json();
    const groupCodes: string[] = body.user?.groupCodes ?? [];
    if (!groupCodes.includes("admin")) {
      error.value = t("admin.auth.noAdminAccess");
      return;
    }
    localStorage.setItem("admin_token", body.token);
    localStorage.setItem("admin_user", JSON.stringify(body.user));
    await navigateTo("/");
  } catch {
    error.value = t("admin.auth.invalidOrExpiredLink");
  }
});
</script>

<template>
  <div class="login-wrap">
    <div class="login-box">
      <img src="/logoWithName.png" alt="DocPal" class="login-logo" />
      <h1>{{ $t("admin.home.title") }}</h1>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <p v-else>{{ $t("admin.auth.signingInWithLink") }}</p>
      <div v-if="error" class="login-token-back">
        <NuxtLink to="/login" class="btn btn-primary">{{ $t("admin.auth.signIn") }}</NuxtLink>
      </div>
      <div class="login-lang">
        <LanguageSwitcher />
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-lang {
  margin-top: 14px;
}
.login-token-back {
  margin-top: 14px;
}
</style>
