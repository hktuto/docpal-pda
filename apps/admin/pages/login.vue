<script setup lang="ts">
const api = useApi();
const { t } = useI18n();
const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    const res = await api.post<{ user: any; token: string }>("/auth/login", {
      username: username.value.trim(),
      password: password.value,
    });
    const groupCodes: string[] = res.user?.groupCodes ?? [];
    if (!groupCodes.includes("admin")) {
      error.value = t("admin.auth.noAdminAccess");
      return;
    }
    localStorage.setItem("admin_token", res.token);
    localStorage.setItem("admin_user", JSON.stringify(res.user));
    await navigateTo("/");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-box">
      <img src="/logoWithName.png" alt="DocPal" class="login-logo" />
      <h1>{{ $t("admin.home.title") }}</h1>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <form @submit.prevent="submit">
        <div class="form-row">
          <label for="username">{{ $t("admin.auth.username") }}</label>
          <input id="username" v-model="username" type="text" autocomplete="username" />
        </div>
        <div class="form-row">
          <label for="password">{{ $t("admin.auth.password") }}</label>
          <input id="password" v-model="password" type="password" autocomplete="current-password" />
        </div>
        <button type="submit" class="btn btn-primary" style="width: 100%" :disabled="busy">
          {{ busy ? $t("admin.auth.signingIn") : $t("admin.auth.signIn") }}
        </button>
      </form>
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
</style>
