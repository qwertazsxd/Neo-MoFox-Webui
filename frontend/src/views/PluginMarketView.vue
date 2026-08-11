<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppShell from '../components/common/AppShell.vue'
import Icon from '../components/common/Icon.vue'
import MdSelect from '../components/common/MdSelect.vue'
import PageHeader from '../components/common/PageHeader.vue'
import PluginMarketCard from '../components/plugin-market/PluginMarketCard.vue'
import PluginMarketDetail from '../components/plugin-market/PluginMarketDetail.vue'
import {
  getBatchMarketInstallPlan,
  getBatchMarketOperation,
  getMarketCapabilities,
  getMarketPlugins,
  startBatchMarketInstall,
} from '../api/modules/plugin-market'
import type {
  BatchInstallPlan,
  BatchMarketOperation,
  MarketCapabilities,
  MarketPlugin,
} from '../api/types/plugin-market'
import { useDialogStore } from '../utils/dialog'
import { useI18n } from '../utils/i18n'

type SelectOption = { label: string; value: string }
type MarketStateFilter = 'all' | 'installed' | 'updates' | 'not-installed'
type MarketSort = 'updated' | 'downloads' | 'rating' | 'name'

const { t } = useI18n()
const dialog = useDialogStore()
const route = useRoute()
const router = useRouter()
const plugins = ref<MarketPlugin[]>([])
const isLoading = ref(true)
const isRefreshing = ref(false)
const errorMessage = ref('')
const searchQuery = ref('')
const category = ref('')
const stateFilter = ref<MarketStateFilter>('all')
const sortBy = ref<MarketSort>('updated')
const capabilities = ref<MarketCapabilities | null>(null)
const batchMode = ref(false)
const selectedPluginIds = ref<string[]>([])
const isPlanningBatch = ref(false)
const batchOperation = ref<BatchMarketOperation | null>(null)

const selectedPluginId = computed(() => {
  const value = route.query.plugin
  return typeof value === 'string' ? value : ''
})

const batchSelectionCount = computed(() => selectedPluginIds.value.length)
const selectedPlugins = computed(() => selectedPluginIds.value
  .map((pluginId) => plugins.value.find((plugin) => plugin.plugin_id === pluginId))
  .filter((plugin): plugin is MarketPlugin => Boolean(plugin)))
const isBatchActive = computed(() => (
  batchOperation.value?.status === 'queued' || batchOperation.value?.status === 'running'
))
const batchInstallEnabled = computed(() => capabilities.value?.install_enabled === true)

const categoryOptions = computed<SelectOption[]>(() => [
  { label: t('pluginMarket.filters.allCategories'), value: '' },
  ...Array.from(new Set(plugins.value.flatMap((plugin) => plugin.categories)))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ label: value, value })),
])

const stateOptions = computed<SelectOption[]>(() => [
  { label: t('pluginMarket.filters.allStates'), value: 'all' },
  { label: t('pluginMarket.filters.installed'), value: 'installed' },
  { label: t('pluginMarket.filters.updates'), value: 'updates' },
  { label: t('pluginMarket.filters.notInstalled'), value: 'not-installed' },
])

const sortOptions = computed<SelectOption[]>(() => [
  { label: t('pluginMarket.sort.updated'), value: 'updated' },
  { label: t('pluginMarket.sort.downloads'), value: 'downloads' },
  { label: t('pluginMarket.sort.rating'), value: 'rating' },
  { label: t('pluginMarket.sort.name'), value: 'name' },
])

const visiblePlugins = computed(() => {
  const tokens = searchQuery.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const result = plugins.value.filter((plugin) => {
    if (category.value && !plugin.categories.includes(category.value)) return false
    if (stateFilter.value === 'installed' && !plugin.local_state.installed) return false
    if (stateFilter.value === 'updates' && !plugin.local_state.update_available) return false
    if (stateFilter.value === 'not-installed' && plugin.local_state.installed) return false
    const searchText = [
      plugin.plugin_id,
      plugin.display_name,
      plugin.summary,
      plugin.description,
      plugin.owner_login ?? '',
      plugin.owner_display_name ?? '',
      ...plugin.tags,
      ...plugin.categories,
    ].join(' ').toLocaleLowerCase()
    return tokens.every((token) => searchText.includes(token))
  })

  return result.sort((left, right) => {
    if (sortBy.value === 'downloads') return right.downloads_count - left.downloads_count
    if (sortBy.value === 'rating') return right.rating_avg - left.rating_avg
    if (sortBy.value === 'name') return left.display_name.localeCompare(right.display_name)
    return Date.parse(right.updated_at ?? '') - Date.parse(left.updated_at ?? '')
  })
})

