<script setup lang="ts">
const api = useApi();
// Demo convenience: prefill the seeded admin credentials.
const username = ref("admin");
const password = ref("DocPalAdmin2026!");
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
      error.value = "This account does not have admin access.";
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
      <h1>Warehouse Admin</h1>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <form @submit.prevent="submit">
        <div class="form-row">
          <label for="username">Username</label>
          <input id="username" v-model="username" type="text" autocomplete="username" />
        </div>
        <div class="form-row">
          <label for="password">Password</label>
          <input id="password" v-model="password" type="password" autocomplete="current-password" />
        </div>
        <button type="submit" class="btn btn-primary" style="width: 100%" :disabled="busy">
          {{ busy ? "Signing in…" : "Sign in" }}
        </button>
      </form>
    </div>
  </div>
</template>
