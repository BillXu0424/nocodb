/**
 * Chat Markdown 渲染（参考 datus-agent ChatMessage.tsx）
 * 使用 unified + remark-gfm + rehype-highlight，支持 GFM（表格、删除线等）和代码块语法高亮
 */
import rehypeHighlight from 'rehype-highlight'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'

// 扩展 rehype-sanitize schema 以允许 rehype-highlight 输出的 hljs-* 类（span 已在 defaultSchema 的 tagNames 中）
const schemaWithHighlight = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [['className', /^hljs-/]],
  },
} as const

let processor: ReturnType<typeof createProcessor> | null = null

function createProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeHighlight, { detect: true })
    .use(rehypeSanitize, schemaWithHighlight)
    .use(rehypeStringify)
}

function getProcessor() {
  if (!processor) {
    processor = createProcessor()
  }
  return processor
}

export function useChatMarkdown() {
  async function render(markdown: string): Promise<string> {
    if (!markdown?.trim()) return ''
    try {
      const result = await getProcessor().process(markdown)
      return String(result)
    } catch {
      return markdown
    }
  }
  return { renderChatMarkdown: render }
}