async function loadPlugins(refresh = false): Promise<void> {
  errorMessage.value = ''
  if (refresh) isRefreshing.value = true
  else isLoading.value = true
  try {
    const result = await getMarketPlugins(refresh)
    plugins.value = result.plugins
  } catch (error: unknown) {
    errorMessage.value = errorText(error)
  } finally {
    isLoading.value = false
    isRefreshing.value = false
  }
}

function clearSearch(): void {
  searchQuery.value = ''
}

function isSelectable(plugin: MarketPlugin): boolean {
  return !plugin.local_state.installed || plugin.local_state.update_available
}

function toggleBatchMode(): void {
  if (isBatchActive.value || !batchInstallEnabled.value) return
  batchMode.value = !batchMode.value
  if (!batchMode.value) selectedPluginIds.value = []
}

function togglePluginSelection(pluginId: string): void {
  const plugin = plugins.value.find((item) => item.plugin_id === pluginId)
  if (!plugin || !isSelectable(plugin) || isBatchActive.value) return
  selectedPluginIds.value = selectedPluginIds.value.includes(pluginId)
    ? selectedPluginIds.value.filter((id) => id !== pluginId)
    : [...selectedPluginIds.value, pluginId]
}

function planSummary(plan: BatchInstallPlan): string {
  const runnable = plan.items.filter((item) => item.can_install)
  const blocked = plan.items.filter((item) => !item.can_install)
  const selected = runnable.filter((item) => item.source === 'selected')
  const dependencies = runnable.filter((item) => item.source === 'dependency')
  const lines = [
    t('pluginMarket.batch.planSelected', { count: String(selected.length) }),
    ...selected.map((item) => (
      `- ${item.display_name} (${item.action === 'update'
        ? t('pluginMarket.batch.update')
        : t('pluginMarket.batch.install')}) v${item.version?.version ?? '—'}`
    )),
  ]
  if (dependencies.length) {
    lines.push('', t('pluginMarket.batch.planDependencies', { count: String(dependencies.length) }))
    lines.push(...dependencies.map((item) => `- ${item.display_name} v${item.version?.version ?? '—'}`))
  }
  if (blocked.length) {
    lines.push('', t('pluginMarket.batch.planBlocked', { count: String(blocked.length) }))
    lines.push(...blocked.map((item) => (
      `- ${item.display_name}: ${item.blocking_reasons.join('；')}`
    )))
  }
  const warnings = runnable.flatMap((item) => (
    item.warnings.map((warning) => `${item.display_name}: ${warning}`)
  ))
  if (warnings.length) {
    lines.push('', t('pluginMarket.batch.planWarnings'), ...warnings.map((warning) => `- ${warning}`))
  }
  return lines.join('\n')
}

