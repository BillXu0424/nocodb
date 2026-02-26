<script lang="ts" setup>
/**
 * 参考 datus-agent ChatMessage.tsx
 * 使用 unified + remark-gfm + rehype-highlight 渲染 Markdown，支持 GFM 表格、语法高亮
 */
const props = defineProps<{
  content: string
}>()

const { renderChatMarkdown } = useChatMarkdown()

const renderedHtml = computedAsync(
  async () => await renderChatMarkdown(props.content),
  '',
)
</script>

<template>
  <div class="nc-chat-prose break-words min-w-0 overflow-hidden" v-html="renderedHtml" />
</template>

<style lang="scss" scoped>
/* prose-cyber 样式（参考 datus-agent） */
.nc-chat-prose {
  @apply text-sm leading-7 text-nc-content-gray;
  overflow-wrap: anywhere;
  word-break: break-word;

  :deep(h1),
  :deep(h2),
  :deep(h3) {
    @apply font-semibold mb-3 mt-6 first:mt-0 text-nc-content-gray;
  }
  :deep(p) {
    @apply mb-3 last:mb-0;
  }
  :deep(a) {
    @apply text-primary hover:underline font-medium;
  }
  :deep(code) {
    @apply px-1.5 py-0.5 rounded text-xs font-mono bg-nc-bg-gray-medium text-nc-content-gray border border-nc-border-gray-medium;
  }
  :deep(pre code) {
    @apply bg-transparent border-none;
  }
  :deep(pre) {
    @apply overflow-auto my-2 p-3 rounded-lg bg-nc-bg-gray-medium text-xs max-w-full;
  }
  :deep(ul),
  :deep(ol) {
    @apply pl-5 my-3 space-y-1;
  }
  :deep(ul li::marker) {
    @apply text-nc-content-gray-muted;
  }
  :deep(table) {
    @apply w-full text-xs my-4 border-separate border-spacing-0 rounded-lg overflow-hidden border border-nc-border-gray-medium;
    table-layout: fixed;
  }
  :deep(th) {
    @apply px-4 py-2.5 text-left font-semibold bg-nc-bg-gray-extralight text-nc-content-gray border-b border-nc-border-gray-medium;
  }
  :deep(td) {
    @apply px-4 py-2.5 text-nc-content-gray border-b border-nc-border-gray-medium;
  }
  :deep(tr:last-child td) {
    @apply border-b-0;
  }
  :deep(blockquote) {
    @apply border-l-4 border-primary pl-4 py-2 pr-2 italic my-4 rounded-r-lg bg-primary/5 text-nc-content-gray;
  }
  /* highlight.js 语法高亮（github 风格） */
  :deep(.hljs) {
    @apply bg-transparent p-0;
  }
  :deep(.hljs-keyword) {
    color: #d73a49;
  }
  :deep(.hljs-string) {
    color: #032f62;
  }
  :deep(.hljs-number) {
    color: #005cc5;
  }
  :deep(.hljs-comment) {
    color: #6a737d;
    font-style: italic;
  }
  :deep(.hljs-title) {
    color: #6f42c1;
  }
  :deep(.hljs-attr) {
    color: #005cc5;
  }
  :deep(.hljs-built_in),
  :deep(.hljs-builtin-name) {
    color: #005cc5;
  }
  :deep(.hljs-function) {
    color: #6f42c1;
  }
  :deep(.hljs-meta) {
    color: #005cc5;
  }
}
</style>
