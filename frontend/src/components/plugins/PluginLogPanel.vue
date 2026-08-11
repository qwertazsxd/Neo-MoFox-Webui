<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import Icon from '../common/Icon.vue'
import { LogStreamClient, type LogStreamStatus } from '../../api/modules/log'
import type { RealtimeLogEntry } from '../../api/types/log'
import { useI18n } from '../../utils/i18n'

interface DisplayLogEntry extends RealtimeLogEntry {
  __id: number
  __fingerprint: string
}

const props = defineProps<{
  pluginName: string
}>()

const { t } = useI18n()
const logs = ref<DisplayLogEntry[]>([])
const pausedLogs = ref<DisplayLogEntry[]>([])
const streamStatus = ref<LogStreamStatus>('disconnected')
const searchText = ref('')
const selectedLevels = ref<string[]>([])
const isPaused = ref(false)
const autoScroll = ref(true)
const levelMenuOpen = ref(false)
const levelMenuRef = ref<HTMLElement | null>(null)
const logContainerRef = ref<HTMLElement | null>(null)

const MAX_LOG_ENTRIES = 1000
const LOG_LEVELS = ['DEBUG', 'INFO', 'SUCCESS', 'WARNING', 'ERROR', 'CRITICAL'] as const

let logId = 0
let streamClient: LogStreamClient | null = null

const filteredLogs = computed(() => {
  const keyword = searchText.value.trim().toLocaleLowerCase()
  return logs.value.filter((entry) => {
    if (selectedLevels.value.length > 0 && !selectedLevels.value.includes(normalizeLevel(entry.level))) {
      return false
    }
    if (!keyword) return true
    return `${entry.message} ${entry.logger_name} ${entry.display}`.toLocaleLowerCase().includes(keyword)
  })
})

const statusText = computed(() => t(`plugins.detail.logs.status.${streamStatus.value}`))
const statusClass = computed(() => `status-${streamStatus.value}`)

function tr(key: string, params: Record<string, string | number>): string {
  let text = t(key)
  for (const [name, value] of Object.entries(params)) {
    text = text.replace(`{${name}}`, String(value))
  }
  return text
}

function normalizeLevel(level: string): string {
  const normalized = String(level || 'INFO').toUpperCase()
  return normalized === 'WARN' ? 'WARNING' : normalized
}

function normalizeLogEntry(value: RealtimeLogEntry): DisplayLogEntry | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as Partial<RealtimeLogEntry> & Record<string, unknown>
  const message = String(raw.message ?? raw.msg ?? raw.text ?? '')
  if (!message) return null

  const entry: RealtimeLogEntry = {
    timestamp: String(raw.timestamp ?? raw.time ?? new Date().toISOString()),
    level: normalizeLevel(String(raw.level ?? 'INFO')),
    logger_name: String(raw.logger_name ?? raw.name ?? ''),
    display: String(raw.display ?? raw.logger_name ?? raw.name ?? ''),
    color: String(raw.color ?? ''),
    message,
    metadata: typeof raw.metadata === 'object' && raw.metadata !== null
      ? raw.metadata as Record<string, unknown>
      : {},
  }

  return {
    ...entry,
    __id: ++logId,
    __fingerprint: [entry.timestamp, entry.level, entry.logger_name, entry.display, entry.message].join('\u0000'),
  }
}

function normalizeEntries(entries: RealtimeLogEntry[]): DisplayLogEntry[] {
  return entries.map(normalizeLogEntry).filter((entry): entry is DisplayLogEntry => entry !== null)
}

function mergeUniqueEntries(
  current: DisplayLogEntry[],
  incoming: DisplayLogEntry[],
): DisplayLogEntry[] {
  const combined = [...current, ...incoming]
  const latestByFingerprint = new Map<string, { entry: DisplayLogEntry; index: number }>()

  combined.forEach((entry, index) => {
    latestByFingerprint.set(entry.__fingerprint, { entry, index })
  })

  return [...latestByFingerprint.values()]
    .sort((left, right) => {
      const leftTime = Date.parse(left.entry.timestamp)
      const rightTime = Date.parse(right.entry.timestamp)
      if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime
      }
      return left.index - right.index
    })
    .map(({ entry }) => entry)
    .slice(-MAX_LOG_ENTRIES)
}