async function openBatchInstallPlan(): Promise<void> {
  if (
    !batchInstallEnabled.value
    || !batchSelectionCount.value
    || isPlanningBatch.value
    || isBatchActive.value
  ) return

  isPlanningBatch.value = true
  try {
    const plan = await getBatchMarketInstallPlan(selectedPluginIds.value)
    const confirmed = await dialog.confirm(
      planSummary(plan),
      t('pluginMarket.batch.planTitle'),
      t('pluginMarket.batch.confirmInstall'),
      t('pluginMarket.batch.cancel'),
    )
    if (!confirmed || !plan.can_install) return
    batchOperation.value = await startBatchMarketInstall(selectedPluginIds.value)
    void pollBatchOperation(batchOperation.value.operation_id)
  } catch (error: unknown) {
    await dialog.alert(errorText(error), t('pluginMarket.batch.errorTitle'))
  } finally {
    isPlanningBatch.value = false
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

async function pollBatchOperation(operationId: string): Promise<void> {
  try {
    while (true) {
      const operation = await getBatchMarketOperation(operationId)
      batchOperation.value = operation
      if (!['queued', 'running'].includes(operation.status)) {
        const restartRequired = operation.items.some((item) => item.restart_required)
        const result = [
          operation.message,
          t('pluginMarket.batch.resultCounts', {
            success: String(operation.success_count),
            failed: String(operation.failed_count),
            skipped: String(operation.skipped_count),
          }),
          restartRequired ? t('pluginMarket.batch.restartRequired') : '',
        ].filter(Boolean).join('\n')
        await dialog.alert(result, t('pluginMarket.batch.resultTitle'))
        selectedPluginIds.value = []
        await loadPlugins(true)
        return
      }
      await wait(1200)
    }
  } catch (error: unknown) {
    await dialog.alert(errorText(error), t('pluginMarket.batch.errorTitle'))
  }
}

async function closeDetail(): Promise<void> {
  if (window.history.state?.fromPluginMarketList === true) {
    router.back()
    return
  }
  const query = { ...route.query }
  delete query.plugin
  await router.replace({ name: 'plugin-market', query })
}

async function openConfig(pluginId: string): Promise<void> {
  await router.push({
    name: 'config-plugins',
    query: { plugin: pluginId },
  })
}

async function openManage(pluginId: string): Promise<void> {
  await router.push({
    name: 'plugin-detail',
    params: { name: pluginId },
  })
}

async function handlePluginChanged(): Promise<void> {
  await loadPlugins(true)
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message)
  }
  return t('pluginMarket.error.fallback')
}

onMounted(() => {
  void loadPlugins()
  void getMarketCapabilities()
    .then((result) => { capabilities.value = result })
    .catch(() => { capabilities.value = null })
})
</script>

