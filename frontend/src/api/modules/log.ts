/**
 * 日志相关 API 模块。
 *
 * 提供历史日志列表获取和日志内容分块拉取接口。
 */

import instance from '../base'
import { API_BASE_URL, API_WEBUI_PREFIX } from '../config'
import type { LogFileListResponse, LogContentResponse, RealtimeLogEntry } from '../types/log'

const LOG_PREFIX = `${API_WEBUI_PREFIX}/log`
const HEARTBEAT_INTERVAL = 30000
const MAX_RECONNECT_DELAY = 10000

export type LogStreamStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export interface LogStreamOptions {
  pluginName?: string
  onHistory: (entries: RealtimeLogEntry[]) => void
  onLog: (entry: RealtimeLogEntry) => void
  onStatusChange: (status: LogStreamStatus) => void
  onError?: () => void
}

/** 管理实时日志协议、心跳和自动重连。 */
export class LogStreamClient {
  private readonly options: LogStreamOptions
  private socket: WebSocket | null = null
  private heartbeatTimer: number | null = null
  private reconnectTimer: number | null = null
  private reconnectAttempts = 0
  private stopped = true
  private levels: string[] = []

  constructor(options: LogStreamOptions) {
    this.options = options
  }

  connect(): void {
    if (!this.stopped || this.socket) return
    this.stopped = false
    this.openSocket(false)
  }

  disconnect(): void {
    this.stopped = true
    this.clearHeartbeat()
    this.clearReconnectTimer()

    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.close()
    }

    this.options.onStatusChange('disconnected')
  }

  setLevels(levels: string[]): void {
    this.levels = levels.map((level) => level.toUpperCase())
    this.sendLevelFilter()
  }

  private openSocket(isReconnect: boolean): void {
    if (this.stopped) return

    this.clearReconnectTimer()
    this.options.onStatusChange(isReconnect ? 'reconnecting' : 'connecting')

    let socket: WebSocket
    try {
      socket = new WebSocket(this.buildUrl())
    } catch {
      this.options.onError?.()
      this.scheduleReconnect()
      return
    }

    this.socket = socket

    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return
      this.reconnectAttempts = 0
      this.options.onStatusChange('connected')
      this.sendLevelFilter()
      this.startHeartbeat()
    }

    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket || this.stopped) return
      this.handleMessage(event.data)
    }

    socket.onerror = () => {
      if (this.socket !== socket || this.stopped) return
      this.options.onError?.()
    }

    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.clearHeartbeat()
      if (!this.stopped) this.scheduleReconnect()
    }
  }

  private buildUrl(): string {
    const url = new URL(`${LOG_PREFIX}/ws`, API_BASE_URL)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

    const token = sessionStorage.getItem('neo_token')
    if (token) url.searchParams.set('token', token)
    if (this.options.pluginName) url.searchParams.set('plugin_name', this.options.pluginName)

    return url.toString()
  }

  private handleMessage(rawData: unknown): void {
    try {
      const message = typeof rawData === 'string' ? JSON.parse(rawData) : rawData
      if (!message || typeof message !== 'object') return

      const typedMessage = message as {
        type?: string
        data?: RealtimeLogEntry | RealtimeLogEntry[]
        message?: string
      }

      if (typedMessage.type === 'history_batch' && Array.isArray(typedMessage.data)) {
        this.options.onHistory(typedMessage.data)
      } else if (typedMessage.type === 'realtime_log' && typedMessage.data && !Array.isArray(typedMessage.data)) {
        this.options.onLog(typedMessage.data)
      } else if (!typedMessage.type && typedMessage.message) {
        this.options.onLog(typedMessage as RealtimeLogEntry)
      }
    } catch {
      // 忽略无法解析的协议外消息。
    }
  }

  private sendLevelFilter(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({
      type: 'set_level_filter',
      levels: this.levels.length > 0 ? this.levels : null,
    }))
  }

  private startHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatTimer = window.setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'ping' }))
      }
    }, HEARTBEAT_INTERVAL)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer === null) return
    window.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return

    this.options.onStatusChange('reconnecting')
    const delay = Math.min(1000 * (2 ** this.reconnectAttempts), MAX_RECONNECT_DELAY)
    this.reconnectAttempts += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket(true)
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return
    window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }
}

/**
 * 获取可用的历史日志文件列表。
 *
 * @returns 日志文件列表响应
 */
export async function getLogFiles(): Promise<LogFileListResponse> {
  return instance.get(`${LOG_PREFIX}/files`)
}

/**
 * 获取指定日志文件的内容（支持偏移量分块）。
 *
 * @param filename - 日志文件名
 * @param offset - 偏移量（字节），0 表示从头开始
 * @param limit - 本次返回的最大字节数
 * @param query - 日志内容搜索关键词
 * @param levels - 日志级别过滤列表
 * @returns 日志内容分块响应
 */
export async function getLogContent(
  filename: string,
  offset: number = 0,
  limit: number = 65536,
  query: string = '',
  levels: string[] = [],
): Promise<LogContentResponse> {
  return instance.get(`${LOG_PREFIX}/content`, {
    params: { filename, offset, limit, query, levels },
  })
}
