<template>
  <div>
    <div class="welcome">
      <p class="welcome__greeting">{{ $t('home.greeting', { name: currentUser?.name || $t('home.operatorFallback') }) }}</p>
      <h2 class="welcome__title">{{ $t('home.prompt') }}</h2>
    </div>

    <div class="menu-grid">
      <NuxtLink to="/receiving" class="menu-card">
        <div class="menu-card__icon menu-card__icon--receiving">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
            <path d="m3.3 7 8.7 5 8.7-5"/>
            <path d="M12 22V12"/>
          </svg>
        </div>
        <p class="menu-card__title">{{ $t('home.menu.receiving.title') }}</p>
        <p class="menu-card__meta">{{ $t('home.menu.receiving.desc') }}</p>
      </NuxtLink>

      <NuxtLink to="/picking" class="menu-card">
        <div class="menu-card__icon menu-card__icon--picking">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 21v-6"/>
            <path d="M12 21V9"/>
            <path d="M19 21V3"/>
          </svg>
        </div>
        <p class="menu-card__title">{{ $t('home.menu.picking.title') }}</p>
        <p class="menu-card__meta">{{ $t('home.menu.picking.desc') }}</p>
      </NuxtLink>

      <NuxtLink to="/put-away" class="menu-card">
        <div class="menu-card__icon menu-card__icon--putaway">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z"/>
            <path d="m3 9 9-6 9 6"/>
            <path d="M12 3v6"/>
          </svg>
        </div>
        <p class="menu-card__title">{{ $t('home.menu.putAway.title') }}</p>
        <p class="menu-card__meta">{{ $t('home.menu.putAway.desc') }}</p>
      </NuxtLink>

      <NuxtLink to="/goods-verify" class="menu-card">
        <div class="menu-card__icon menu-card__icon--verify">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>
            <path d="m9 12 2 2 4-4"/>
          </svg>
        </div>
        <p class="menu-card__title">{{ $t('home.menu.goodsVerify.title') }}</p>
        <p class="menu-card__meta">{{ $t('home.menu.goodsVerify.desc') }}</p>
      </NuxtLink>

      <NuxtLink to="/measuring" class="menu-card">
        <div class="menu-card__icon menu-card__icon--measuring">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z"/>
            <path d="M12 7v6"/>
            <path d="M9 10h6"/>
          </svg>
        </div>
        <p class="menu-card__title">{{ $t('home.menu.measuring.title') }}</p>
        <p class="menu-card__meta">{{ $t('home.menu.measuring.desc') }}</p>
      </NuxtLink>

    </div>
  </div>
</template>

<script setup lang="ts">
const { t } = useI18n();
useHead({ title: t("meta.warehouse") });

const { currentUser } = useAuth();
</script>

<style scoped>
.welcome {
  margin-bottom: 1.5rem;
}

.welcome__greeting {
  margin: 0;
  color: var(--muted);
  font-size: 0.9375rem;
}

.welcome__title {
  margin: 0.25rem 0 0;
  font-size: 1.375rem;
  font-weight: 700;
  color: var(--text);
}

.menu-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
}

@media (max-width: 360px) {
  .menu-grid {
    grid-template-columns: 1fr;
  }
}

.menu-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 1.25rem;
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
}

.menu-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.08);
  border-color: var(--primary);
  text-decoration: none;
}

.menu-card__icon {
  width: 2.75rem;
  height: 2.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.75rem;
  margin-bottom: 0.875rem;
  color: white;
}

.menu-card__icon svg {
  width: 1.375rem;
  height: 1.375rem;
}

.menu-card__icon--receiving { background: linear-gradient(135deg, #00bfa5, #00a693); }
.menu-card__icon--picking { background: linear-gradient(135deg, #3b82f6, #2563eb); }
.menu-card__icon--putaway { background: linear-gradient(135deg, #f59e0b, #d97706); }
.menu-card__icon--verify { background: linear-gradient(135deg, #10b981, #059669); }
.menu-card__icon--measuring { background: linear-gradient(135deg, #8b5cf6, #7c3aed); }

.menu-card__title {
  margin: 0 0 0.25rem;
  font-size: 1rem;
  font-weight: 700;
  color: var(--text);
}

.menu-card__meta {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--muted);
  line-height: 1.35;
}
</style>
