/**
 * 时间线的纯逻辑：文本截断、消息转节点、按日期分组、分组截断。
 *
 * 抽出来的唯一目的：能被 node:test 直接覆盖。
 * 这些函数决定侧边栏显示什么，而 TUI 的渲染结果没法自动验证；
 * 它们本身没有副作用，正好可以测。
 *
 * 这个文件不允许引入运行时依赖，只能有纯函数。
 */

export type TimelineNode = {
  id: string
  created: number
  summary: string
  /** 完整消息文本（多行已合并），hover 时折行显示 */
  full: string
}

export type TimelineGroup = {
  key: string
  label: string
  nodes: TimelineNode[]
}

/**
 * 只依赖这几个字段，避免和 @opencode/client 的类型耦合，测试也好造数据。
 * 真实的 UserMessage 结构兼容它。
 */
export interface UserMessageLike {
  id: string
  text?: string | null
  files?: readonly unknown[] | null
  time: { created: number }
}

/** 计算字符串的终端显示宽度（CJK 记 2 列）。 */
export function displayWidth(value: string): number {
  let width = 0
  for (const char of value) width += (char.codePointAt(0) ?? 0) > 0xff ? 2 : 1
  return width
}

/** 按终端显示宽度截断，超出时追加省略号。 */
export function truncate(value: string, max: number): string {
  if (displayWidth(value) <= max) return value
  // 省略号本身按 CJK 宽度算 2 列（U+2026 > 0xff），必须按它的实际宽度预留。
  // 原来固定留 1 列，结果总比 max 宽一列，在窄面板里正好溢出一格。
  const limit = Math.max(0, max - displayWidth("…"))
  let out = ""
  let width = 0
  for (const char of value) {
    const w = (char.codePointAt(0) ?? 0) > 0xff ? 2 : 1
    if (width + w > limit) break
    out += char
    width += w
  }
  return out + "…"
}

export function timelineNode(message: UserMessageLike): TimelineNode {
  const lines = (message.text ?? "")
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  const files = message.files?.length ?? 0
  const first = lines[0] ?? (files > 0 ? `[附件 ×${files}]` : "(空消息)")
  return {
    id: message.id,
    created: message.time.created,
    summary: truncate(first, 34),
    // 完整文本（多行合并成一段，便于折行显示），留 400 字上限防止极端长消息
    full: truncate(lines.join(" ") || first, 400),
  }
}

export function sameTimelineNode(a: TimelineNode, b: TimelineNode): boolean {
  return a.created === b.created && a.summary === b.summary && a.full === b.full
}

function pad(value: number): string {
  return value.toString().padStart(2, "0")
}

export function dateKey(created: number): string {
  const date = new Date(created)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function formatDate(created: number): string {
  const date = new Date(created)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function formatTime(created: number): string {
  const date = new Date(created)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 按本地日期把节点切成组，输入顺序即为输出顺序。 */
export function groupNodes(values: readonly TimelineNode[]): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  for (const node of values) {
    const key = dateKey(node.created)
    const previous = groups[groups.length - 1]
    if (previous?.key === key) {
      previous.nodes.push(node)
      continue
    }
    groups.push({ key, label: formatDate(node.created), nodes: [node] })
  }
  return groups
}

/**
 * 只保留最近 nodeLimit 条节点，从最后一组往前取，组内保留尾部。
 * 用于「消息少时按行数收缩面板」和「只显示最近几条」两种场景。
 */
export function latestGroups(groups: readonly TimelineGroup[], nodeLimit: number): TimelineGroup[] {
  const shown: TimelineGroup[] = []
  let remaining = nodeLimit
  for (let index = groups.length - 1; index >= 0 && remaining > 0; index--) {
    const group = groups[index]
    if (!group) continue
    const nodes = group.nodes.slice(Math.max(0, group.nodes.length - remaining))
    shown.unshift({ ...group, nodes })
    remaining -= nodes.length
  }
  return shown
}

/** 宿主跳转命令可定位的用户消息（与宿主实现一致：跳过空白文本消息）。 */
export function navigable(node: UserMessageLike): boolean {
  return (node.text ?? "").trim().length > 0
}
