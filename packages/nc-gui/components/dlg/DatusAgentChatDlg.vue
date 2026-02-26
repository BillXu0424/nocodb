<script lang="ts" setup>
import type { SourceType } from 'nocodb-sdk'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

const props = defineProps<{
  modelValue: boolean
  baseId: string
}>()

const emit = defineEmits(['update:modelValue'])

const { t } = useI18n()
const { api } = useApi()

const dialogShow = useVModel(props, 'modelValue', emit)

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

const getRequestConfig = () => {
  const config = useRuntimeConfig()
  const baseURL = (config.public.ncBackendUrl || BASE_FALLBACK_URL).replace(/\/$/, '')
  const token = useCookie('token').value || ''
  return { baseURL, authToken: token }
}

// 加载数据源列表
const loadSources = async () => {
  try {
    const response = await api.source.list(props.baseId)
    if (response.list) {
      // 过滤掉 meta 数据源，只显示外部数据源
      sources.value = response.list.filter((s: SourceType) => !s.is_meta)
      // 默认选择第一个数据源
      if (sources.value.length > 0 && !selectedSourceId.value) {
        selectedSourceId.value = sources.value[0].id!
      }
    }
  } catch (error) {
    console.error('Failed to load sources:', error)
    message.error('加载数据源失败')
  }
}

// 发送消息
const sendMessage = async () => {
  if (!currentMessage.value.trim() || isLoading.value || !selectedSourceId.value) {
    return
  }

  const userMessage: Message = {
    id: Date.now().toString(),
    role: 'user',
    content: currentMessage.value.trim(),
    timestamp: Date.now(),
  }

  messages.value.push(userMessage)
  const messageText = currentMessage.value.trim()
  currentMessage.value = ''

  // 添加一个空的助手消息用于流式更新
  const assistantMessage: Message = {
    id: (Date.now() + 1).toString(),
    role: 'assistant',
    content: '',
    timestamp: Date.now() + 1,
  }
  messages.value.push(assistantMessage)

  isLoading.value = true
  isStreaming.value = true

  try {
    const config = useRuntimeConfig()
    const baseURL = config.public.ncBackendUrl || BASE_FALLBACK_URL
    const url = `${baseURL.replace(/\/$/, '')}/api/v2/meta/bases/${props.baseId}/ai/chat/stream`

    // 获取 token
    const token = useCookie('token').value || ''
    if (!token) {
      throw new Error('未找到认证 token')
    }

    // 构建请求体
    const requestBody = {
      message: messageText,
      session_id: sessionId.value || undefined,
      source_id: selectedSourceId.value,
    }

    // 使用 fetch 发送 SSE 请求
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xc-auth': token,
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
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
            handleSSEEvent(currentEventType, data, assistantMessage)
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
          handleSSEEvent(currentEventType, data, assistantMessage)
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
    loadSessions()
    nextTick(() => scrollToBottom())
  }
}

