<script setup lang="ts">
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

const route = useRoute();
const partyName = route.params.partyName as string;
const api = useApi();
const { t } = useI18n();

// The upstream-synced customer account (read-only) plus all PDA-local
// profiles; the assigned one is the profile whose `customers` array contains
// this party name (a customer belongs to at most one profile).
const account = ref<any | null>(null);
const profiles = ref<any[]>([]);
const loaded = ref(false);
const error = ref("");
const saveError = ref("");
const assigning = ref(false);
const newProfileCode = ref("");

const profile = computed(
  () => profiles.value.find((p) => Array.isArray(p.customers) && p.customers.includes(partyName)) ?? null,
);

// SearchableSelect needs a writable model; setting it triggers the assign.
const assignedCode = computed({
  get: () => profile.value?.code ?? "",
  set: (code: string) => assignTo(code),
});
const profileOptions = computed<SearchableSelectOption[]>(() => [
  { value: "", label: t("admin.pages.customerProfile.noProfile") },
  ...profiles.value.map((p) => ({ value: p.code, label: `${p.label} (${p.code})` })),
]);

const form = reactive({ label: "", rule: "", remark: "" });

function resetForm() {
  form.label = profile.value?.label ?? "";
  form.rule = profile.value?.rule == null ? "" : JSON.stringify(profile.value.rule, null, 2);
  form.remark = profile.value?.remark ?? "";
}

async function load() {
  try {
    const [accounts, profileRows] = await Promise.all([
      api.get(`/admin/customer-accounts?partyName=${encodeURIComponent(partyName)}`),
      api.get("/admin/customer-profiles"),
    ]);
    account.value = accounts[0] ?? null;
    profiles.value = profileRows;
    resetForm();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loaded.value = true;
  }
}

function friendlyError(e: any): string {
  return typeof e?.message === "string" && e.message.includes("customer_already_assigned")
    ? t("admin.pages.customerProfile.customerAlreadyAssigned")
    : e.message;
}

async function assignTo(code: string) {
  const oldCode = profile.value?.code ?? "";
  if (code === oldCode) return;
  saveError.value = "";
  assigning.value = true;
  try {
    if (oldCode) {
      await api.put(`/admin/customer-profiles/${encodeURIComponent(oldCode)}/customers`, { remove: [partyName] });
    }
    if (code) {
      await api.put(`/admin/customer-profiles/${encodeURIComponent(code)}/customers`, { add: [partyName] });
    }
    profiles.value = await api.get("/admin/customer-profiles");
    resetForm();
  } catch (e: any) {
    saveError.value = friendlyError(e);
    await load();
  } finally {
    assigning.value = false;
  }
}

async function createProfile() {
  const code = newProfileCode.value.trim();
  if (!code) return;
  saveError.value = "";
  assigning.value = true;
  try {
    if (profile.value) {
      await api.put(`/admin/customer-profiles/${encodeURIComponent(profile.value.code)}/customers`, {
        remove: [partyName],
      });
    }
    await api.post("/admin/customer-profiles", { code, label: code, customers: [partyName] });
    newProfileCode.value = "";
    profiles.value = await api.get("/admin/customer-profiles");
    resetForm();
  } catch (e: any) {
    saveError.value = friendlyError(e);
    await load();
  } finally {
    assigning.value = false;
  }
}

async function save() {
  if (!profile.value) return;
  saveError.value = "";
  let rule: unknown = null;
  if (form.rule.trim()) {
    try {
      rule = JSON.parse(form.rule);
    } catch {
      saveError.value = t("admin.pages.customerProfile.invalidRuleJson");
      return;
    }
  }
  const payload = {
    label: form.label.trim(),
    rule,
    remark: form.remark.trim() || null,
  };
  try {
    await api.patch(`/admin/customer-profiles/${encodeURIComponent(profile.value.code)}`, payload);
    navigateTo("/customer-profiles");
  } catch (e: any) {
    saveError.value = friendlyError(e);
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
        <div class="form-row">
          <label for="cp-assign">{{ $t("admin.pages.customerProfile.assignedProfile") }}</label>
          <SearchableSelect
            v-model="assignedCode"
            :options="profileOptions"
            :all-label="$t('admin.pages.customerProfile.noProfile')"
            :aria-label="$t('admin.pages.customerProfile.assignedProfile')"
            :multiple="false"
            :show-all="false"
            :disabled="!account || assigning"
          />
        </div>
        <div class="form-row create-profile-row">
          <input
            v-model="newProfileCode"
            type="text"
            :placeholder="$t('admin.pages.customerProfile.newProfileCodePlaceholder')"
            :disabled="!account || assigning"
          />
          <button
            type="button"
            class="btn"
            :disabled="!account || assigning || !newProfileCode.trim()"
            @click="createProfile"
          >
            {{ $t("admin.pages.customerProfile.createNewProfile") }}
          </button>
        </div>
        <form @submit.prevent="save">
          <div class="form-row">
            <label for="cp-label">{{ $t("admin.fields.label") }} <span class="req">*</span></label>
            <input id="cp-label" v-model="form.label" type="text" required :disabled="!profile" />
          </div>
          <div class="form-row">
            <label for="cp-rule">{{ $t("admin.fields.rule") }}</label>
            <textarea
              id="cp-rule"
              v-model="form.rule"
              rows="5"
              :placeholder="$t('admin.pages.customerProfile.ruleJsonPlaceholder')"
              :disabled="!profile"
            ></textarea>
          </div>
          <div class="form-row">
            <label for="cp-remark">{{ $t("admin.fields.remark") }}</label>
            <input id="cp-remark" v-model="form.remark" type="text" :disabled="!profile" />
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="navigateTo('/customer-profiles')">
              {{ $t("admin.common.cancel") }}
            </button>
            <button type="submit" class="btn btn-primary" :disabled="!profile">
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
.create-profile-row {
  display: flex;
  gap: 10px;
  align-items: center;
}
.create-profile-row input {
  flex: 1;
}
</style>