function appendLog(entry: RealtimeLogEntry): void {
  const normalized = normalizeLogEntry(entry)
  if (!normalized) return

  if (isPaused.value) {
    pausedLogs.value = [...pausedLogs.value, normalized].slice(-MAX_LOG_ENTRIES)
    return
  }

  logs.value = mergeUniqueEntries(logs.value, [normalized])
  scrollToBottomIfEnabled()
}

function receiveHistory(entries: RealtimeLogEntry[]): void {
  logs.value = mergeUniqueEntries(normalizeEntries(entries), logs.value)
  scrollToBottomIfEnabled()
}

function createStream(): void {
  streamClient?.disconnect()
  streamClient = new LogStreamClient({
    pluginName: props.pluginName,
    onHistory: receiveHistory,
    onLog: appendLog,
    onStatusChange: (status) => {
      streamStatus.value = status
    },
  })
  streamClient.setLevels(selectedLevels.value)
  streamClient.connect()
}

function restartStream(): void {
  logs.value = []
  pausedLogs.value = []
  isPaused.value = false
  createStream()
}

function toggleLevel(level: string): void {
  selectedLevels.value = selectedLevels.value.includes(level)
    ? selectedLevels.value.filter((item) => item !== level)
    : [...selectedLevels.value, level]
  streamClient?.setLevels(selectedLevels.value)
}

function clearLevelFilter(): void {
  selectedLevels.value = []
  streamClient?.setLevels([])
}

function togglePause(): void {
  isPaused.value = !isPaused.value
  if (isPaused.value || pausedLogs.value.length === 0) return

  logs.value = mergeUniqueEntries(logs.value, pausedLogs.value)
  pausedLogs.value = []
  scrollToBottomIfEnabled()
}

function clearLogs(): void {
  logs.value = []
  pausedLogs.value = []
}

function toggleAutoScroll(): void {
  autoScroll.value = !autoScroll.value
  if (autoScroll.value) scrollToBottom()
}

function scrollToBottomIfEnabled(): void {
  if (autoScroll.value) scrollToBottom()
}

function scrollToBottom(): void {
  nextTick(() => {
    const container = logContainerRef.value
    if (container) container.scrollTop = container.scrollHeight
  })
}

function closeLevelMenu(event: MouseEvent): void {
  if (levelMenuRef.value && !levelMenuRef.value.contains(event.target as Node)) {
    levelMenuOpen.value = false
  }
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleTimeString([], { hour12: false })
  }
  return timestamp
}

function levelClass(level: string): string {
  return `level-${normalizeLevel(level).toLowerCase()}`
}

onMounted(() => {
  document.addEventListener('click', closeLevelMenu)
  createStream()
})

watch(() => props.pluginName, (nextName, previousName) => {
  if (nextName && nextName !== previousName) restartStream()
})

onUnmounted(() => {
  document.removeEventListener('click', closeLevelMenu)
  streamClient?.disconnect()
  streamClient = null
})
</script>