<template>
  <AppShell no-padding>
    <PluginMarketDetail
      v-if="selectedPluginId"
      :key="selectedPluginId"
      :plugin-id="selectedPluginId"
      @close="closeDetail"
      @changed="handlePluginChanged"
      @configure="openConfig"
      @manage="openManage"
    />

    <section v-show="!selectedPluginId" class="market-page">
      <div class="market-header">
        <div class="header-row">
          <PageHeader
            :title="t('pluginMarket.title')"
            :subtitle="t('pluginMarket.subtitle')"
            icon="material-symbols:storefront-outline-rounded"
          />
          <button
            class="icon-button"
            type="button"
            :title="t('pluginMarket.refresh')"
            :aria-label="t('pluginMarket.refresh')"
            :disabled="isLoading || isRefreshing"
            @click="loadPlugins(true)"
          >
            <Icon
              icon="material-symbols:refresh-rounded"
              width="21"
              height="21"
              :class="{ spinning: isRefreshing }"
            />
          </button>
        </div>

        <div class="filter-bar">
          <label class="search-field">
            <span class="sr-only">{{ t('pluginMarket.searchPlaceholder') }}</span>
            <Icon icon="material-symbols:search-rounded" width="21" height="21" />
            <input v-model="searchQuery" type="search" :placeholder="t('pluginMarket.searchPlaceholder')" />
            <button
              v-if="searchQuery"
              type="button"
              :title="t('pluginMarket.clearSearch')"
              :aria-label="t('pluginMarket.clearSearch')"
              @click="clearSearch"
            >
              <Icon icon="material-symbols:close-rounded" width="19" height="19" />
            </button>
          </label>
          <div class="select-control">
            <span>{{ t('pluginMarket.filters.category') }}</span>
            <MdSelect
              v-model="category"
              :options="categoryOptions"
              :placeholder="t('pluginMarket.filters.allCategories')"
            />
          </div>
          <div class="select-control">
            <span>{{ t('pluginMarket.filters.state') }}</span>
            <MdSelect v-model="stateFilter" :options="stateOptions" />
          </div>
          <div class="select-control">
            <span>{{ t('pluginMarket.filters.sort') }}</span>
            <MdSelect v-model="sortBy" :options="sortOptions" />
          </div>
        </div>
      </div>

      <div class="market-content">
        <div v-if="isLoading" class="plugin-grid" aria-busy="true">
          <div v-for="index in 6" :key="index" class="skeleton-card">
            <span class="skeleton icon-skeleton"></span>
            <span class="skeleton title-skeleton"></span>
            <span class="skeleton line-skeleton"></span>
            <span class="skeleton line-skeleton short"></span>
          </div>
        </div>

        <div v-else-if="errorMessage" class="state-panel error-panel">
          <Icon icon="material-symbols:cloud-off-outline-rounded" width="48" height="48" />
          <h2>{{ t('pluginMarket.error.title') }}</h2>
          <p>{{ errorMessage }}</p>
          <button class="primary-button" type="button" @click="loadPlugins()">
            <Icon icon="material-symbols:refresh-rounded" width="19" height="19" />
            {{ t('pluginMarket.retry') }}
          </button>
        </div>

        <template v-else>
          <div class="result-summary">
            <strong>{{ t('pluginMarket.resultCount', { count: String(visiblePlugins.length) }) }}</strong>
            <span v-if="visiblePlugins.length !== plugins.length">
              {{ t('pluginMarket.totalCount', { count: String(plugins.length) }) }}
            </span>
          </div>

          <label class="batch-mode-option">
            <input
              type="checkbox"
              :checked="batchMode"
              :disabled="!batchInstallEnabled || isBatchActive"
              @change="toggleBatchMode"
            />
            <span>{{ t('pluginMarket.batch.mode') }}</span>
          </label>

          <aside
            v-if="batchMode"
            class="batch-action-bar"
            :class="{ active: isBatchActive }"
            :aria-busy="isBatchActive"
          >
            <template v-if="isBatchActive && batchOperation">
              <div class="batch-operation-panel" :class="batchOperation.status">
                <div class="batch-operation-heading">
                  <Icon
                    :icon="batchOperation.status === 'failed'
                      ? 'material-symbols:error-outline-rounded'
                      : 'material-symbols:sync-rounded'"
                    width="22"
                    height="22"
                    class="spinning"
                  />
                  <div>
                    <strong>{{ batchOperation.message }}</strong>
                    <span>
                      {{ t('pluginMarket.batch.resultCounts', {
                        success: String(batchOperation.success_count),
                        failed: String(batchOperation.failed_count),
                        skipped: String(batchOperation.skipped_count),
                      }) }}
                    </span>
                  </div>
                  <em>{{ batchOperation.progress }}%</em>
                </div>
                <div
                  class="batch-progress-track"
                  role="progressbar"
                  :aria-valuenow="batchOperation.progress"
                  aria-valuemin="0"
                  aria-valuemax="100"
                >
                  <span :style="{ width: `${batchOperation.progress}%` }"></span>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="batch-selection-content">
                <div
                  class="batch-chip-picker"
                  :aria-label="t('pluginMarket.batch.selectionCount', {
                    count: String(batchSelectionCount),
                  })"
                >
                  <span v-if="!selectedPlugins.length" class="batch-chip-placeholder">
                    {{ t('pluginMarket.batch.selectHint') }}
                  </span>
                  <button
                    v-for="plugin in selectedPlugins"
                    :key="plugin.plugin_id"
                    class="batch-selection-chip"
                    type="button"
                    :title="t('pluginMarket.batch.deselectPlugin', { name: plugin.display_name })"
                    @click="togglePluginSelection(plugin.plugin_id)"
                  >
                    <span>{{ plugin.display_name }}</span>
                    <Icon icon="material-symbols:close-rounded" width="17" height="17" />
                  </button>
                </div>
                <small>{{ t('pluginMarket.batch.latestHint') }}</small>
              </div>
              <div class="batch-actions">
                <button
                  class="text-button"
                  type="button"
                  :disabled="!batchSelectionCount"
                  @click="selectedPluginIds = []"
                >
                  {{ t('pluginMarket.batch.clearSelection') }}
                </button>
                <button
                  class="primary-button batch-install-button"
                  type="button"
                  :disabled="!batchInstallEnabled || !batchSelectionCount || isPlanningBatch"
                  @click="openBatchInstallPlan"
                >
                  <Icon
                    :icon="isPlanningBatch
                      ? 'material-symbols:progress-activity-rounded'
                      : 'material-symbols:download-rounded'"
                    width="19"
                    height="19"
                    :class="{ spinning: isPlanningBatch }"
                  />
                  {{ isPlanningBatch
                    ? t('pluginMarket.batch.planning')
                    : t('pluginMarket.batch.installSelected', {
                      count: String(batchSelectionCount),
                    }) }}
                </button>
              </div>
            </template>
          </aside>

          <div v-if="visiblePlugins.length" class="plugin-grid">
            <PluginMarketCard
              v-for="plugin in visiblePlugins"
              :key="plugin.plugin_id"
              :plugin="plugin"
              :selection-mode="batchMode"
              :selected="selectedPluginIds.includes(plugin.plugin_id)"
              :selectable="isSelectable(plugin) && !isBatchActive"
              @toggle-selection="togglePluginSelection"
            />
          </div>

          <div v-else class="state-panel">
            <Icon icon="material-symbols:search-off-rounded" width="52" height="52" />
            <h2>{{ t('pluginMarket.empty.title') }}</h2>
            <p>{{ t('pluginMarket.empty.description') }}</p>
          </div>
        </template>
      </div>
    </section>
  </AppShell>
