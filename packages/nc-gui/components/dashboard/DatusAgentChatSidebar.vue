<script lang="ts" setup>
import type { SourceType } from 'nocodb-sdk'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'

dayjs.extend(utc)

interface ReasoningItem {
  type: string
  message: string
  name?: string
  input?: Record<string, unknown> | string
  output?: Record<string, unknown> | string
}

interface ProgressStep {
  id: string
  type: 'thinking' | 'tool'
  message: string
  status: 'pending' | 'active' | 'completed' | 'failed'
  /** 工具名，tool 类型时有值 */
  toolName?: string
  /** 工具输入参数，tool 类型时有值 */
  toolInput?: Record<string, unknown> | string
  /** 工具输出，tool 类型且有结果时有值 */
  toolOutput?: Record<string, unknown> | string
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  progress?: ProgressStep[]
  reasoning?: ReasoningItem[]
}

interface SuggestedPrompt {
  category: string
  prompts: string[]
}

const props = defineProps<{
  baseId: string
  collapsed?: boolean
  maximized?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-collapse'): void
  (e: 'toggle-maximize'): void
}>()

const { t } = useI18n()
const { api } = useApi()

const { bases } = storeToRefs(useBases())
const base = computed(() => bases.value.get(props.baseId))

// 数据源列表
const sources = ref<SourceType[]>([])
const selectedSourceId = ref<string>('')

// 消息列表
const messages = ref<Message[]>([])
const currentMessage = ref('')
const isLoading = ref(false)
const isStreaming = ref(false)

// 会话 ID
const sessionId = ref<string>('')

// 折叠展开状态：哪些消息的推理面板已展开
const expandedReasoningIds = ref<Set<string>>(new Set())
const toggleReasoning = (msgId: string) => {
  const next = new Set(expandedReasoningIds.value)
  if (next.has(msgId)) next.delete(msgId)
  else next.add(msgId)
  expandedReasoningIds.value = next
}

// 获取消息的推理内容（streaming 用 progress，加载的用 reasoning）
// 加载的 reasoning 需应用与 progress 相同的 strip 逻辑，保证条数一致
const getReasoningSteps = (msg: Message): ProgressStep[] => {
  if (msg.progress?.length) {
    // progress 已在 response 事件中 strip，且仅含已完成的 tool
    return msg.progress.filter((s) => s.type !== 'tool' || s.status === 'completed' || s.status === 'failed')
  }
  const r = msg.reasoning
  if (!r?.length) return []
  const displayContent = extractDisplayContent(msg.content || '')
  const steps: ProgressStep[] = []
  for (let i = 0; i < r.length; i++) {
    const x = r[i]
    const type = (x.type === 'tool' ? 'tool' : 'thinking') as 'thinking' | 'tool'
    let message = x.message
    if (type === 'thinking' && displayContent) {
      const stripped = stripResponseFromThinking(message ?? '', displayContent)
      if (!stripped) continue // 与 response 完全重复则跳过，与 progress 行为一致
      message = stripped
    }
    steps.push({
      id: `r_${i}`,
      type,
      message,
      status: 'completed' as const,
      toolName: x.name,
      toolInput: x.input,
      toolOutput: x.output,
    })
  }
  return steps
}

// 流式时仅展示 thinking 步骤（不展示 tool call）
const getStreamingThinkingSteps = (msg: Message): ProgressStep[] => {
  return getReasoningSteps(msg).filter((s) => s.type === 'thinking')
}

// 将对象格式化为可读字符串（用于完整展示）
const formatJsonBlock = (val: unknown): string => {
  if (val == null) return ''
  if (typeof val === 'string') return val
  try {
    return JSON.stringify(val, null, 2)
  } catch {
    return String(val)
  }
}

// 从 response 中提取可展示内容：若包含 {"output": "..."} 则取 output 值（避免将 thinking 中的 JSON 原样展示）
const extractDisplayContent = (content: string): string => {
  if (!content || typeof content !== 'string') return content || ''
  const trimmed = content.trim()
  // 尝试从内容中解析 JSON，支持前缀如 "Now let me...\n\n{...}"
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '{') {
      try {
        const obj = JSON.parse(trimmed.slice(i))
        if (obj && typeof obj === 'object' && typeof obj.output === 'string') {
          return obj.output
        }
      } catch {
        // 继续找下一个 {
        continue
      }
    }
  }
  return content
}

// 会话列表
interface SessionItem {
  session_id: string
  created_at: string
  message_count: number
  latest_user_message?: string
  file_modified: number
}
const sessions = ref<SessionItem[]>([])
const sessionListLoading = ref(false)
const sessionListVisible = ref(false)

// 是否显示建议提示
const showSuggestions = computed(() => messages.value.length === 0)

// 建议提示
const suggestedPrompts = computed<SuggestedPrompt[]>(() => [
  {
    category: '',
    prompts: [
      t('activity.suggestions.introduceDataset'),
      t('activity.suggestions.dataInsights'),
      t('activity.suggestions.createReport'),
    ],
  },
])

// 将 UTC 时间转换为本地时间显示
const formatSessionTime = (createdAt: string) => {
  if (!createdAt || createdAt === 'N/A') return createdAt
  const str = createdAt.includes('+') || createdAt.includes('Z') ? createdAt : createdAt.replace(' ', 'T') + 'Z'
  const d = dayjs.utc(str).local()
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : createdAt
}

// 获取数据源显示名称
const getSourceDisplayName = (source: SourceType, index: number) => {
  // 第一个数据源显示为 "Default"
  if (index === 0) {
    return t('general.default')
  }
  // 如果有 alias，使用 alias
  if (source.alias) {
    return source.alias
  }
  // 如果有 integration_title，使用 integration_title
  if (source.integration_title) {
    return source.integration_title
  }
  // 否则使用 "数据源" + 序号
  return `${t('general.datasource')} ${index + 1}`
}

