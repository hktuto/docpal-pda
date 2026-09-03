<script setup lang="ts">
import type { FlowConfigState, SubInventoryRuleGroupRow, FromSubinventoryOrgGroupRow } from "~/utils/flowApi";

// Flow config editor (spec 2026-08-12-admin-flow-config-design.md): a
// structured form over the warehouse_config row "flow". Saves apply at
// runtime on the backend unless the FLOW_CONFIG env override is active.

const flow = useFlowApi();
const { t } = useI18n();

const STEPS = ["receiving", "put-away", "picking", "goods-verify", "measuring", "verify", "stock-search"] as const;

interface PatternDraft {
  poNoPattern: string;
  subInventoryCode: string;
}

interface GroupDraft {
  orgIdsText: string;
  defaultCode: string;
  patterns: PatternDraft[];
}

interface FromOrgGroupDraft {
  orgIdText: string;
  codesText: string;
}

const state = ref<FlowConfigState | null>(null);
const stepEnabled = reactive<Record<string, boolean>>({});
const allowDockStock = ref(true);
const autoCreateTasks = ref(false);
const suggestShelf = ref<"existing-stock" | "off">("existing-stock");
const allowedOrgIdsText = ref("");
const groups = ref<GroupDraft[]>([]);
const fromOrgGroups = ref<FromOrgGroupDraft[]>([]);

const loading = ref(true);
const saving = ref(false);
const error = ref("");
const saved = ref(false);