</template>

<style scoped>
.market-page {
  height: calc(100dvh - var(--app-top-bar-height, 64px) - var(--app-bottom-nav-height, 0px));
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.text-button {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 12px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 8px;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-low);
  font: inherit;
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
}

.text-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.batch-mode-option {
  width: fit-content;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  color: var(--md-sys-color-on-surface);
  font-size: 0.86rem;
  font-weight: 700;
  cursor: pointer;
}

.batch-mode-option input {
  width: 18px;
  height: 18px;
  margin: 0;
  accent-color: var(--md-sys-color-primary);
  cursor: pointer;
}

.batch-mode-option input:disabled {
  cursor: not-allowed;
}

.batch-action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin: 0 0 1rem;
  padding: 12px 14px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 8px;
  background: var(--md-sys-color-surface-container-low);
}

.batch-action-bar.active {
  display: block;
  padding: 13px 14px;
}

.batch-selection-content {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 7px;
}

.batch-selection-content small {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.76rem;
}

.batch-chip-picker {
  min-height: 48px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 8px;
  background: var(--md-sys-color-surface-container);
}

.batch-chip-placeholder {
  padding: 0 4px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.84rem;
}

.batch-selection-chip {
  min-width: 0;
  max-width: 260px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px 5px 10px;
  border: 0;
  border-radius: 9999px;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-highest);
  font: inherit;
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
}

.batch-selection-chip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-selection-chip:hover {
  color: var(--md-sys-color-on-error-container);
  background: var(--md-sys-color-error-container);
}

.batch-actions {
  display: flex;
  align-items: stretch;
  gap: 10px;
  flex: 0 0 auto;
}

.batch-actions > button {
  height: 56px;
  min-height: 56px;
  margin-top: 0;
  box-sizing: border-box;
}

.batch-install-button {
  margin-top: 0;
}

.batch-operation-panel {
  color: var(--md-sys-color-on-surface);
}

.batch-operation-heading {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
}

.batch-operation-heading div {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.batch-operation-heading span,
.batch-operation-heading em {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.76rem;
  font-style: normal;
  overflow-wrap: anywhere;
}

.batch-progress-track {
  height: 5px;
  margin-top: 10px;
  overflow: hidden;
  border-radius: 9999px;
  background: var(--md-sys-color-surface-container-highest);
}

.batch-progress-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--md-sys-color-primary);
  transition: width 0.25s ease;
}

.market-header {
  flex: 0 0 auto;
  padding: 1.5rem 1.5rem 1.25rem;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: color-mix(in srgb, var(--md-sys-color-surface) 82%, transparent);
  backdrop-filter: blur(12px);
}

.header-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.header-row :deep(.page-header) {
  margin-bottom: 1.25rem;
}

