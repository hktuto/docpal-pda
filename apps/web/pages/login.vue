<template>
  <div class="login">
    <div class="login__box">
      <div class="login__brand">
        <svg class="login__logo" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 8C8 5.79086 9.79086 4 12 4H28C30.2091 4 32 5.79086 32 8V32C32 34.2091 30.2091 36 28 36H12C9.79086 36 8 34.2091 8 32V8Z" fill="#00BFA5"/>
          <path d="M14 14H26V18H14V14Z" fill="white"/>
          <path d="M14 22H22V26H14V22Z" fill="white" fill-opacity="0.7"/>
        </svg>
        <span class="login__brand-name">{{ $t('login.brand') }}</span>
      </div>
      <p class="login__subtitle">{{ $t('login.subtitle') }}</p>

      <form class="login__form" @submit.prevent="onSubmit">
        <label>
          <span>{{ $t('login.username') }}</span>
          <input v-model="username" type="text" :placeholder="$t('login.placeholderUsername')" />
        </label>
        <label>
          <span>{{ $t('login.password') }}</span>
          <div class="login__password">
            <input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              :placeholder="$t('login.placeholderPassword')"
            />
            <button
              type="button"
              class="login__toggle"
              :aria-label="$t('actions.togglePassword')"
              @click="showPassword = !showPassword"
            >
              <svg v-if="showPassword" class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
                <circle cx="12" cy="12" r="3"/>
                <path d="m4 4 16 16"/>
              </svg>
              <svg v-else class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          </div>
        </label>
        <p v-if="error" class="login__error">{{ error }}</p>
        <button type="submit" class="btn login__submit" :disabled="submitting">
          {{ submitting ? $t('actions.signingIn') : $t('actions.signIn') }}
        </button>
      </form>

      <p class="login__qr-hint">{{ $t('login.qrHint') }}</p>

      <div class="login__server">
        <button type="button" class="login__change-server" @click="onChangeServer">
          {{ $t('login.changeServer') }}
        </button>
        <p class="login__current-host">{{ currentHost }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useErrorMessage } from "~/composables/errorMessage";
import { useHardwareScanner } from "~/composables/useHardwareScanner";

definePageMeta({ layout: false });

const { t } = useI18n();
useHead({ title: t('login.brand') });

const { login } = useAuth();
const errorMessage = useErrorMessage();

const username = ref("");
const password = ref("");
const showPassword = ref(false);
const error = ref<string | null>(null);
const submitting = ref(false);
const currentHost = ref("");

useHardwareScanner({
  onScan(value) {
    const parsed = parseQrLogin(value);
    if (parsed) {
      applyQrLogin(parsed.username, parsed.password);
      return true;
    }
    return false;
  },
});

onMounted(() => {
  currentHost.value = getApiBaseUrl();
});

function onChangeServer() {
  return navigateTo("/server");
}

function parseQrLogin(value: string): { username: string; password: string } | null {
  const idx = value.indexOf(":");
  if (idx <= 0 || idx === value.length - 1) return null;
  return {
    username: value.slice(0, idx).trim(),
    password: value.slice(idx + 1),
  };
}

function applyQrLogin(u: string, p: string) {
  username.value = u;
  password.value = p;
  void onSubmit();
}

async function onSubmit() {
  error.value = null;
  submitting.value = true;
  try {
    await login(username.value.trim(), password.value);
    await navigateTo("/");
  } catch (e: any) {
    error.value = errorMessage(e);
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
  background: linear-gradient(135deg, #00bfa5 0%, #2563eb 100%);
}

.login__box {
  width: 100%;
  max-width: 380px;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 1.25rem;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
  padding: 1.2rem 1rem;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.login__brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  margin-bottom: 0.25rem;
}

.login__logo {
  width: 2.5rem;
  height: 2.5rem;
}

.login__brand-name {
  font-size: 1.75rem;
  font-weight: 800;
  color: #00bfa5;
  letter-spacing: -0.02em;
}

.login__subtitle {
  text-align: center;
  color: var(--muted);
  margin: 0 0 1.75rem;
  font-size: 0.9375rem;
}

.login__form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.login__form label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text);
}

.login__password {
  position: relative;
}

.login__password input {
  padding-right: 2.75rem;
}

.login__toggle {
  position: absolute;
  right: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  width: 2rem;
  height: 2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--muted);
  cursor: pointer;
}

.login__toggle:hover {
  background: var(--bg);
}

.login__error {
  color: var(--danger);
  font-size: 0.875rem;
  margin: 0;
  text-align: center;
}

.login__submit {
  width: 100%;
  margin-top: 0.5rem;
}

.login__qr-hint {
  margin: 1rem 0 0;
  text-align: center;
  font-size: 0.8125rem;
  color: var(--muted);
}

.login__server {
  margin-top: 1.25rem;
  text-align: center;
}

.login__change-server {
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 0.875rem;
  cursor: pointer;
  text-decoration: underline;
  padding: 0.25rem 0.5rem;
}

.login__change-server:hover {
  color: var(--primary);
}

.login__current-host {
  margin: 0.25rem 0 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 0.7rem;
  color: var(--muted);
  word-break: break-all;
}

.login__footer {
  text-align: center;
  margin-top: 1.25rem;
}

.login__footer a {
  color: var(--muted);
  font-size: 0.875rem;
}

.login__footer a:hover {
  color: var(--primary);
}
</style>