<template>
  <section class="plugin-log-panel" aria-labelledby="plugin-log-title">
    <div class="panel-header">
      <div class="panel-heading">
        <Icon icon="material-symbols:terminal-rounded" width="22" height="22" />
        <h2 id="plugin-log-title">{{ t('plugins.detail.logs.title') }}</h2>
        <span class="connection-status" :class="statusClass">
          <span class="status-dot"></span>
          {{ statusText }}
        </span>
        <span v-if="pausedLogs.length > 0" class="pending-count">
          {{ tr('plugins.detail.logs.pending', { count: pausedLogs.length }) }}
        </span>
      </div>

      <div class="panel-actions">
        <button
          class="icon-button"
          type="button"
          :class="{ active: isPaused }"
          :title="isPaused ? t('plugins.detail.logs.actions.resume') : t('plugins.detail.logs.actions.pause')"
          :aria-label="isPaused ? t('plugins.detail.logs.actions.resume') : t('plugins.detail.logs.actions.pause')"
          @click="togglePause"
        >
          <Icon :icon="isPaused ? 'material-symbols:play-arrow-rounded' : 'material-symbols:pause-rounded'" width="20" height="20" />
        </button>
        <button
          class="icon-button"
          type="button"
          :class="{ active: autoScroll }"
          :title="t('plugins.detail.logs.actions.autoScroll')"
          :aria-label="t('plugins.detail.logs.actions.autoScroll')"
          :aria-pressed="autoScroll"
          @click="toggleAutoScroll"
        >
          <Icon icon="material-symbols:vertical-align-bottom-rounded" width="20" height="20" />
        </button>
        <button
          class="icon-button"
          type="button"
          :title="t('plugins.detail.logs.actions.clear')"
          :aria-label="t('plugins.detail.logs.actions.clear')"
          @click="clearLogs"
        >
          <Icon icon="material-symbols:delete-sweep-outline-rounded" width="20" height="20" />
        </button>
      </div>
    </div>

    <div class="log-toolbar">
      <label class="search-field">
        <Icon icon="material-symbols:search-rounded" width="18" height="18" />
        <input
          v-model="searchText"
          type="search"
          :placeholder="t('plugins.detail.logs.searchPlaceholder')"
          :aria-label="t('plugins.detail.logs.searchPlaceholder')"
        />
      </label>

      <div ref="levelMenuRef" class="level-filter">
        <button
          class="filter-button"
          type="button"
          :class="{ active: selectedLevels.length > 0 }"
          :aria-expanded="levelMenuOpen"
          @click.stop="levelMenuOpen = !levelMenuOpen"
        >
          <Icon icon="material-symbols:filter-list-rounded" width="18" height="18" />
          <span>{{ t('plugins.detail.logs.levels.title') }}</span>
          <span v-if="selectedLevels.length > 0" class="filter-count">{{ selectedLevels.length }}</span>
        </button>

        <div v-if="levelMenuOpen" class="level-menu">
          <label v-for="level in LOG_LEVELS" :key="level" class="level-option">
            <input
              type="checkbox"
              :checked="selectedLevels.includes(level)"
              @change="toggleLevel(level)"
            />
            <span class="level-swatch" :class="levelClass(level)"></span>
            <span>{{ t(`plugins.detail.logs.levels.${level.toLowerCase()}`) }}</span>
          </label>
          <button
            class="clear-filter-button"
            type="button"
            :disabled="selectedLevels.length === 0"
            @click="clearLevelFilter"
          >
            {{ t('plugins.detail.logs.levels.clear') }}
          </button>
        </div>
      </div>

      <span class="log-count">
        {{ tr('plugins.detail.logs.count', { visible: filteredLogs.length, total: logs.length }) }}
      </span>
    </div>

    <div ref="logContainerRef" class="log-viewport">
      <div v-if="filteredLogs.length === 0" class="empty-state">
        <Icon icon="material-symbols:receipt-long-outline-rounded" width="36" height="36" />
        <span>{{ t('plugins.detail.logs.empty') }}</span>
      </div>

      <div v-else class="log-list">
        <div v-for="entry in filteredLogs" :key="entry.__id" class="log-entry">
          <time class="log-time">{{ formatTimestamp(entry.timestamp) }}</time>
          <span class="level-badge" :class="levelClass(entry.level)">{{ normalizeLevel(entry.level) }}</span>
          <span class="log-source" :title="entry.logger_name || entry.display">
            {{ entry.display || entry.logger_name || t('plugins.detail.logs.unknownSource') }}
          </span>
          <span class="log-message">{{ entry.message }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.plugin-log-panel {
  margin-bottom: 1.5rem;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 8px;
  overflow: visible;
  background: var(--md-sys-color-surface-container-low);
}

.panel-header,
.log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
}

.panel-header {
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.panel-heading,
.panel-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.panel-heading h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
  letter-spacing: 0;
}