// 加载数据源列表
const loadSources = async () => {
  try {
    const response = await api.source.list(props.baseId)
    if (response.list) {
      // 过滤掉 meta 数据源，只显示外部数据源
      sources.value = response.list.filter((s: SourceType) => !s.is_meta)
      // 默认选择第一个数据源
      const first = sources.value[0]
      if (first?.id && !selectedSourceId.value) {
        selectedSourceId.value = first.id
      }
    }
  } catch (error) {
    console.error('Failed to load sources:', error)
  }
}

// 发送消息
const sendMessage = async (promptText?: string) => {
  const messageToSend = promptText || currentMessage.value.trim()
  if (!messageToSend || isLoading.value || !selectedSourceId.value) {
    return
  }

  const userMessage: Message = {
    id: Date.now().toString(),
    role: 'user',
    content: messageToSend,
    timestamp: Date.now(),
  }

  messages.value.push(userMessage)
  currentMessage.value = ''

  // 添加一个空的助手消息用于流式更新
  const assistantMessage: Message = {
    id: (Date.now() + 1).toString(),
    role: 'assistant',
    content: '',
    timestamp: Date.now() + 1,
    progress: [],
  }
  messages.value.push(assistantMessage)

  isLoading.value = true
  isStreaming.value = true

  try {
    const config = useRuntimeConfig()
    const baseURL = config.public.ncBackendUrl || BASE_FALLBACK_URL
    const url = `${baseURL.replace(/\/$/, '')}/api/v2/meta/bases/${props.baseId}/ai/chat/stream`

    // 获取认证 token（来自 useGlobal，存于 localStorage）
    const { token } = useGlobal()
    const authToken = token.value || ''
    if (!authToken) {
      throw new Error('未找到认证 token')
    }

    // 构建请求体
    const requestBody = {
      message: messageToSend,
      session_id: sessionId.value || undefined,
      source_id: selectedSourceId.value,
    }

    // 使用 fetch 发送 SSE 请求
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xc-auth': authToken,
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      let errMsg = `HTTP ${response.status}`
      try {
        const errBody = await response.json()
        errMsg = errBody?.message || errBody?.detail || errBody?.error || errMsg
      } catch {
        // 非 JSON 响应，使用 status
      }
      throw new Error(errMsg)
    }

    if (!response.body) {
      throw new Error('Response body is null')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEventType = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // 保留最后一个不完整的行

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim()
          if (dataStr === '[DONE]') {
            isStreaming.value = false
            continue
          }

          try {
            const data = JSON.parse(dataStr)
            handleSSEEvent(currentEventType, data, assistantMessage.id)
          } catch (e) {
            console.error('Failed to parse SSE event:', e, dataStr)
          }
        }
      }
    }

    // 处理剩余的 buffer
    if (buffer.startsWith('data: ')) {
      const dataStr = buffer.slice(6).trim()
      if (dataStr !== '[DONE]') {
        try {
          const data = JSON.parse(dataStr)
          handleSSEEvent(currentEventType, data, assistantMessage.id)
        } catch (e) {
          console.error('Failed to parse SSE event:', e, dataStr)
        }
      }
    }

    isStreaming.value = false
  } catch (error: any) {
    console.error('Failed to send message:', error)
    assistantMessage.content += `\n\n[错误: ${error.message || '发送消息失败'}]`
    message.error('发送消息失败: ' + (error.message || '未知错误'))
  } finally {
    isLoading.value = false
    isStreaming.value = false
    loadSessions() // 刷新会话列表
    nextTick(() => {
      scrollToBottom()
    })
  }
}

// 生成进度步骤 ID
const generateProgressId = () => Math.random().toString(36).slice(2, 12)

// 从 thinking 中移除与 response 重复的部分（考虑空白、大小写差异）
const stripResponseFromThinking = (thinking: string, response: string): string => {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const tNorm = norm(thinking)
  const rNorm = norm(response)
  if (rNorm.length < 20) return thinking
  let idx = tNorm.indexOf(rNorm)
  if (idx < 0 && rNorm.length > 80) {
    idx = tNorm.indexOf(rNorm.slice(0, 80))
  }
  if (idx < 0 && rNorm.length > 50) {
    idx = tNorm.indexOf(rNorm.slice(0, 50))
  }
  if (idx < 0) return thinking
  const beforeNorm = tNorm.slice(0, idx).trim()
  if (!beforeNorm) return ''
  let normIdx = 0
  let lastWasSpace = false
  for (let i = 0; i < thinking.length; i++) {
    if (normIdx >= beforeNorm.length) return thinking.slice(0, i).trim()
    const ch = thinking[i] ?? ''
    if (/\s/.test(ch)) {
      if (!lastWasSpace && normIdx > 0) normIdx++
      lastWasSpace = true
    } else {
      lastWasSpace = false
      normIdx++
    }
  }
  return thinking
}

// 通过响应式引用更新消息，确保 Vue 能实时检测变化
const getAssistantMessage = (id: string) => {
  const idx = messages.value.findIndex((m) => m.id === id)
  return idx >= 0 ? messages.value[idx] : null
}

