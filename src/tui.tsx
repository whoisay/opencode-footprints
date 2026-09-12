/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode-ai/plugin/tui"
import type { Context } from "@opencode-ai/plugin/tui/context"
import type { SessionMessageInfo } from "@opencode-ai/client"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"

const COMMAND_ID = "user-timeline.toggle"

type Settings = { visible: boolean }

/** 一条用户消息节点（SessionMessageInfo 联合类型中的 user 变体）。 */
type UserMessage = Extract<SessionMessageInfo, { type: "user" }>

/** 侧边栏只保留渲染和定位所需字段，避免复制完整消息与附件元数据。 */
type TimelineNode = {
  id: string
  created: number
  summary: string
}

type TimelineGroup = {
  key: string
  label: string
  nodes: TimelineNode[]
}

/** 类型守卫：只关心 type === "user" 的消息。 */
function isUser(message: SessionMessageInfo): message is UserMessage {
  return message.type === "user"
}

/** 计算字符串的终端显示宽度（CJK 记 2 列）。 */
function displayWidth(value: string) {
  let width = 0
  for (const char of value) width += char.codePointAt(0)! > 0xff ? 2 : 1
  return width
}

/** 按终端显示宽度截断，超出时追加省略号。 */
function truncate(value: string, max: number) {
  if (displayWidth(value) <= max) return value
  let out = ""
  let width = 0
  for (const char of value) {
    const w = char.codePointAt(0)! > 0xff ? 2 : 1
    if (width + w > max - 1) break
    out += char
    width += w
  }
  return out + "…"
}