// 处理 SSE 事件（与 datus-agent /chat/stream 格式一致）
const handleSSEEvent = (eventType: string, data: any, assistantMessage: Message) => {
  switch (eventType) {
    case 'session':
      if (data?.session_id) {
        sessionId.value = data.session_id
      }
      break
    case 'thinking':
    case 'tool':
      break
    case 'response':
      const text = data?.text ?? data?.content
      if (text) {
        assistantMessage.content += text
      }
      break
    case 'done':
      isStreaming.value = false
      break
    case 'error':
      assistantMessage.content += `\n\n[错误: ${data?.error || '未知错误'}]`
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

// 清空对话
const clearMessages = () => {
  messages.value = []
  sessionId.value = ''
  currentMessage.value = ''
}

// 加载会话列表（按 namespace 过滤）
const loadSessions = async () => {
  if (!selectedSourceId.value) {
    sessions.value = []
    return
  }
  sessionListLoading.value = true
  try {
    const { baseURL, authToken } = getRequestConfig()
    const res = await fetch(
      `${baseURL}/api/v2/meta/bases/${props.baseId}/ai/chat/sessions?source_id=${selectedSourceId.value}`,
      { headers: { 'xc-auth': authToken } },
    )
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

// 加载会话历史（需 namespace 校验）
const loadSessionHistory = async (sid: string) => {
  if (!selectedSourceId.value) return
  isLoading.value = true
  try {
    const { baseURL, authToken } = getRequestConfig()
    const res = await fetch(
      `${baseURL}/api/v2/meta/bases/${props.baseId}/ai/chat/sessions/${sid}/messages?source_id=${selectedSourceId.value}`,
      { headers: { 'xc-auth': authToken } },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    messages.value = (data.messages || []).map((m: any, i: number) => ({
      id: `${sid}_${i}`,
      role: m.role || 'assistant',
      content: m.content || '',
      timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp || '') || Date.now(),
    }))
    sessionId.value = sid
    nextTick(() => scrollToBottom())
  } catch (e) {
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
    const res = await fetch(
      `${baseURL}/api/v2/meta/bases/${props.baseId}/ai/chat/sessions/${sid}`,
      { method: 'DELETE', headers: { 'xc-auth': authToken } },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    sessions.value = sessions.value.filter((s) => s.session_id !== sid)
    if (sessionId.value === sid) clearMessages()
  } catch (err) {
    message.error('删除会话失败: ' + (err instanceof Error ? err.message : '未知错误'))
  }
}

// 监听对话框打开
watch(dialogShow, (newVal) => {
  if (newVal) {
    loadSources()
    clearMessages()
  }
})

watch(selectedSourceId, () => {
  loadSessions()
  clearMessages()
})

// 键盘快捷键
const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}

// 选中的数据源
const selectedSource = computed(() => {
  return sources.value.find((s) => s.id === selectedSourceId.value)
})
</script>

<template>
  <a-drawer
    v-model:open="dialogShow"
    :title="t('activity.aiChat')"
    placement="right"
    :width="480"
    class="nc-datus-agent-chat-dlg"
    @close="dialogShow = false"
  >
    <div class="flex flex-col h-full">
      <!-- 数据源与历史会话 -->
      <div class="mb-4 pb-4 border-b-1 border-nc-border-gray-medium space-y-3">
        <div>
          <div class="text-sm font-medium mb-2">{{ t('general.datasource') || '数据源' }}</div>
          <a-select
            v-model:value="selectedSourceId"
            :options="sources.map((s) => ({ label: s.alias || s.id, value: s.id }))"
            class="w-full"
            :disabled="isLoading || isStreaming"
          />
        </div>
        <div v-if="selectedSourceId">
          <div class="text-sm font-medium mb-2">{{ t('activity.chatHistory') || '历史会话' }}</div>
          <div class="max-h-32 overflow-y-auto space-y-1 nc-scrollbar-thin">
            <div
              v-for="s in sessions"
              :key="s.session_id"
              class="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-nc-bg-gray-extralight group"
              :class="{ 'bg-primary/10': sessionId === s.session_id }"
            >
              <button
                type="button"
                class="flex-1 text-left text-xs text-nc-content-gray truncate min-w-0"
                @click="loadSessionHistory(s.session_id)"
              >
                {{ (s.latest_user_message || '空会话').slice(0, 35) }}{{ (s.latest_user_message || '').length > 35 ? '...' : '' }}
              </button>
              <NcButton
                type="text"
                size="small"
                class="!h-6 !w-6 !p-0 opacity-0 group-hover:opacity-100 text-nc-content-gray-muted hover:text-red-500 flex-shrink-0"
                @click="deleteSession(s.session_id, $event)"
              >
                <GeneralIcon icon="delete" class="w-3 h-3" />
              </NcButton>
            </div>
            <div v-if="sessionListLoading" class="px-2 py-1.5 text-xs text-nc-content-gray-muted">
              {{ t('labels.loading') || '加载中...' }}
            </div>
            <div v-else-if="sessions.length === 0" class="px-2 py-1.5 text-xs text-nc-content-gray-muted">
              {{ t('activity.noChatHistory') || '暂无会话' }}
            </div>
          </div>
        </div>
      </div>

      <!-- 消息列表 -->
      <div
        ref="messagesContainer"
        class="flex-1 overflow-y-auto overflow-x-hidden mb-4 space-y-4 nc-scrollbar-md min-w-0"
      >
        <div
          v-for="msg in messages"
          :key="msg.id"
          class="flex min-w-0"
          :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
        >
          <div
            class="max-w-[80%] min-w-0 overflow-hidden rounded-lg px-4 py-2"
            :class="
              msg.role === 'user'
                ? 'bg-nc-brand text-white'
                : 'bg-nc-bg-gray-light text-nc-content-gray'
            "
          >
            <div v-if="msg.role === 'user'" class="whitespace-pre-wrap break-words">{{ msg.content }}</div>
            <ChatMarkdownBlock v-else :content="msg.content" />
            <div
              v-if="msg.role === 'assistant' && isStreaming && msg.id === messages[messages.length - 1]?.id"
              class="inline-block w-2 h-2 bg-nc-content-gray rounded-full animate-pulse mt-1"
            />
          </div>
        </div>
      </div>

      <!-- 输入框 -->
      <div class="border-t-1 border-nc-border-gray-medium pt-4">
        <div class="flex gap-2">
          <a-textarea
            v-model:value="currentMessage"
            :placeholder="t('activity.enterQuestion') || '输入您的问题...'"
            :disabled="isLoading || isStreaming || !selectedSourceId"
            :rows="3"
            class="flex-1"
            @keydown="handleKeyDown"
          />
          <div class="flex flex-col gap-2">
            <a-button
              type="primary"
              :loading="isLoading || isStreaming"
              :disabled="!currentMessage.trim() || !selectedSourceId"
              @click="sendMessage"
            >
              {{ t('labels.send') || '发送' }}
            </a-button>
            <NcButton
              type="secondary"
              size="small"
              :disabled="!selectedSourceId"
              @click="clearMessages"
            >
              <GeneralIcon icon="plus" class="w-3.5 h-3.5 mr-1" />
              {{ t('activity.newChat') || '新建会话' }}
            </NcButton>
          </div>
        </div>
      </div>
    </div>
  </a-drawer>
</template>

<style lang="scss" scoped>
.nc-datus-agent-chat-dlg {
  :deep(.ant-drawer-body) {
    @apply flex flex-col p-4;
  }
}
</style>