// 处理 SSE 事件（与 datus-agent /chat/stream 格式一致）
// datus-agent 发送: event: session/thinking/tool/response/actions/done/error + data: JSON
const handleSSEEvent = (eventType: string, data: any, assistantMessageId: string) => {
  const msg = getAssistantMessage(assistantMessageId)
  switch (eventType) {
    case 'session':
      if (data?.session_id) {
        sessionId.value = data.session_id
      }
      break
    case 'thinking':
      if (data?.text && msg) {
        const text = String(data.text).trim()
        if (!text || /chat interaction completed successfully/i.test(text)) return
        if (!msg.progress) msg.progress = []
        msg.progress = [...msg.progress, {
          id: generateProgressId(),
          type: 'thinking' as const,
          message: text,
          status: 'completed' as const,
        }]
      }
      break
    case 'tool':
      // 仅写入已完成的 tool（completed/failed），不写入 processing；支持 input/output 供推理面板完整展示
      if ((data?.name != null || data?.status != null) && msg) {
        const status = data.status === 'success' ? 'completed' : data.status === 'error' ? 'failed' : null
        if (status === null) break // 忽略 processing 状态
        if (!msg.progress) msg.progress = []
        msg.progress = [...msg.progress, {
          id: generateProgressId(),
          type: 'tool' as const,
          message: `${data.name ?? ''}: ${data.status ?? ''}`.trim() || '工具调用',
          status,
          toolName: data.name,
          toolInput: data.input,
          toolOutput: data.output,
        }]
      }
      break
    case 'response':
      if (msg) {
        const text = data?.text ?? data?.content
        if (text) {
          msg.content += text
          const resp = String(text).trim()
          if (resp && msg.progress?.length) {
            const steps: ProgressStep[] = []
            for (const step of msg.progress) {
              if (step.type !== 'thinking') {
                steps.push(step)
                continue
              }
              const stripped = stripResponseFromThinking(step.message ?? '', resp)
              if (stripped) steps.push(stripped === step.message ? step : { ...step, message: stripped })
            }
            msg.progress = steps
          }
        }
      }
      break
    case 'actions':
      break
    case 'done':
      isStreaming.value = false
      break
    case 'error':
      if (msg) msg.content += `\n\n[错误: ${data?.error || '未知错误'}]`
      isStreaming.value = false
      break
  }
}