/** 用户消息的首个非空行；纯附件消息显示附件数量。 */
function summary(message: UserMessage) {
  const line = (message.text ?? "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (line) return line
  const files = message.files?.length ?? 0
  if (files > 0) return `[附件 ×${files}]`
  return "(空消息)"
}

function timelineNode(message: UserMessage): TimelineNode {
  return {
    id: message.id,
    created: message.time.created,
    summary: truncate(summary(message), 34),
  }
}

function sameTimelineNode(a: TimelineNode, b: TimelineNode) {
  return a.created === b.created && a.summary === b.summary
}

function pad(value: number) {
  return value.toString().padStart(2, "0")
}

function dateKey(created: number) {
  const date = new Date(created)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatDate(created: number) {
  const date = new Date(created)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatTime(created: number) {
  const date = new Date(created)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function groupNodes(values: TimelineNode[]) {
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

function latestGroups(groups: TimelineGroup[], nodeLimit: number) {
  const shown: TimelineGroup[] = []
  let remaining = nodeLimit
  for (let index = groups.length - 1; index >= 0 && remaining > 0; index--) {
    const group = groups[index]
    const nodes = group.nodes.slice(Math.max(0, group.nodes.length - remaining))
    shown.unshift({ ...group, nodes })
    remaining -= nodes.length
  }
  return shown
}

/** 宿主跳转命令可定位的用户消息（与宿主实现一致：跳过空白文本消息）。 */
function navigable(node: UserMessage) {
  return (node.text ?? "").trim().length > 0
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    const raf = (globalThis as typeof globalThis & {
      requestAnimationFrame?: (callback: () => void) => unknown
    }).requestAnimationFrame
    if (raf) raf(resolve)
    else setTimeout(resolve, 16)
  })
}

async function waitForFrames(count: number) {
  for (let i = 0; i < count; i++) await nextFrame()
}

async function waitForRenderable(context: Context, id: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    // 会话行嵌在 session scrollbox 深层；getRenderable 只查直接子节点。
    if (context.renderer.root.findDescendantById(id)) return true
    await nextFrame()
  }
  return false
}

type PagedHostMessages = Context["data"]["session"]["message"] & {
  more?(sessionID: string): boolean
  loading?(sessionID: string): boolean
  loadMore?(sessionID: string): Promise<void>
}

/** 宿主当前缓存里的用户消息——保持宿主原序（宿主导航认这个顺序，不能重排）。 */
function hostUsers(context: Context, sessionID: string): UserMessage[] {
  try {
    return (context.data.session.message.list(sessionID) ?? []).filter(isUser)
  } catch {
    return []
  }
}

/** 把目标消息逐页加载进宿主缓存，不触碰会话滚动锚。 */
async function ensureLoaded(context: Context, sessionID: string, id: string): Promise<boolean> {
  const messages = context.data.session.message as PagedHostMessages
  const more = messages.more?.bind(messages)
  const loading = messages.loading?.bind(messages)
  const loadMore = messages.loadMore?.bind(messages)

  // v2 当前把底层分页对象原样交给插件，只是公开类型暂未列出这三个方法。
  // 直接分页不会像 session.first 那样留下一个最终 scrollTo(0) 的异步回调。
  if (more && loading && loadMore) {
    const deadline = Date.now() + 60_000
    for (let page = 0; page < 400 && Date.now() < deadline; ) {
      if (hostUsers(context, sessionID).some((message) => message.id === id)) return true
      if (loading(sessionID)) {
        await sleep(50)
        continue
      }
      if (!more(sessionID)) return false
      try {
        await loadMore(sessionID)
      } catch {
        return false
      }
      page++
    }
    return hostUsers(context, sessionID).some((message) => message.id === id)
  }

  // 旧版兼容：没有分页 API 时才退回宿主命令，并在目标出现后等缓存静止，
  // 避免 session.first 尚未结束的回调覆盖最终落点。
  const deadline = Date.now() + 60_000
  let lastCount = -1
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    const hosts = hostUsers(context, sessionID)
    if (hosts.length !== lastCount) {
      lastCount = hosts.length
      quietSince = Date.now()
    }
    if (hosts.some((message) => message.id === id)) {
      if (Date.now() - quietSince >= 800) return true
      await sleep(100)
      continue
    }
    try {
      context.keymap.dispatch("session.first")
    } catch {
      return false
    }
    await sleep(200)
  }
  return false
}

/** 遮盖层控制：由 setup 里的 slot 渲染提供，不走 dialog（宿主滚动命令会清弹层）。 */
interface MaskControl {
  show(preview: string): void
  drop(): Promise<void>
}

/**
 * 点击跳转：dispatch 宿主自带的导航命令。
 * 先跳到最后一个可定位的用户消息，再按“目标之后还有几条可定位消息”往回走 N 步。
 *
 * 关键：步数必须用宿主当前缓存里的消息列表计算——宿主导航只在这个集合里移动，
 * 用插件的全量列表（服务端历史）会因两边时间差导致光标落偏。
 */
let jumping = false // 跳转重入保护：一次跳转未完成时忽略新的点击

async function jumpTo(context: Context, sessionID: string, clicked: TimelineNode, mask: MaskControl) {
  if (jumping) return
  jumping = true
  let masked = false
  try {
    let hosts = hostUsers(context, sessionID)
    if (!hosts.some((node) => node.id === clicked.id)) {
      // 上罩（含目标预览），加载阶段视图滚动全部被遮住。
      mask.show(truncate(clicked.summary, 34))
      masked = true
      const loaded = await ensureLoaded(context, sessionID, clicked.id)
      if (!loaded) {
        await mask.drop()
        masked = false
        context.ui.toast.show({ message: "这条消息没能加载出来", variant: "warning" })
        return
      }
      hosts = hostUsers(context, sessionID)
    }

    const index = hosts.findIndex((node) => node.id === clicked.id)
    if (index < 0) return
    const steps = hosts.slice(index + 1).filter(navigable).length
    const targets = hosts.filter(navigable)
    const landing = targets[Math.max(0, targets.length - 1 - steps)]
    if (!landing) {
      context.ui.toast.show({ message: "当前会话没有可定位的文本消息", variant: "warning" })
      return
    }
    let positioned = false
    try {
      context.keymap.dispatch("session.messages_last_user")

      if (masked) {
        // 首次分页后，data 中出现目标早于 createSessionRows 完成。last_user 会触发
        // ensureAllRows；等最终落点的 renderable 出现后，再让起点锚定回调走完两帧。
        const mounted = await waitForRenderable(context, landing.id)
        if (!mounted) {
          context.ui.toast.show({ message: "消息已加载，但会话行尚未准备好", variant: "warning" })
          return
        }
        await waitForFrames(2)
      }

      for (let i = 0; i < steps; i++) context.keymap.dispatch("session.message.user.previous")
      positioned = true
    } catch {
      context.ui.toast.show({ message: "当前版本不支持消息跳转", variant: "warning" })
    }
    if (masked && positioned) {
      // previous 链已在完整 renderable 集合上同步确定终点，再等两帧提交 scrollTo。
      await waitForFrames(2)
      await mask.drop()
      masked = false
    }
  } finally {
    if (masked) await mask.drop()
    jumping = false
  }
}

/** 固定配色：取自 everforest 主题定义（darkStep9 绿即 primary.dark）。 */
const COLORS = {
  text: "#d3c6aa", // darkStep12 — 正文
  muted: "#7a8478", // darkStep11 — 弱化（时间、普通节点）
  accent: "#a7c080", // darkStep9 — 强调绿（标题、选中、最新）
  border: "#475258", // darkStep5 — 分隔线
  background: "#2d353b", // darkStep1 — 遮盖层底色
}

type MaskState = { show: boolean; preview: string }

/** 全屏遮盖层：绝对定位 + 高 zIndex，盖在会话区上（不依赖 dialog，不会被宿主滚动命令清掉）。 */
function MaskVeil(props: { mask: MaskState }) {
  return (
    <Show when={props.mask.show}>
      <box
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        zIndex={999}
        backgroundColor={COLORS.background}
        justifyContent="center"
        alignItems="center"
      >
        <box border borderColor={COLORS.accent} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexDirection="column">
          <box flexDirection="row" gap={1}>
            <text fg={COLORS.accent}>{"◆"}</text>
            <text fg={COLORS.text}>{"正在定位消息…"}</text>
          </box>
          <text fg={COLORS.muted}>{props.mask.preview}</text>
        </box>
      </box>
    </Show>
  )
}

type PanelProps = {
  context: Context
  sessionID: string
  visibleRows: number
  scroll: boolean
  mask: MaskControl
}

/** 侧边栏面板：当前会话的用户消息节点列表（固定行高，剩余的可滚轮滚动）。 */
function UserNodesPanel(props: PanelProps) {
  // 节点池：id → 紧凑时间线节点。TUI 本地缓存只有"已加载窗口"（向上滚动才分页加载更早的），
  // 所以本地缓存负责实时增量，全量历史由 client.message.list 直接向服务端分页拉取。
  const [pool, setPool] = createSignal<Map<string, TimelineNode>>(new Map())
  // 初次打开时先不要把 TUI 的懒加载窗口直接画出来，避免 5 条本地缓存先闪现、
  // 服务端全量回来后又变成 10 条。全量请求失败时仍会揭示本地缓存作为兜底。
  const [initialReady, setInitialReady] = createSignal(false)
  const [selected, setSelected] = createSignal<string>("")
  let timelineScroll: { focus: () => void; blur: () => void } | undefined
  let prevLocalCount = 0 // 本地缓存中用户消息数：下降（undo）触发全量重拉
  let initialSessionID = ""

  // 滚轮事件可能命中外层 sidebar 的 scrollbox（尤其是原生 hit grid 暂时没有
  // 命中内部内容时会回退到当前 focus）。面板本身铺满可视宽度并捕获滚轮，
  // 进入面板时把 fallback focus 交给内部 scrollbox，离开时再还给宿主。
  function captureTimelineScroll(event: { stopPropagation: () => void }) {
    event.stopPropagation()
  }

  function focusTimelineScroll() {
    timelineScroll?.focus()
  }

  function blurTimelineScroll() {
    timelineScroll?.blur()
  }

  function finishInitialLoad(sessionID: string) {
    if (props.sessionID === sessionID && initialSessionID === sessionID) setInitialReady(true)
  }

  function mergeNodes(values: Iterable<TimelineNode>) {
    setPool((prev) => {
      let next: Map<string, TimelineNode> | undefined
      for (const node of values) {
        const existing = prev.get(node.id)
        if (existing && sameTimelineNode(existing, node)) continue
        next ??= new Map(prev)
        next.set(node.id, node)
      }
      return next ?? prev
    })
  }

  /** 合并本地缓存增量；新增走增量同步，undo 才请求权威全量历史。 */
  function mergeLocal(refetch: boolean) {
    let users: UserMessage[]
    try {
      const list = props.context.data.session.message.list(props.sessionID) ?? []
      users = list.filter(isUser)
    } catch {
      return // 本地缓存尚未就绪，等下一轮。
    }

    // untrack：本函数会在追踪 sessionID 的 createEffect 里执行；
    // 若不切断，"effect 内又读又写 pool" 会造成无限自触发（栈溢出）。
    const current = untrack(pool)
    let added = false
    let mutated = false
    const updates: TimelineNode[] = []
    for (const message of users) {
      const node = timelineNode(message)
      const existing = current.get(node.id)
      if (!existing) added = true
      else if (!sameTimelineNode(existing, node)) mutated = true
      else continue
      updates.push(node)
    }
    const dropped = users.length < prevLocalCount
    prevLocalCount = users.length

    if (added || mutated) mergeNodes(updates)
    if (!refetch) return
    if (dropped) scheduleFetch("all")
    else if (added) scheduleFetch("latest")
  }

  /**
   * 服务端分页约束（2.0.2 实测）：limit 上限 200；翻页时只能带 cursor 单独传
   * （cursor 内部已编码 order，重复带 order 参数会报 InvalidCursorError）。
   */
  async function fetchPage(sessionID: string, cursor?: string) {
    let response: Awaited<ReturnType<Context["client"]["message"]["list"]>>
    try {
      response = await props.context.client.message.list({
        sessionID,
        limit: 200,
        ...(cursor ? { cursor } : { order: "desc" as const }),
      })
    } catch {
      return undefined
    }
    return {
      data: response?.data ?? [],
      next: response?.cursor?.next ?? null,
    }
  }

  type FetchMode = "all" | "latest"
  let fetching: FetchMode | undefined
  let queued: FetchMode | undefined

  /** 同一面板只跑一条分页链；全量请求会覆盖排队中的增量请求。 */
  function scheduleFetch(mode: FetchMode) {
    if (fetching) {
      if (mode === "all" || !queued) queued = mode
      return
    }
    fetching = mode
    const task = mode === "all" ? doFetchAll() : doFetchLatest()
    void task
      .catch(() => undefined)
      .finally(() => {
        fetching = undefined
        const next = queued
        queued = undefined
        if (next) scheduleFetch(next)
      })
  }

  /**
   * 首次进入和 undo 时分页拉取完整历史；只有完整走到 cursor 尾端才权威替换，
   * 中途失败的部分结果只做合并，不能把已有早期节点截掉。
   * 实测约束（2.0.2）：limit 上限 200；翻页时只能带 cursor 单独传
   * （cursor 内部已编码 order，重复带 order 参数服务端直接报
   * InvalidCursorError："Cursor cannot be combined with order"）。
   * fresh === 0 与页数上限是双保险，cursor 语义未来再变也不会死循环。
   */
  async function doFetchAll() {
    const sessionID = props.sessionID
    const collected = new Map<string, TimelineNode>()
    const seen = new Set<string>() // 全部消息 id，用于检测分页没有推进
    let cursor: string | undefined
    let complete = false

    for (let pageIndex = 0; pageIndex < 40; pageIndex++) {
      const page = await fetchPage(sessionID, cursor)
      if (!page || props.sessionID !== sessionID) {
        if (props.sessionID === sessionID) {
          mergeLocal(false)
          finishInitialLoad(sessionID)
        }
        return
      }
      let fresh = 0
      for (const message of page.data) {
        if (seen.has(message.id)) continue
        seen.add(message.id)
        fresh++
        if (isUser(message)) collected.set(message.id, timelineNode(message))
      }
      if (!page.next) {
        complete = true
        break
      }
      if (fresh === 0) break
      cursor = page.next
    }

    if (props.sessionID !== sessionID) return
    if (complete) {
      setPool(new Map(collected))
      mergeLocal(false)
      finishInitialLoad(sessionID)
      return
    }
    if (collected.size > 0) mergeNodes(collected.values())
    finishInitialLoad(sessionID)
  }

  /** 新增消息只从最新页向后拉，遇到任意已知用户节点立即停止。 */
  async function doFetchLatest() {
    const sessionID = props.sessionID
    const known = new Set(untrack(pool).keys())
    if (known.size === 0) {
      await doFetchAll()
      return
    }

    const collected = new Map<string, TimelineNode>()
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < 40; pageIndex++) {
      const page = await fetchPage(sessionID, cursor)
      if (!page || props.sessionID !== sessionID) return
      let fresh = 0
      let overlap = false
      for (const message of page.data) {
        if (seen.has(message.id)) continue
        seen.add(message.id)
        fresh++
        if (!isUser(message)) continue
        if (known.has(message.id)) overlap = true
        else collected.set(message.id, timelineNode(message))
      }
      if (overlap || !page.next || fresh === 0) break
      cursor = page.next
    }
    if (props.sessionID === sessionID && collected.size > 0) mergeNodes(collected.values())
  }

  // 切换会话（sessionID 变化）时重新拉取并清空选中态。
  // 体内除 sessionID 外一律 untrack：hostUsers/mergeLocal 会读宿主响应式数据库，
  // 不切断订阅的话流式期间 effect 会被消息更新反复触发（重挂载刷屏）。
  createEffect(() => {
    props.sessionID
    untrack(() => {
      initialSessionID = props.sessionID
      setInitialReady(false)
      setSelected("")
      prevLocalCount = 0
      setPool(new Map())
      mergeLocal(false)
      scheduleFetch("all")
    })
  })

  // 服务端事件驱动刷新：只有用户消息集合变化才会触发服务端同步；
  // 新增只拉到首个已知节点，undo 才全量重建。
  const stopListen = props.context.data.listen(({ details }) => {
    const type = (details as { type?: unknown } | undefined)?.type
    if (typeof type !== "string") return
    if (!type.startsWith("message") && !type.startsWith("session")) return
    mergeLocal(true)
  })

  // 事件监听为主，20 秒低频轮询只负责最终一致性兜底。
  const poll = setInterval(() => mergeLocal(true), 20_000)

  onCleanup(() => {
    stopListen()
    clearInterval(poll)
  })

  const nodes = createMemo(() => [...pool().values()].sort((a, b) => a.created - b.created))
  const readyNodes = createMemo(() => (initialReady() ? nodes() : []))
  const groups = createMemo(() => groupNodes(readyNodes()))
  // 滚动模式显示全部；静态回退只显示最新 N 条消息，并保留日期标题。
  const shownGroups = createMemo(() => (props.scroll ? groups() : latestGroups(groups(), props.visibleRows)))

  /** 单个节点行（滚动 / 静态两种容器共用）。 */
  function NodeRow(propsRow: { node: TimelineNode }) {
    const active = createMemo(() => selected() === propsRow.node.id)
    return (
      <box
        flexDirection="row"
        gap={1}
        onMouseUp={() => {
          setSelected(propsRow.node.id)
          void jumpTo(props.context, props.sessionID, propsRow.node, props.mask)
        }}
      >
        <text fg={COLORS.muted}>{formatTime(propsRow.node.created)}</text>
        <text fg={active() ? COLORS.accent : COLORS.muted}>{active() ? "●" : "─"}</text>
        <text fg={active() ? COLORS.accent : COLORS.text}>
          {truncate(propsRow.node.summary, 26)}
        </text>
      </box>
    )
  }

  function DateGroup(propsGroup: { group: TimelineGroup }) {
    return (
      <box flexDirection="column">
        <text fg={COLORS.accent}>{`── ${propsGroup.group.label} ──`}</text>
        <For each={propsGroup.group.nodes}>{(node) => <NodeRow node={node} />}</For>
      </box>
    )
  }

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      alignSelf="stretch"
      width="100%"
      zIndex={1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      onMouseScroll={captureTimelineScroll}
      onMouseOver={focusTimelineScroll}
      onMouseOut={blurTimelineScroll}
      onMouseDown={focusTimelineScroll}
    >
      <box flexDirection="row" gap={1}>
        <text fg={COLORS.accent}>{"◆ 用户节点"}</text>
        <text fg={COLORS.muted}>{initialReady() ? `(${readyNodes().length})` : "(加载中…)"}</text>
      </box>
      <text fg={COLORS.border}>{"─".repeat(16)}</text>
      <Show when={initialReady()} fallback={<text fg={COLORS.muted}>{"正在加载用户消息…"}</text>}>
        <Show when={readyNodes().length > 0} fallback={<text fg={COLORS.muted}>{"暂无用户消息"}</text>}>
        <Show
          when={props.scroll}
          fallback={<For each={shownGroups()}>{(group) => <DateGroup group={group} />}</For>}
        >
          {/* 固定可视行数，剩余全部滚轮滚动；stickyScroll 保证新消息进来时保持在底部 */}
          <scrollbox
            ref={(scroll) => {
              timelineScroll = scroll
            }}
            height={props.visibleRows}
            width="100%"
            alignSelf="stretch"
            stickyScroll
            stickyStart="bottom"
            // 嵌套在宿主侧边栏滚动容器中；无论事件命中行、content 还是
            // scrollbox 本身，都在这里截断冒泡，避免外层跟着滚动。
            onMouseScroll={captureTimelineScroll}
            verticalScrollbarOptions={{ visible: false }}
          >
            <box flexDirection="column" width="100%">
              <For each={shownGroups()}>{(group) => <DateGroup group={group} />}</For>
            </box>
          </scrollbox>
        </Show>
        </Show>
      </Show>
    </box>
  )
}

