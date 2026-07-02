<template>
  <div>
    <div class="welcome">
      <p class="welcome__greeting">Hello, {{ currentUser?.name || "Operator" }}</p>
      <h2 class="welcome__title">What would you like to do?</h2>
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
        <p class="menu-card__title">Receiving</p>
        <p class="menu-card__meta">Confirm arrivals and stock</p>
      </NuxtLink>

      <NuxtLink to="/picking" class="menu-card">
        <div class="menu-card__icon menu-card__icon--picking">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 21v-6"/>
            <path d="M12 21V9"/>
            <path d="M19 21V3"/>
          </svg>
        </div>
        <p class="menu-card__title">Picking</p>
        <p class="menu-card__meta">Scan, box, and finish orders</p>
      </NuxtLink>

      <NuxtLink to="/put-away" class="menu-card">
        <div class="menu-card__icon menu-card__icon--putaway">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z"/>
            <path d="m3 9 9-6 9 6"/>
            <path d="M12 3v6"/>
          </svg>
        </div>
        <p class="menu-card__title">Put-away</p>
        <p class="menu-card__meta">Move stock to shelves</p>
      </NuxtLink>

      <NuxtLink to="/goods-verify" class="menu-card">
        <div class="menu-card__icon menu-card__icon--verify">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>
            <path d="m9 12 2 2 4-4"/>
          </svg>
        </div>
        <p class="menu-card__title">Goods Verify</p>
        <p class="menu-card__meta">Verify shelf box contents</p>
      </NuxtLink>

      <NuxtLink to="/measuring" class="menu-card">
        <div class="menu-card__icon menu-card__icon--measuring">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z"/>
            <path d="M12 7v6"/>
            <path d="M9 10h6"/>
          </svg>
        </div>
        <p class="menu-card__title">Measuring</p>
        <p class="menu-card__meta">Weigh and pack boxes</p>
      </NuxtLink>

      <NuxtLink to="/ocr-demo" class="menu-card">
        <div class="menu-card__icon menu-card__icon--demo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
        </div>
        <p class="menu-card__title">Camera OCR</p>
        <p class="menu-card__meta">On-device text recognition</p>
      </NuxtLink>

      <NuxtLink to="/subject-segmentation-demo" class="menu-card">
        <div class="menu-card__icon menu-card__icon--demo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <circle cx="12" cy="10" r="3"/>
            <path d="M7 18a5 5 0 0 1 10 0"/>
          </svg>
        </div>
        <p class="menu-card__title">Segmentation</p>
        <p class="menu-card__meta">Isolate subjects in photos</p>
      </NuxtLink>

      <NuxtLink to="/object-detection-demo" class="menu-card">
        <div class="menu-card__icon menu-card__icon--demo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 3h18v18H3z"/>
            <path d="M8 12h8"/>
            <path d="M12 8v8"/>
          </svg>
        </div>
        <p class="menu-card__title">Object Detection</p>
        <p class="menu-card__meta">Detect objects with ML Kit</p>
      </NuxtLink>

      <NuxtLink to="/document-scanner-demo" class="menu-card">
        <div class="menu-card__icon menu-card__icon--demo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/>
            <path d="M14 2v6h6"/>
            <path d="M16 13H8"/>
            <path d="M16 17H8"/>
            <path d="M10 9H8"/>
          </svg>
        </div>
        <p class="menu-card__title">Document Scanner</p>
        <p class="menu-card__meta">Crop labels with ML Kit</p>
      </NuxtLink>

      <NuxtLink to="/opencv-rectangle-demo" class="menu-card">
        <div class="menu-card__icon menu-card__icon--demo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 3h18v18H3z"/>
            <path d="M3 9h18"/>
            <path d="M9 21V9"/>
          </svg>
        </div>
        <p class="menu-card__title">OpenCV Rectangles</p>
        <p class="menu-card__meta">Offline label rectangle finder</p>
      </NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ title: "Warehouse" });

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
.menu-card__icon--demo { background: linear-gradient(135deg, #64748b, #475569); }

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