.connection-status,
.pending-count {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 24px;
  padding: 0 0.55rem;
  border-radius: 999px;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.75rem;
  white-space: nowrap;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--md-sys-color-outline);
}

.status-connected .status-dot {
  background: #1b873f;
}

.status-connecting .status-dot,
.status-reconnecting .status-dot {
  background: #d97706;
  animation: status-pulse 1.2s ease-in-out infinite;
}

@keyframes status-pulse {
  50% { opacity: 0.35; }
}

.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
}

.icon-button:hover,
.icon-button.active {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}

.log-toolbar {
  flex-wrap: wrap;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container);
}

.search-field {
  display: flex;
  align-items: center;
  flex: 1 1 260px;
  min-width: 180px;
  height: 38px;
  padding: 0 0.75rem;
  gap: 0.5rem;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 6px;
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface-variant);
}

.search-field:focus-within {
  border-color: var(--md-sys-color-primary);
}

.search-field input {
  width: 100%;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--md-sys-color-on-surface);
  font: inherit;
  letter-spacing: 0;
}

.level-filter {
  position: relative;
}

.filter-button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  height: 38px;
  padding: 0 0.75rem;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 6px;
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
  cursor: pointer;
}

.filter-button.active {
  border-color: var(--md-sys-color-primary);
  color: var(--md-sys-color-primary);
}

.filter-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  font-size: 0.72rem;
}

.level-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 6px);
  right: 0;
  width: 210px;
  padding: 0.4rem;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 8px;
  background: var(--md-sys-color-surface-container-high);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.level-option {
  display: grid;
  grid-template-columns: 18px 10px minmax(0, 1fr);
  align-items: center;
  gap: 0.55rem;
  min-height: 34px;
  padding: 0 0.45rem;
  border-radius: 4px;
  cursor: pointer;
}

.level-option:hover {
  background: var(--md-sys-color-surface-container-highest);
}

.level-swatch {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: currentColor;
}

.clear-filter-button {
  width: 100%;
  margin-top: 0.35rem;
  padding: 0.45rem;
  border: none;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: transparent;
  color: var(--md-sys-color-primary);
  cursor: pointer;
}

.clear-filter-button:disabled {
  color: var(--md-sys-color-on-surface-variant);
  opacity: 0.5;
  cursor: default;
}

.log-count {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.78rem;
  white-space: nowrap;
}

.log-viewport {
  height: 380px;
  overflow: auto;
  background: color-mix(in srgb, var(--md-sys-color-surface) 94%, #000 6%);
  scrollbar-gutter: stable;
}

.log-list {
  min-width: 720px;
  padding: 0.4rem 0;
}

.log-entry {
  display: grid;
  grid-template-columns: 92px 82px minmax(130px, 190px) minmax(280px, 1fr);
  align-items: start;
  gap: 0.65rem;
  padding: 0.42rem 0.8rem;
  border-left: 3px solid transparent;
  font-family: 'Cascadia Code', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.45;
}

.log-entry:hover {
  background: var(--md-sys-color-surface-container);
}

.log-time,
.log-source {
  color: var(--md-sys-color-on-surface-variant);
}

.log-time {
  white-space: nowrap;
}

.log-source {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.level-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 22px;
  padding: 0 0.4rem;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 700;
}

.level-debug { color: #6b7280; }
.level-info { color: #1677c8; }
.level-success { color: #1b873f; }
.level-warning { color: #c26100; }
.level-error { color: #c62828; }
.level-critical { color: #9f1239; }

.log-message {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--md-sys-color-on-surface);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  height: 100%;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.88rem;
}

@media (max-width: 720px) {
  .panel-header {
    align-items: flex-start;
  }

  .panel-heading {
    flex-wrap: wrap;
  }

  .connection-status {
    order: 3;
  }

  .pending-count {
    order: 4;
  }

  .panel-actions {
    flex-shrink: 0;
  }

  .log-count {
    width: 100%;
  }

  .log-viewport {
    height: 340px;
  }
}
</style>