/** Comma/whitespace-separated integers; null when any token is invalid. */
function parseIntList(text: string): number[] | null {
  const tokens = text.split(/[,\s]+/).filter(Boolean);
  const nums = tokens.map(Number);
  return nums.every((n) => Number.isInteger(n)) ? nums : null;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    state.value = await flow.getFlowConfig();
    for (const s of STEPS) stepEnabled[s] = state.value.config.steps[s]?.enabled ?? true;
    allowDockStock.value = state.value.config.pickingAllocation.allowDockStock;
    autoCreateTasks.value = state.value.config.putAway.autoCreateTasks;
    suggestShelf.value = state.value.config.putAway.suggestShelf;
    allowedOrgIdsText.value = state.value.config.allowedOrgIds.join(", ");
    groups.value = state.value.config.receivingSubInventoryRules.map((g) => ({
      orgIdsText: g.orgIds.join(", "),
      defaultCode: g.default ?? "",
      patterns: g.patterns.map((p) => ({ poNoPattern: p.poNoPattern, subInventoryCode: p.subInventoryCode })),
    }));
    fromOrgGroups.value = (state.value.config.pickingFromSubinventoryOrgs ?? []).map((g) => ({
      orgIdText: String(g.orgId),
      codesText: g.fromSubinventories.join(", "),
    }));
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function addGroup() {
  groups.value.push({ orgIdsText: "", defaultCode: "", patterns: [{ poNoPattern: "", subInventoryCode: "" }] });
}

function removeGroup(index: number) {
  groups.value.splice(index, 1);
}

function addPattern(group: GroupDraft) {
  group.patterns.push({ poNoPattern: "", subInventoryCode: "" });
}

function removePattern(group: GroupDraft, index: number) {
  group.patterns.splice(index, 1);
}

function addFromOrgGroup() {
  fromOrgGroups.value.push({ orgIdText: "", codesText: "" });
}

function removeFromOrgGroup(index: number) {
  fromOrgGroups.value.splice(index, 1);
}

async function save() {
  saving.value = true;
  error.value = "";
  saved.value = false;
  try {
    const allowedOrgIds = parseIntList(allowedOrgIdsText.value);
    if (allowedOrgIds === null) {
      error.value = t("admin.pages.flowConfig.allowedOrgIdsInvalid");
      return;
    }
    const receivingSubInventoryRules: SubInventoryRuleGroupRow[] = [];
    for (const g of groups.value) {
      const orgIds = parseIntList(g.orgIdsText);
      const patterns = g.patterns
        .filter((p) => p.poNoPattern.trim() !== "" || p.subInventoryCode.trim() !== "")
        .map((p) => ({ poNoPattern: p.poNoPattern.trim(), subInventoryCode: p.subInventoryCode.trim() }));
      if (
        orgIds === null ||
        orgIds.length === 0 ||
        patterns.some((p) => p.poNoPattern === "" || p.subInventoryCode === "")
      ) {
        error.value = t("admin.pages.flowConfig.rulesInvalid");
        return;
      }
      receivingSubInventoryRules.push({
        orgIds,
        patterns,
        default: g.defaultCode.trim() === "" ? null : g.defaultCode.trim(),
      });
    }
    const pickingFromSubinventoryOrgs: FromSubinventoryOrgGroupRow[] = [];
    for (const g of fromOrgGroups.value) {
      const orgId = Number(g.orgIdText.trim());
      const fromSubinventories = g.codesText.split(/[,\s]+/).filter(Boolean);
      if (!Number.isInteger(orgId) || fromSubinventories.length === 0) {
        error.value = t("admin.pages.flowConfig.fromOrgsInvalid");
        return;
      }
      pickingFromSubinventoryOrgs.push({ orgId, fromSubinventories });
    }
    // Fully-expanded steps JSON — same shape the boot merge produces.
    const steps: Record<string, unknown> = {};
    for (const s of STEPS) steps[s] = { enabled: !!stepEnabled[s] };
    steps["picking"] = { ...steps["picking"], allocation: { allowDockStock: allowDockStock.value } };
    steps["put-away"] = {
      ...steps["put-away"],
      autoCreateTasks: autoCreateTasks.value,
      suggestShelf: suggestShelf.value,
    };
    state.value = await flow.saveFlowConfig({ steps, allowedOrgIds, receivingSubInventoryRules, pickingFromSubinventoryOrgs });
    saved.value = true;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.flowConfig.title") }}</h1>
    </div>

    <p v-if="loading">{{ $t("admin.common.loading") }}</p>
    <template v-else-if="state">
      <div v-if="state.envOverride" class="warn-banner">
        {{ $t("admin.pages.flowConfig.envOverrideWarning") }}
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.flowConfig.stepsSection") }}</h2>
        <label v-for="s in STEPS" :key="s" class="check-row">
          <input v-model="stepEnabled[s]" type="checkbox" />
          {{ $t(`admin.pages.flowConfig.steps.${s}`) }}
        </label>
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.flowConfig.pickingSection") }}</h2>
        <label class="check-row">
          <input v-model="allowDockStock" type="checkbox" />
          {{ $t("admin.pages.flowConfig.allowDockStock") }}
        </label>
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.flowConfig.putAwaySection") }}</h2>
        <label class="check-row">
          <input v-model="autoCreateTasks" type="checkbox" />
          {{ $t("admin.pages.flowConfig.autoCreateTasks") }}
        </label>
        <div class="form-row">
          <label for="fc-suggest">{{ $t("admin.pages.flowConfig.suggestShelf") }}</label>
          <select id="fc-suggest" v-model="suggestShelf">
            <option value="existing-stock">{{ $t("admin.pages.flowConfig.suggestShelfOn") }}</option>
            <option value="off">{{ $t("admin.pages.flowConfig.suggestShelfOff") }}</option>
          </select>
        </div>
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.flowConfig.orgIdsSection") }}</h2>
        <div class="form-row">
          <label for="fc-org-ids">{{ $t("admin.pages.flowConfig.allowedOrgIds") }}</label>
          <input id="fc-org-ids" v-model="allowedOrgIdsText" type="text" placeholder="2, 3" />
        </div>
        <p class="hint-text">{{ $t("admin.pages.flowConfig.allowedOrgIdsHint") }}</p>
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.flowConfig.rulesSection") }}</h2>
        <div v-for="(group, gi) in groups" :key="gi" class="rule-group">
          <div class="rule-row">
            <input
              v-model="group.orgIdsText"
              type="text"
              class="rule-orgs"
              :placeholder="$t('admin.pages.flowConfig.ruleOrgIds')"
              :title="$t('admin.pages.flowConfig.ruleOrgIds')"
            />
            <input
              v-model="group.defaultCode"
              type="text"
              class="rule-code"
              :placeholder="$t('admin.pages.flowConfig.groupDefault')"
              :title="$t('admin.pages.flowConfig.groupDefaultHint')"
            />
            <button class="btn btn-danger" type="button" @click="removeGroup(gi)">
              {{ $t("admin.pages.flowConfig.removeGroup") }}
            </button>
          </div>
          <div v-for="(pattern, pi) in group.patterns" :key="pi" class="rule-row rule-pattern-row">
            <input
              v-model="pattern.poNoPattern"
              type="text"
              class="rule-prefix"
              :placeholder="$t('admin.pages.flowConfig.rulePoPattern')"
              :title="$t('admin.pages.flowConfig.rulePoPattern')"
            />
            <input
              v-model="pattern.subInventoryCode"
              type="text"
              class="rule-code"
              :placeholder="$t('admin.pages.flowConfig.ruleSubInventory')"
              :title="$t('admin.pages.flowConfig.ruleSubInventory')"
            />
            <button class="btn btn-danger" type="button" @click="removePattern(group, pi)">
              {{ $t("admin.pages.flowConfig.removeRule") }}
            </button>
          </div>
          <div class="rule-pattern-row">
            <button class="btn" type="button" @click="addPattern(group)">
              {{ $t("admin.pages.flowConfig.addPattern") }}
            </button>
          </div>
        </div>
        <button class="btn" type="button" @click="addGroup">
          {{ $t("admin.pages.flowConfig.addGroup") }}
        </button>
        <p class="hint-text">{{ $t("admin.pages.flowConfig.rulesHint") }}</p>
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.flowConfig.fromOrgsSection") }}</h2>
        <div v-for="(group, gi) in fromOrgGroups" :key="gi" class="rule-group">
          <div class="rule-row">
            <input
              v-model="group.orgIdText"
              type="text"
              class="rule-code"
              :placeholder="$t('admin.pages.flowConfig.ruleTargetOrgId')"
              :title="$t('admin.pages.flowConfig.ruleTargetOrgId')"
            />
            <input
              v-model="group.codesText"
              type="text"
              class="rule-codes"
              :placeholder="$t('admin.pages.flowConfig.ruleFromSubinventories')"
              :title="$t('admin.pages.flowConfig.ruleFromSubinventories')"
            />
            <button class="btn btn-danger" type="button" @click="removeFromOrgGroup(gi)">
              {{ $t("admin.pages.flowConfig.removeGroup") }}
            </button>
          </div>
        </div>
        <button class="btn" type="button" @click="addFromOrgGroup">
          {{ $t("admin.pages.flowConfig.addGroup") }}
        </button>
        <p class="hint-text">{{ $t("admin.pages.flowConfig.fromOrgsHint") }}</p>
      </div>

      <div class="actions-row">
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? $t("admin.common.saving") : $t("admin.common.save") }}
        </button>
        <span v-if="saved" class="ok-text">{{ $t("admin.pages.flowConfig.saved") }}</span>
        <span v-if="error" class="error-text">{{ error }}</span>
      </div>
    </template>
    <p v-else class="error-text">{{ error }}</p>
  </div>
</template>

<style scoped>
.form-card {
  margin-bottom: 1rem;
}

.form-card h2 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0;
}

.form-row {
  margin-top: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.rule-group {
  border: 1px solid #dde4ea;
  border-radius: 6px;
  padding: 0.75rem;
  margin-bottom: 0.75rem;
}

.rule-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.rule-pattern-row {
  margin-left: 1.5rem;
}

/* match the global .form-row input look (main.css) — rule rows are inline,
   so they don't inherit it */
.rule-row input {
  padding: 7px 9px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
  font-size: 14px;
  font-family: inherit;
}

.rule-row .rule-orgs {
  width: 12rem;
}

.rule-row .rule-prefix {
  width: 12rem;
}

.rule-row .rule-code {
  width: 10rem;
}

.rule-row .rule-codes {
  width: 22rem;
}

.hint-text {
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
  color: var(--muted, #666);
}

.warn-banner {
  background: #fff8e1;
  border: 1px solid #f0c36d;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
}

.actions-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.ok-text {
  color: var(--ok, #2e7d32);
}

.error-text {
  color: var(--danger, #c62828);
}
</style>
