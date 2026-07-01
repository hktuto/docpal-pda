<template>
  <div class="login">
    <div class="login__box">
      <p class="login__subtitle">Sign in to continue</p>

      <form class="login__form" @submit.prevent="onSubmit">
        <label>
          <span>Username</span>
          <input v-model="username" type="text" placeholder="operator" />
        </label>
        <label>
          <span>Password</span>
          <input v-model="password" type="password" placeholder="operator" />
        </label>
        <p v-if="error" class="login__error">{{ error }}</p>
        <button type="submit" class="btn" :disabled="submitting">
          {{ submitting ? "Signing in…" : "Sign in" }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";

definePageMeta({ layout: false });

const db = await useDb();
const { login } = useAuth();

const username = ref("operator");
const password = ref("DocPal2026!");
const error = ref<string | null>(null);
const submitting = ref(false);

async function onSubmit() {
  error.value = null;
  submitting.value = true;
  try {
    await login(db, username.value.trim(), password.value);
    await navigateTo("/home");
  } catch (e: any) {
    error.value = e?.message ?? "Login failed";
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: var(--bg);
}

.login__box {
  width: 100%;
  max-width: 360px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 2rem 1.5rem;
}

.login__title {
  margin: 0;
  text-align: center;
}

.login__subtitle {
  text-align: center;
  color: var(--muted);
  margin: 0.25rem 0 1.5rem;
}

.login__form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.login__form label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.875rem;
  font-weight: 500;
}

.login__error {
  color: var(--danger);
  font-size: 0.875rem;
  margin: 0;
}
</style>