// 滚动到底部
const messagesContainer = ref<HTMLElement>()
const scrollToBottom = () => {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

// 流式 thinking 容器引用，用于自动滚动到最新一条
const thinkingStreamContainerRef = ref<HTMLElement | null>(null)
const scrollThinkingToLatest = () => {
  if (thinkingStreamContainerRef.value) {
    thinkingStreamContainerRef.value.scrollTop = thinkingStreamContainerRef.value.scrollHeight
  }
}

// 当流式 thinking 步骤更新时，滚动到最新
watch(
  () => {
    const last = messages.value[messages.value.length - 1]
    if (!last || last.role !== 'assistant') return 0
    return getStreamingThinkingSteps(last).length
  },
  () => {
    if (isStreaming.value) {
      nextTick(() => {
        scrollThinkingToLatest()
        scrollToBottom()
      })
    }
  },
)

// 清空对话
const clearMessages = () => {
  messages.value = []
  sessionId.value = ''
  currentMessage.value = ''
}

// 获取请求配置（baseURL + token）
const getRequestConfig = () => {
  const config = useRuntimeConfig()
  const baseURL = (config.public.ncBackendUrl || BASE_FALLBACK_URL).replace(/\/$/, '')
  const { token } = useGlobal()
  const authToken = token.value || ''
  return { baseURL, authToken }
}

// 加载会话列表（按 namespace 过滤，datus-agent 新 API）
const loadSessions = async () => {
  if (!selectedSourceId.value) {
    sessions.value = []
    return
  }
  sessionListLoading.value = true
  try {
    const { baseURL, authToken } = getRequestConfig()
    const url = `${baseURL}/api/v2/meta/bases/${props.baseId}/ai/chat/sessions?source_id=${selectedSourceId.value}`
    const res = await fetch(url, {
      headers: { 'xc-auth': authToken },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    sessions.value = data.sessions || []
  } catch (e) {
    console.error('Failed to load sessions:', e)
    sessions.value = []
  } finally {
    sessionListLoading.value = false
  }
}

// 加载会话历史（datus 返回 content=最终回复，reasoning=thinking+tools）
const loadSessionHistory = async (sid: string) => {
  if (!selectedSourceId.value) return
  isLoading.value = true
  try {
    const { baseURL, authToken } = getRequestConfig()
    const url = `${baseURL}/api/v2/meta/bases/${props.baseId}/ai/chat/sessions/${sid}/messages?source_id=${selectedSourceId.value}`
    const res = await fetch(url, { headers: { 'xc-auth': authToken } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const msgs = (data.messages || []).map((m: any, i: number) => ({
      id: `${sid}_${i}`,
      role: m.role || 'assistant',
      content: m.content || '',
      timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp || '') || Date.now(),
      reasoning: m.reasoning,
    }))
    messages.value = msgs
    sessionId.value = sid
    sessionListVisible.value = false
    nextTick(() => scrollToBottom())
  } catch (e) {
    console.error('Failed to load session history:', e)
    message.error('加载会话失败: ' + (e instanceof Error ? e.message : '未知错误'))
  } finally {
    isLoading.value = false
  }
}

// 删除会话
const deleteSession = async (sid: string, e?: Event) => {
  e?.stopPropagation()
  try {
    const { baseURL, authToken } = getRequestConfig()
    const url = `${baseURL}/api/v2/meta/bases/${props.baseId}/ai/chat/sessions/${sid}`
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'xc-auth': authToken },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    sessions.value = sessions.value.filter((s) => s.session_id !== sid)
    if (sessionId.value === sid) {
      clearMessages()
    }
  } catch (err) {
    message.error('删除会话失败: ' + (err instanceof Error ? err.message : '未知错误'))
  }
}

// 使用建议提示：将内容复制到文本框，用户可编辑后再发送
const useSuggestion = (prompt: string) => {
  currentMessage.value = prompt
}

// 键盘快捷键
const handleKeyDown = (e: KeyboardEvent) => {
  // 阻止退格键事件冒泡（避免触发 NocoDB 的 "No editable cells to clear"）
  if (e.key === 'Backspace') {
    e.stopPropagation()
    return
  }
  
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    e.stopPropagation()
    sendMessage()
  }
}

// 初始化
onMounted(() => {
  loadSources()
})

watch(
  () => props.baseId,
  () => {
    if (props.baseId) {
      loadSources()
      clearMessages()
    }
  },
  { immediate: true },
)

watch(selectedSourceId, () => {
  loadSessions()
  clearMessages()
})

watch(sessionListVisible, (open) => {
  if (open && selectedSourceId.value) {
    loadSessions()
  }
})
</script>

<template>
  <div
    class="nc-datus-agent-chat-sidebar flex flex-col h-full bg-nc-bg-default border-l-1 border-nc-border-gray-medium overflow-hidden"
    :class="{ 'collapsed': collapsed }"
  >
    <!-- 折叠状态：仅显示展开按钮 -->
    <div v-if="collapsed" class="flex flex-col items-center justify-center h-full w-full nc-collapse-panel">
      <NcTooltip placement="left">
        <template #title>{{ t('activity.expandAIChat') }}</template>
        <NcButton
          type="text"
          size="small"
          class="!h-8 !w-8 !p-0 text-nc-content-gray-muted hover:text-nc-content-gray"
          @click="emit('toggle-collapse')"
        >
          <GeneralIcon icon="cellAi" class="w-5 h-5" />
        </NcButton>
      </NcTooltip>
    </div>

    <!-- 展开状态：完整聊天界面 -->
    <div v-else class="flex flex-col h-full w-full min-w-0 min-h-0">
      <!-- 头部 -->
      <div class="flex-shrink-0 px-5 py-4 border-b-1 border-nc-border-gray-medium bg-nc-bg-gray-extralight">
        <div class="flex items-center justify-between">
          <h3 class="text-base font-semibold text-nc-content-gray">{{ t('activity.aiChat') }}</h3>
          <div class="flex items-center gap-1">
            <NcTooltip placement="bottom">
              <template #title>{{ t('activity.newChat') || '新建会话' }}</template>
              <NcButton
                size="small"
                type="text"
                class="!h-7 !px-2 text-nc-content-gray-muted hover:text-nc-content-gray hover:bg-nc-bg-gray-light"
                :disabled="!selectedSourceId"
                @click="clearMessages()"
              >
                <GeneralIcon icon="plus" class="w-4 h-4" />
              </NcButton>
            </NcTooltip>
            <a-dropdown
              v-model:visible="sessionListVisible"
              :trigger="['click']"
              placement="bottomRight"
              overlay-class-name="nc-chat-session-dropdown"
            >
              <NcTooltip placement="bottom">
                <template #title>{{ t('activity.chatHistory') || '历史会话' }}</template>
                <NcButton
                  size="small"
                  type="text"
                  class="!h-7 !px-2 text-nc-content-gray-muted hover:text-nc-content-gray hover:bg-nc-bg-gray-light"
                  :disabled="!selectedSourceId"
                >
                  <GeneralIcon icon="clock" class="w-4 h-4" />
                </NcButton>
              </NcTooltip>
              <template #overlay>
                <div class="nc-chat-session-list min-w-56 max-h-72 overflow-y-auto bg-nc-bg-default rounded-lg shadow-lg border border-nc-border-gray-medium py-1">
                  <div v-if="sessionListLoading" class="px-4 py-3 text-sm text-nc-content-gray-muted text-center">
                    {{ t('labels.loading') || '加载中...' }}
                  </div>
                  <template v-else-if="sessions.length === 0">
                    <div class="px-4 py-3 text-sm text-nc-content-gray-muted text-center">
                      {{ t('activity.noChatHistory') || '暂无会话' }}
                    </div>
                  </template>
                  <template v-else>
                    <div
                      class="flex items-center gap-2 px-3 py-2 border-b border-nc-border-gray-medium hover:bg-nc-bg-gray-extralight cursor-pointer text-primary"
                      @click="clearMessages(); sessionListVisible = false"
                    >
                      <GeneralIcon icon="plus" class="w-4 h-4 flex-shrink-0" />
                      <span class="text-sm font-medium">{{ t('activity.newChat') || '新建会话' }}</span>
                    </div>
                    <div
                      v-for="s in sessions"
                      :key="s.session_id"
                      class="flex items-center gap-2 px-3 py-2 hover:bg-nc-bg-gray-extralight cursor-pointer group"
                      :class="{ 'bg-primary/10': sessionId === s.session_id }"
                      @click="loadSessionHistory(s.session_id)"
                    >
                      <div class="flex-1 min-w-0">
                        <div class="text-xs text-nc-content-gray truncate">
                          {{ s.latest_user_message || t('activity.emptySession') || '空会话' }}
                        </div>
                        <div class="text-[10px] text-nc-content-gray-muted mt-0.5">
                          {{ formatSessionTime(s.created_at) }}
                        </div>
                      </div>
                      <NcButton
                        type="text"
                        size="small"
                        class="!h-6 !w-6 !p-0 opacity-0 group-hover:opacity-100 text-nc-content-gray-muted hover:text-red-500"
                        @click="deleteSession(s.session_id, $event)"
                      >
                        <GeneralIcon icon="delete" class="w-3.5 h-3.5" />
                      </NcButton>
                    </div>
                  </template>
                </div>
              </template>
            </a-dropdown>
            <NcTooltip>
              <template #title>{{ maximized ? t('activity.restoreChat') : t('activity.maximizeChat') }}</template>
              <NcButton
                size="small"
                type="text"
                class="!h-7 !px-2 text-nc-content-gray-muted hover:text-nc-content-gray hover:bg-nc-bg-gray-light"
                @click="emit('toggle-maximize')"
              >
                <GeneralIcon :icon="maximized ? 'shrink' : 'ncMaximize2'" class="w-4 h-4" />
              </NcButton>
            </NcTooltip>
            <NcTooltip>
              <template #title>{{ t('activity.collapseChat') }}</template>
              <NcButton
                size="small"
                type="text"
                class="!h-7 !px-2 text-nc-content-gray-muted hover:text-nc-content-gray hover:bg-nc-bg-gray-light"
                @click="emit('toggle-collapse')"
              >
                <GeneralIcon icon="chevronRight" class="w-4 h-4" />
              </NcButton>
            </NcTooltip>
          </div>
        </div>
      </div>

    <!-- 内容区域 -->
    <div class="flex-1 overflow-hidden flex flex-col min-h-0 min-w-0 w-full">
      <!-- 消息列表 -->
      <div
        v-if="messages.length > 0"
        ref="messagesContainer"
        class="flex-1 overflow-y-auto overflow-x-hidden px-5 py-6 space-y-5 nc-scrollbar-md w-full min-w-0"
      >
        <div
          v-for="msg in messages"
          :key="msg.id"
          class="flex gap-3"
          :class="msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'"
        >
          <!-- 头像占位 -->
          <div
            class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium"
            :class="
              msg.role === 'user'
                ? 'bg-primary text-white'
                : 'bg-nc-bg-gray-medium text-nc-content-gray-muted'
            "
          >
            <template v-if="msg.role === 'user'">我</template>
            <GeneralIcon v-else icon="cellAi" class="w-4 h-4" />
          </div>
          
          <!-- 消息气泡 -->
          <div
            class="flex-1 max-w-[80%] min-w-0"
            :class="msg.role === 'user' ? 'flex flex-col items-end' : 'flex flex-col items-start'"
          >
            <div
              class="rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm min-w-0 overflow-hidden max-w-full"
              :class="
                msg.role === 'user'
                  ? 'bg-primary text-white rounded-br-sm'
                  : 'bg-nc-bg-gray-light text-nc-content-gray rounded-bl-sm border border-nc-border-gray-medium'
              "
            >
              <div v-if="msg.role === 'user'" class="whitespace-pre-wrap break-words">{{ msg.content }}</div>
              <template v-else>
                <!-- 流式进行中：仅展示 thinking，完整不截断 -->
                <div
                  v-if="getStreamingThinkingSteps(msg).length > 0 && isStreaming && msg.id === messages[messages.length - 1]?.id"
                  :ref="(el) => { thinkingStreamContainerRef = el as HTMLElement | null }"
                  class="space-y-2 mb-3 pb-3 border-b border-nc-border-gray-medium max-h-48 overflow-y-auto overflow-x-hidden nc-scrollbar-md min-w-0"
                >
                  <div
                    v-for="step in getStreamingThinkingSteps(msg)"
                    :key="step.id"
                    class="flex items-start gap-2 text-xs min-w-0"
                  >
                    <GeneralIcon icon="ncInfo" class="w-3.5 h-3.5 mt-[0.2em] flex-shrink-0 text-primary/70" />
                    <pre class="flex-1 min-w-0 max-w-full text-nc-content-gray-muted whitespace-pre-wrap break-words">{{ step.message }}</pre>
                  </div>
                </div>
                <!-- 完成后：折叠的推理面板 - 完整展示 thinking 与 tool 的 input/output -->
                <div
                  v-else-if="getReasoningSteps(msg).length > 0"
                  class="mb-3 rounded-lg border border-nc-border-gray-medium overflow-hidden w-full min-w-0 max-w-full"
                >
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-nc-content-gray bg-nc-bg-gray-extralight hover:bg-nc-bg-gray-light transition-colors"
                    @click="toggleReasoning(msg.id)"
                  >
                    <GeneralIcon
                      :icon="expandedReasoningIds.has(msg.id) ? 'ncChevronUp' : 'ncChevronDown'"
                      class="w-3.5 h-3.5 flex-shrink-0 text-nc-content-gray-muted"
                    />
                    <span>推理思路</span>
                    <span class="text-nc-content-gray-muted font-normal">({{ getReasoningSteps(msg).length }} 步)</span>
                    <span class="flex-1" />
                  </button>
                  <div
                    v-show="expandedReasoningIds.has(msg.id)"
                    class="border-t border-nc-border-gray-medium max-h-80 overflow-y-auto overflow-x-hidden nc-scrollbar-md w-full min-w-0"
                  >
                    <div
                      v-for="(step, idx) in getReasoningSteps(msg)"
                      :key="step.id"
                      class="border-b border-nc-border-gray-light last:border-b-0"
                      :class="step.type === 'thinking' ? 'bg-white/50' : 'bg-nc-bg-gray-extralight/80'"
                    >
                      <!-- 步骤头部 -->
                      <div class="flex items-center gap-2 px-3 py-2">
                        <span
                          class="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-[10px] font-medium"
                          :class="step.type === 'thinking' ? 'bg-primary/10 text-primary' : 'bg-nc-bg-gray-medium text-nc-content-gray-muted'"
                        >
                          {{ idx + 1 }}
                        </span>
                        <GeneralIcon
                          v-if="step.type === 'thinking'"
                          icon="ncInfo"
                          class="w-3.5 h-3.5 flex-shrink-0 text-primary/70"
                        />
                        <GeneralIcon
                          v-else
                          :icon="step.status === 'completed' ? 'ncCheck' : step.status === 'failed' ? 'close' : 'ncLoader'"
                          :class="['w-3.5 h-3.5 flex-shrink-0', step.status === 'completed' && 'text-green-600', step.status === 'failed' && 'text-red-500', step.status === 'active' && 'animate-spin text-primary']"
                        />
                        <span class="text-xs font-medium text-nc-content-gray">
                          {{ step.type === 'thinking' ? '推理' : '工具调用' }}
                          <template v-if="step.type === 'tool' && step.toolName">: {{ step.toolName }}</template>
                        </span>
                      </div>
                      <!-- 步骤内容：完整展示，约束在容器内不溢出 -->
                      <div class="pl-8 pr-3 pb-3 min-w-0 w-full overflow-hidden">
                        <!-- Thinking: 完整文本 -->
                        <template v-if="step.type === 'thinking'">
                          <pre class="nc-reasoning-block text-xs text-nc-content-gray">{{ step.message }}</pre>
                        </template>
                        <!-- Tool: 输入 / 输出分段展示 -->
                        <template v-else>
                          <div v-if="step.toolInput != null && (typeof step.toolInput === 'object' || (typeof step.toolInput === 'string' && step.toolInput))" class="mb-2 min-w-0">
                            <div class="text-[10px] font-medium text-nc-content-gray-muted mb-1">输入</div>
                            <pre class="nc-reasoning-block text-xs text-nc-content-gray">{{ formatJsonBlock(step.toolInput) }}</pre>
                          </div>
                          <div v-if="step.toolOutput != null && (typeof step.toolOutput === 'object' || (typeof step.toolOutput === 'string' && step.toolOutput))" class="min-w-0">
                            <div class="text-[10px] font-medium text-nc-content-gray-muted mb-1">输出</div>
                            <pre class="nc-reasoning-block text-xs text-nc-content-gray">{{ formatJsonBlock(step.toolOutput) }}</pre>
                          </div>
                          <!-- 无结构化 input/output 时回退到 message -->
                          <div v-else-if="step.message" class="text-xs text-nc-content-gray nc-reasoning-block">{{ step.message }}</div>
                        </template>
                      </div>
                    </div>
                  </div>
                </div>
                <ChatMarkdownBlock :content="extractDisplayContent(msg.content)" />
              </template>
              <div
                v-if="msg.role === 'assistant' && isStreaming && msg.id === messages[messages.length - 1]?.id"
                class="inline-flex items-center gap-1.5 mt-2 nc-typing-dots"
              >
                <span class="nc-typing-dot"></span>
                <span class="nc-typing-dot" style="animation-delay: 0.15s"></span>
                <span class="nc-typing-dot" style="animation-delay: 0.3s"></span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 建议提示区域 -->
      <div v-else class="flex-1 overflow-y-auto overflow-x-hidden px-5 py-8 nc-scrollbar-md w-full min-w-0 flex flex-col items-center">
        <!-- AI 问候 -->
        <div
          class="flex flex-col items-center justify-center mb-10 w-full mx-auto"
          :class="maximized ? 'max-w-2xl' : 'max-w-md'"
        >
          <div class="relative w-28 h-28 mb-5 flex items-center justify-center">
            <!-- AI 神经网络图标 -->
            <svg
              class="w-28 h-28 text-primary ai-network-icon"
              viewBox="0 0 100 100"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <!-- 背景圆形渐变 -->
              <defs>
                <radialGradient id="aiGradient" cx="50%" cy="50%">
                  <stop offset="0%" stop-color="rgb(51, 102, 255)" stop-opacity="0.3" />
                  <stop offset="50%" stop-color="rgb(51, 102, 255)" stop-opacity="0.15" />
                  <stop offset="100%" stop-color="rgb(51, 102, 255)" stop-opacity="0" />
                </radialGradient>
                <linearGradient id="connectionGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="rgb(51, 102, 255)" stop-opacity="0.6" />
                  <stop offset="50%" stop-color="rgb(51, 102, 255)" stop-opacity="0.3" />
                  <stop offset="100%" stop-color="rgb(51, 102, 255)" stop-opacity="0.6" />
                </linearGradient>
              </defs>
              
              <!-- 背景脉冲圆 -->
              <circle cx="50" cy="50" r="45" fill="url(#aiGradient)" class="animate-pulse-ring-bg" />
              
              <!-- 连接线（神经网络连接） -->
              <line x1="30" y1="30" x2="50" y2="50" stroke="url(#connectionGradient)" stroke-width="1.5" class="animate-connection-1" />
              <line x1="70" y1="30" x2="50" y2="50" stroke="url(#connectionGradient)" stroke-width="1.5" class="animate-connection-2" />
              <line x1="30" y1="70" x2="50" y2="50" stroke="url(#connectionGradient)" stroke-width="1.5" class="animate-connection-3" />
              <line x1="70" y1="70" x2="50" y2="50" stroke="url(#connectionGradient)" stroke-width="1.5" class="animate-connection-4" />
              <line x1="20" y1="50" x2="30" y2="30" stroke="url(#connectionGradient)" stroke-width="1" opacity="0.5" class="animate-connection-5" />
              <line x1="80" y1="50" x2="70" y2="30" stroke="url(#connectionGradient)" stroke-width="1" opacity="0.5" class="animate-connection-6" />
              
              <!-- 外围节点 -->
              <circle cx="30" cy="30" r="4" fill="rgb(51, 102, 255)" class="animate-node-pulse-1" />
              <circle cx="70" cy="30" r="4" fill="rgb(51, 102, 255)" class="animate-node-pulse-2" />
              <circle cx="30" cy="70" r="4" fill="rgb(51, 102, 255)" class="animate-node-pulse-3" />
              <circle cx="70" cy="70" r="4" fill="rgb(51, 102, 255)" class="animate-node-pulse-4" />
              <circle cx="20" cy="50" r="3" fill="rgb(51, 102, 255)" opacity="0.7" class="animate-node-pulse-5" />
              <circle cx="80" cy="50" r="3" fill="rgb(51, 102, 255)" opacity="0.7" class="animate-node-pulse-6" />
              
              <!-- 中心节点（AI核心） -->
              <circle cx="50" cy="50" r="8" fill="rgb(51, 102, 255)" class="animate-center-glow" />
              <circle cx="50" cy="50" r="6" fill="rgb(255, 255, 255)" opacity="0.9" />
              
              <!-- 中心发光效果 -->
              <circle cx="50" cy="50" r="12" fill="rgb(51, 102, 255)" opacity="0.2" class="animate-center-pulse" />
            </svg>
          </div>
          <h4 class="text-base font-medium text-nc-content-gray mb-1">{{ t('activity.howCanIHelp') }}</h4>
          <p
            class="text-xs text-nc-content-gray-muted text-center"
            :class="maximized ? 'max-w-md' : 'max-w-xs'"
          >
            {{ t('activity.chatHint') }}
          </p>
        </div>

        <!-- 建议提示列表 -->
        <div
          class="space-y-3 w-full flex-shrink-0 mx-auto"
          :class="maximized ? 'max-w-xl' : 'max-w-sm'"
        >
          <button
            v-for="prompt in suggestedPrompts[0]?.prompts"
            :key="prompt"
            class="w-full text-left px-4 py-3 rounded-xl border-1 border-nc-border-gray-medium bg-nc-bg-default hover:bg-nc-bg-gray-extralight hover:border-primary/30 hover:shadow-sm transition-all duration-200 text-sm text-nc-content-gray group"
            :disabled="isLoading || isStreaming"
            @click="useSuggestion(prompt)"
          >
            <div class="flex items-center gap-2">
              <div class="w-1.5 h-1.5 rounded-full bg-primary/40 group-hover:bg-primary transition-colors"></div>
              <span>{{ prompt }}</span>
            </div>
          </button>
        </div>
      </div>
    </div>

    <!-- 输入区域 -->
    <div class="flex-shrink-0 w-full flex justify-center px-5 py-4 border-t-1 border-nc-border-gray-medium bg-nc-bg-default">
      <div
        class="nc-chat-input-box w-full mx-auto"
        :class="maximized ? 'max-w-2xl' : 'max-w-md'"
      >
        <!-- 上方：文字输入区域 -->
        <textarea
          v-model="currentMessage"
          :placeholder="selectedSourceId ? t('activity.enterQuestion') : t('activity.selectSourceFirst')"
          :disabled="isLoading || isStreaming || !selectedSourceId"
          class="nc-chat-textarea"
          rows="3"
          @keydown="handleKeyDown"
        />
        <!-- 下方工具栏：左侧数据源，右侧发送按钮 -->
        <div class="nc-chat-toolbar">
          <!-- 左侧：数据源图标 + 下拉框 -->
          <div v-if="sources.length > 0" class="nc-source-row">
            <GeneralIcon icon="cellDb" class="nc-source-icon text-nc-content-gray-muted flex-shrink-0" />
            <a-select
              v-model:value="selectedSourceId"
              :options="sources.map((s, idx) => ({ label: getSourceDisplayName(s, idx), value: s.id }))"
              size="small"
              class="nc-source-select"
              :disabled="isLoading || isStreaming"
              :bordered="false"
              :dropdownMatchSelectWidth="false"
            >
              <template #suffixIcon>
                <GeneralIcon icon="chevronDown" class="w-3 h-3 text-nc-content-gray-muted" />
              </template>
            </a-select>
          </div>
          <div v-else class="flex-1" />
          <!-- 右侧：发送按钮 -->
          <NcButton
            type="primary"
            icon-only
            :loading="isLoading || isStreaming"
            :disabled="!currentMessage.trim() || !selectedSourceId"
            class="nc-send-btn"
            @click="sendMessage()"
          >
            <template #icon>
              <GeneralIcon icon="arrowUp" class="w-4 h-4 flex-shrink-0" />
            </template>
          </NcButton>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.nc-datus-agent-chat-sidebar {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

/* 等待 response 时的动态打字指示器：圆点依次弹跳 */
@keyframes typing-dot-bounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

.nc-typing-dots {
  align-items: flex-end;
}

.nc-typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--nc-content-gray-muted, #6b7280);
  animation: typing-dot-bounce 1.4s ease-in-out infinite;
}

/* 推理面板内容块：约束在容器内，长内容折行 + 内部滚动 */
.nc-reasoning-block {
  @apply rounded px-2.5 py-2 bg-nc-bg-default/80 border border-nc-border-gray-light;
  max-height: 12rem;
  overflow: auto;
  overflow-wrap: break-word;
  word-break: break-word;
  white-space: pre-wrap;
  max-width: 100%;
  font-family: ui-monospace, 'SF Mono', Monaco, monospace;
}


/* 输入框整体容器：flex 列布局 */
.nc-chat-input-box {
  @apply rounded-xl border-1 border-nc-border-gray-medium bg-nc-bg-gray-extralight flex flex-col;
  
  /* 移除聚焦时的蓝色边框、阴影、ring */
  &:focus-within {
    border-color: var(--nc-border-gray-medium) !important;
    box-shadow: none !important;
    outline: none !important;
    --tw-ring-color: transparent !important;
    --tw-ring-shadow: 0 0 #0000 !important;
  }
}

/* 上方：文字输入区域 */
.nc-chat-textarea {
  @apply w-full bg-transparent text-sm text-nc-content-gray resize-none px-4 pt-3 pb-2;
  min-height: 72px;
  max-height: 160px;
  border: none !important;
  outline: none !important;
  
  &:focus {
    outline: none !important;
    box-shadow: none !important;
    border-color: transparent !important;
    --tw-ring-color: transparent !important;
    --tw-ring-shadow: 0 0 #0000 !important;
  }
  
  &::placeholder {
    @apply text-nc-content-gray-muted;
  }
  
  &:disabled {
    @apply cursor-not-allowed opacity-60;
  }
}

/* 下方工具栏 */
.nc-chat-toolbar {
  @apply flex items-center justify-between px-3 pb-2.5 pt-1 gap-2;
  border-top: 1px solid transparent;
  
  /* 数据源行：图标 + 下拉框 */
  .nc-source-row {
    @apply flex items-center flex-1 min-w-0;
    
    .nc-source-icon {
      @apply w-4 h-4;
    }
  }
  
  /* 数据源下拉框 */
  :deep(.nc-source-select) {
    .ant-select-selector {
      @apply border-none bg-nc-bg-gray-light/90 shadow-sm rounded-md px-2 h-7;
      transition: background 0.2s;
      
      .ant-select-selection-item {
        @apply text-xs text-nc-content-gray font-medium;
        line-height: 28px;
      }
      
      .ant-select-selection-placeholder {
        @apply text-xs text-nc-content-gray-muted;
        line-height: 28px;
      }
    }
    
    &:hover .ant-select-selector {
      @apply bg-nc-bg-gray-medium;
    }
    
    /* 移除聚焦时的蓝色边框 */
    &.ant-select-focused .ant-select-selector {
      border-color: transparent !important;
      box-shadow: none !important;
      outline: none !important;
    }
  }
  
  /* 发送按钮 */
  .nc-send-btn {
    @apply !h-8 !w-8 !p-0 !rounded-lg !min-w-8 flex-shrink-0 flex items-center justify-center;
    box-shadow: 0 2px 4px rgba(51, 102, 255, 0.25);
    transition: all 0.15s;

    :deep(.nc-btn-inner) {
      @apply flex items-center justify-center;
    }
    
    &:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 4px 8px rgba(51, 102, 255, 0.35);
    }
    
    &:active:not(:disabled) {
      transform: none;
    }
    
    &:disabled {
      @apply opacity-40;
      box-shadow: none;
    }
  }
}

/* AI 神经网络图标动画 */
.ai-network-icon {
  filter: drop-shadow(0 0 8px rgb(51, 102, 255, 0.3));
}

/* 背景脉冲 */
@keyframes pulse-ring-bg {
  0%, 100% {
    opacity: 0.3;
    transform: scale(1);
  }
  50% {
    opacity: 0.6;
    transform: scale(1.1);
  }
}

/* 连接线动画 - 数据流动效果 */
@keyframes connection-flow-1 {
  0%, 100% {
    stroke-opacity: 0.3;
  }
  50% {
    stroke-opacity: 0.8;
  }
}

@keyframes connection-flow-2 {
  0%, 100% {
    stroke-opacity: 0.3;
  }
  50% {
    stroke-opacity: 0.8;
  }
}

@keyframes connection-flow-3 {
  0%, 100% {
    stroke-opacity: 0.3;
  }
  50% {
    stroke-opacity: 0.8;
  }
}

@keyframes connection-flow-4 {
  0%, 100% {
    stroke-opacity: 0.3;
  }
  50% {
    stroke-opacity: 0.8;
  }
}

@keyframes connection-flow-5 {
  0%, 100% {
    stroke-opacity: 0.2;
  }
  50% {
    stroke-opacity: 0.6;
  }
}

@keyframes connection-flow-6 {
  0%, 100% {
    stroke-opacity: 0.2;
  }
  50% {
    stroke-opacity: 0.6;
  }
}

/* 节点脉冲动画 */
@keyframes node-pulse-1 {
  0%, 100% {
    opacity: 0.8;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
  }
}

@keyframes node-pulse-2 {
  0%, 100% {
    opacity: 0.8;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
  }
}

@keyframes node-pulse-3 {
  0%, 100% {
    opacity: 0.8;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
  }
}

@keyframes node-pulse-4 {
  0%, 100% {
    opacity: 0.8;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
  }
}

@keyframes node-pulse-5 {
  0%, 100% {
    opacity: 0.6;
    transform: scale(1);
  }
  50% {
    opacity: 0.9;
    transform: scale(1.15);
  }
}

@keyframes node-pulse-6 {
  0%, 100% {
    opacity: 0.6;
    transform: scale(1);
  }
  50% {
    opacity: 0.9;
    transform: scale(1.15);
  }
}

/* 中心节点发光 */
@keyframes center-glow {
  0%, 100% {
    opacity: 1;
    filter: drop-shadow(0 0 4px rgb(51, 102, 255, 0.6));
  }
  50% {
    opacity: 0.9;
    filter: drop-shadow(0 0 8px rgb(51, 102, 255, 0.9));
  }
}

@keyframes center-pulse {
  0%, 100% {
    opacity: 0.2;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(1.3);
  }
}

.animate-pulse-ring-bg {
  animation: pulse-ring-bg 3s ease-in-out infinite;
}

.animate-connection-1 {
  animation: connection-flow-1 2s ease-in-out infinite;
}

.animate-connection-2 {
  animation: connection-flow-2 2s ease-in-out infinite 0.3s;
}

.animate-connection-3 {
  animation: connection-flow-3 2s ease-in-out infinite 0.6s;
}

.animate-connection-4 {
  animation: connection-flow-4 2s ease-in-out infinite 0.9s;
}

.animate-connection-5 {
  animation: connection-flow-5 2.5s ease-in-out infinite 0.2s;
}

.animate-connection-6 {
  animation: connection-flow-6 2.5s ease-in-out infinite 1.1s;
}

.animate-node-pulse-1 {
  animation: node-pulse-1 2s ease-in-out infinite;
}

.animate-node-pulse-2 {
  animation: node-pulse-2 2s ease-in-out infinite 0.4s;
}

.animate-node-pulse-3 {
  animation: node-pulse-3 2s ease-in-out infinite 0.8s;
}

.animate-node-pulse-4 {
  animation: node-pulse-4 2s ease-in-out infinite 1.2s;
}

.animate-node-pulse-5 {
  animation: node-pulse-5 2.5s ease-in-out infinite 0.3s;
}

.animate-node-pulse-6 {
  animation: node-pulse-6 2.5s ease-in-out infinite 1.3s;
}

.animate-center-glow {
  animation: center-glow 2s ease-in-out infinite;
}

.animate-center-pulse {
  animation: center-pulse 2s ease-in-out infinite;
}
</style>
