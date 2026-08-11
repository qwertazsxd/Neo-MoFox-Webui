import http from '../base'
import { API_WEBUI_PREFIX } from '../config'
import type {
  BatchInstallPlan,
  BatchMarketOperation,
  InstallPlan,
  MarketCapabilities,
  MarketOperation,
  MarketPluginDetail,
  MarketPluginList,
  MarketPluginReadme,
} from '../types/plugin-market'

const BASE = `${API_WEBUI_PREFIX}/plugin-market`

export function getMarketCapabilities(): Promise<MarketCapabilities> {
  return http.get(`${BASE}/capabilities`)
}

export function getMarketPlugins(refresh = false): Promise<MarketPluginList> {
  return http.get(`${BASE}/plugins`, {
    params: { refresh },
    timeout: 45000,
  })
}

export function getMarketPluginDetail(pluginId: string): Promise<MarketPluginDetail> {
  return http.get(`${BASE}/plugins/${encodeURIComponent(pluginId)}`, { timeout: 45000 })
}

export function getMarketPluginReadme(pluginId: string): Promise<MarketPluginReadme> {
  return http.get(`${BASE}/plugins/${encodeURIComponent(pluginId)}/readme`, { timeout: 45000 })
}

export function getMarketInstallPlan(
  pluginId: string,
  version: string | null,
): Promise<InstallPlan> {
  return http.post(`${BASE}/plugins/${encodeURIComponent(pluginId)}/install-plan`, {
    version,
  })
}

export function startMarketInstall(
  pluginId: string,
  version: string | null,
): Promise<MarketOperation> {
  return http.post(`${BASE}/plugins/${encodeURIComponent(pluginId)}/install`, {
    version,
  })
}

export function getMarketOperation(operationId: string): Promise<MarketOperation> {
  return http.get(`${BASE}/operations/${encodeURIComponent(operationId)}`)
}

export function getBatchMarketInstallPlan(pluginIds: string[]): Promise<BatchInstallPlan> {
  return http.post(`${BASE}/plugins/batch/install-plan`, { plugin_ids: pluginIds }, { timeout: 45000 })
}

export function startBatchMarketInstall(pluginIds: string[]): Promise<BatchMarketOperation> {
  return http.post(`${BASE}/plugins/batch/install`, { plugin_ids: pluginIds })
}

export function getBatchMarketOperation(operationId: string): Promise<BatchMarketOperation> {
  return http.get(`${BASE}/batch-operations/${encodeURIComponent(operationId)}`)
}