type KeybindsProps = {
  context: Context
  settings: Settings
  update: (mutation: (draft: Settings) => void) => Promise<void>
}

/** 不可见的宿主组件：注册命令与快捷键。 */
function Keybinds(props: KeybindsProps) {
  props.context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      {
        id: COMMAND_ID,
        title: "切换用户消息节点面板",
        description: "在会话侧边栏显示/隐藏用户消息节点列表",
        group: "User Nodes",
        bind: "alt+u",
        palette: true,
        slash: { name: "nodes" },
        run: async () => {
          await props.update((draft) => {
            draft.visible = !draft.visible
          })
          props.context.ui.toast.show({
            message: props.settings.visible ? "用户节点面板：已显示" : "用户节点面板：已隐藏",
          })
        },
      },
    ],
    bindings: [COMMAND_ID],
  }))

  return <></>
}

export default Plugin.define({
  id: "opencode-user-timeline",
  setup(context) {
    const visibleRows = typeof context.options.visibleRows === "number" && context.options.visibleRows > 0
      ? Math.floor(context.options.visibleRows)
      : 10
    // scroll: false 可关闭滚轮滚动区（退回静态最新 N 行）——
    // scrollbox 经过原生渲染核心，个别 beta 版本上可能不稳定，留一个不动代码的退路。
    const scroll = context.options.scroll !== false

    const [settings, updateSettings] = context.storage.store("settings", {
      initial: { visible: true } satisfies Settings,
    })

    // 遮盖层状态（内存态，重启即弃），配合 app 级 slot 渲染全屏定位遮罩。
    const [mask, setMask] = context.storage.memory("mask", {
      initial: { show: false, preview: "" } as MaskState,
    })
    let maskShownAt = 0
    const maskControl: MaskControl = {
      show(preview) {
        maskShownAt = Date.now()
        setMask((draft) => {
          draft.show = true
          draft.preview = preview
        })
      },
      async drop() {
        if (!mask.show) return
        // 最短显示 800ms：加载太快时视觉上也是"有内容的定位中"，而不是残影。
        const remain = 800 - (Date.now() - maskShownAt)
        if (remain > 0) await sleep(remain)
        setMask((draft) => {
          draft.show = false
        })
      },
    }

    const unbind = context.ui.slot({
      append: "app",
      render: () => (
        <>
          <Keybinds context={context} settings={settings} update={updateSettings} />
          <MaskVeil mask={mask} />
        </>
      ),
    })

    const unpick = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => (
        <Show when={settings.visible && typeof sessionID === "string" && sessionID.length > 0}>
          <UserNodesPanel context={context} sessionID={sessionID} visibleRows={visibleRows} scroll={scroll} mask={maskControl} />
        </Show>
      ),
    })

    return () => {
      unbind()
      unpick()
    }
  },
})
