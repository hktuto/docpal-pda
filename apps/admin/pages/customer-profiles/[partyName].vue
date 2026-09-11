<script setup lang="ts">
const route = useRoute();
const partyName = route.params.partyName as string;
const api = useApi();

// The upstream-synced customer account (read-only) and the PDA-local profile
// soft-linked by customer_profiles.code = party_name — null when this customer
// has none yet, saving then creates it.
const account = ref<any | null>(null);
const profile = ref<any | null>(null);
const loaded = ref(false);
const error = ref("");
const saveError = ref("");

const form = reactive({ label: "", rule: "", remark: "" });

async function load() {
  try {
    const accounts = await api.get(`/admin/customer-accounts?partyName=${encodeURIComponent(partyName)}`);
    account.value = accounts[0] ?? null;
    const profiles = await api.get("/admin/customer-profiles");
    profile.value = profiles.find((p: any) => p.code === partyName) ?? null;
    form.label = profile.value?.label ?? "";
    form.rule = profile.value?.rule ?? "";
    form.remark = profile.value?.remark ?? "";
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loaded.value = true;
  }
}

async function save() {
  saveError.value = "";
  const payload = {
    label: form.label.trim(),
    rule: form.rule.trim() || null,
    remark: form.remark.trim() || null,
  };
  try {
    if (profile.value) {
      await api.patch(`/admin/customer-profiles/${encodeURIComponent(profile.value.code)}`, payload);
    } else {
      await api.post("/admin/customer-profiles", { code: partyName, ...payload });
    }
    navigateTo("/customer-profiles");
  } catch (e: any) {
    saveError.value = e.message;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.customerProfile.title", { name: partyName }) }}</h1>
      <div class="head-actions">
        <NuxtLink to="/customer-profiles" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-else-if="!loaded" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else>
      <div v-if="!account" class="error-banner">{{ $t("admin.pages.customerProfile.accountNotFound") }}</div>

      <div class="detail-card">
        <h3>{{ $t("admin.pages.customerProfile.accountInfo") }}</h3>
        <dl class="detail-list">
          <div>
            <dt>{{ $t("admin.pages.customerProfiles.customerName") }}</dt>
            <dd>{{ account?.partyName ?? "—" }}</dd>
          </div>
          <div>
            <dt>{{ $t("admin.pages.customerProfiles.customerCode") }}</dt>
            <dd>{{ account?.accountNumber ?? "—" }}</dd>
          </div>
          <div>
            <dt>{{ $t("admin.pages.customerProfiles.status") }}</dt>
            <dd>
              {{
                account?.accountStatus === "A"
                  ? $t("admin.pages.customerProfiles.active")
                  : $t("admin.pages.customerProfiles.inactive")
              }}
            </dd>
          </div>
        </dl>
      </div>

      <div class="detail-card">
        <h3>{{ $t("admin.pages.customerProfile.profileInfo") }}</h3>
        <div v-if="saveError" class="error-banner">{{ saveError }}</div>
        <form @submit.prevent="save">
          <div class="form-row">
            <label for="cp-label">{{ $t("admin.fields.label") }} <span class="req">*</span></label>
            <input id="cp-label" v-model="form.label" type="text" required :disabled="!account" />
          </div>
          <div class="form-row">
            <label for="cp-rule">{{ $t("admin.fields.rule") }}</label>
            <input id="cp-rule" v-model="form.rule" type="text" :disabled="!account" />
          </div>
          <div class="form-row">
            <label for="cp-remark">{{ $t("admin.fields.remark") }}</label>
            <input id="cp-remark" v-model="form.remark" type="text" :disabled="!account" />
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="navigateTo('/customer-profiles')">
              {{ $t("admin.common.cancel") }}
            </button>
            <button type="submit" class="btn btn-primary" :disabled="!account">
              {{ $t("admin.pages.customerProfile.saveProfile") }}
            </button>
          </div>
        </form>
      </div>
    </template>
  </div>
</template>

<style scoped>
.detail-card {
  max-width: 720px;
  background: #fff;
  border: 1px solid #e3e8ee;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.detail-list {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 24px;
}
.detail-list dt {
  color: #4a5560;
  font-size: 13px;
}
.detail-list dd {
  margin: 0;
  font-size: 13px;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
</style>