.icon-button,
.search-field button {
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 0;
  cursor: pointer;
  color: var(--md-sys-color-on-surface-variant);
  background: transparent;
}

.icon-button {
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 8px;
  background: var(--md-sys-color-surface-container-low);
}

.icon-button:hover:not(:disabled) {
  background: var(--md-sys-color-surface-container-high);
}

.icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.filter-bar {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(150px, 190px) minmax(150px, 190px) minmax(150px, 190px);
  gap: 12px;
  align-items: end;
}

.search-field {
  height: 48px;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 32px;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 14px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 8px;
  color: var(--md-sys-color-on-surface-variant);
  background: var(--md-sys-color-surface-container-lowest);
}

.search-field:focus-within {
  border-color: var(--md-sys-color-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--md-sys-color-primary) 18%, transparent);
}

.search-field input {
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  outline: 0;
  color: var(--md-sys-color-on-surface);
  background: transparent;
  font: inherit;
}

.search-field button {
  width: 32px;
  height: 32px;
  border-radius: 50%;
}

.select-control {
  display: grid;
  gap: 5px;
}

.select-control > span {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.76rem;
  font-weight: 700;
}

.market-content {
  flex: 1;
  min-height: 0;
  padding: 1.25rem 1.5rem 2rem;
  overflow: auto;
  background: color-mix(in srgb, var(--md-sys-color-surface) 72%, transparent);
}

.result-summary {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.82rem;
}

.result-summary strong {
  color: var(--md-sys-color-on-surface);
}

.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 14px;
}

.skeleton-card {
  height: 250px;
  display: grid;
  grid-template-columns: 46px 1fr;
  align-content: start;
  gap: 14px 12px;
  padding: 17px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 8px;
  background: var(--md-sys-color-surface-container-low);
}

.skeleton {
  border-radius: 6px;
  background: linear-gradient(
    90deg,
    var(--md-sys-color-surface-container) 20%,
    var(--md-sys-color-surface-container-high) 50%,
    var(--md-sys-color-surface-container) 80%
  );
  background-size: 220% 100%;
  animation: shimmer 1.25s linear infinite;
}

.icon-skeleton { width: 46px; height: 46px; }
.title-skeleton { height: 20px; align-self: center; }
.line-skeleton { grid-column: 1 / -1; height: 15px; margin-top: 10px; }
.line-skeleton.short { width: 66%; margin-top: 0; }

.state-panel {
  min-height: 320px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 2rem;
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

.state-panel h2,
.state-panel p {
  margin: 0;
}

.state-panel h2 {
  color: var(--md-sys-color-on-surface);
  font-size: 1.1rem;
}

.state-panel p {
  max-width: 620px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.error-panel > :first-child {
  color: var(--md-sys-color-error);
}

.primary-button {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-top: 8px;
  padding: 0 16px;
  border: 0;
  border-radius: 8px;
  color: var(--md-sys-color-on-primary);
  background: var(--md-sys-color-primary);
  font-weight: 700;
  cursor: pointer;
}

.spinning {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform-origin: center;
  animation: spin 0.8s linear infinite;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@keyframes spin { to { transform: rotate(360deg); } }
@keyframes shimmer { to { background-position: -220% 0; } }

@media (max-width: 1100px) {
  .filter-bar {
    grid-template-columns: minmax(260px, 1fr) repeat(3, minmax(130px, 1fr));
  }
}

@media (max-width: 780px) {
  .market-header,
  .market-content {
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .filter-bar {
    grid-template-columns: 1fr 1fr;
  }

  .search-field {
    grid-column: 1 / -1;
  }
}

@media (max-width: 480px) {
  .batch-action-bar,
  .batch-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .batch-actions > * {
    width: 100%;
  }

  .market-header {
    padding-top: 1rem;
  }

  .header-row :deep(.page-header-title) {
    font-size: 1.45rem;
  }

  .filter-bar {
    grid-template-columns: 1fr;
  }

  .search-field {
    grid-column: auto;
  }

  .result-summary {
    align-items: flex-start;
    flex-direction: column;
    gap: 3px;
    padding-bottom: 8px;
  }
}
</style>
