/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { SessionMessageInfo } from "@opencode/client"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { appendFileSync } from "node:fs"
import {
  displayWidth,
  formatDate,
  formatTime,
  dateKey,
  groupNodes,
  latestGroups,
  navigable,
  sameTimelineNode,
  timelineNode,
  truncate,
  type TimelineGroup,
  type TimelineNode,
} from "./timeline.js"

// 性能埋点：全部受 FOOTPRINTS_PERF=1 控制，发布版默认一行都不写。
//
// 曾经的方案是「跳转无条件写、检测受开关控制」，理由是跳转低频。但发布版会
// 往用户机器上写文件这件事本身就不该默认发生，所以统一收在开关后面。
//
// 本地排查：
//   $env:FOOTPRINTS_PERF=1 ; opencode
const PERF_LOG = "C:/WINDOWS/TEMP/opencode/footprints-perf.log"
const PERF_ENABLED = process.env.FOOTPRINTS_PERF === "1"

function perfNote(line: string) {
  if (!PERF_ENABLED) return
  try {
    appendFileSync(PERF_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 埋点失败不影响功能 */
  }
}

const COMMAND_ID = "footprints.toggle"

type Settings = { visible: boolean; scrollStep: number }

/** 可选步长：1（最细）到 5（最快） */
const SCROLL_STEPS = [1, 2, 3, 5] as const
const DEFAULT_STEP = 2

/** 一条用户消息节点（SessionMessageInfo 联合类型中的 user 变体）。 */
type UserMessage = Extract<SessionMessageInfo, { type: "user" }>

/** 类型守卫：只关心 type === "user" 的消息。 */
function isUser(message: SessionMessageInfo): message is UserMessage {
  return message.type === "user"
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
  /** 2.0.10 起接受可选 options：{ all: true } 单次拉全量，旧宿主忽略该参数（单次一页）。 */
  loadMore?(sessionID: string, options?: { all?: boolean }): Promise<unknown>
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

  // v2 当前把底层分页对象原样交给插件，只是公开类型暂未列出这三个方法（2.0.10 仍如此）。
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
        // 2.0.10：{ all: true } 由宿主在单次调用内循环翻页到 cursor 尽头（每页 200），
        // 目标在很老的历史里时一次调用即可到位；旧宿主忽略该参数，仍按单页循环。
        await loadMore(sessionID, { all: true })
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
  show(preview: string, label?: string): void
  drop(): Promise<void>
}

/**
 * 跨会话共享的宿主状态。
 *
 * 收敛在一个对象里，是因为它们必须在「切会话」和「组件卸载」两个时机同时重置。
 * 之前散成 7 个 let，切会话时漏掉 lastSeenOffset 就导致检测永久短路——
 * offset 恰好等于旧值 → 每轮直接 return → 跟随、跳转、选中全部失灵。
 *
 * 新增状态只往这个对象里加，resetHostState() 自动覆盖，不会再漏。
 */
const host = {
  /** 宿主的会话区滚动容器，按 scrollHeight 认定后缓存 */
  scroll: undefined as any,
  /** 当前节点检测的缓存键、节点引用与结果 */
  detectKey: "",
  detectNodes: undefined as TimelineNode[] | undefined,
  detectResult: { atBottom: false } as { id?: string; atBottom: boolean },
  /** 上一次检测时的宿主 scrollTop。位置没变就不更新选中，这样点击后的选择能站住 */
  seenOffset: -1,
  /** 跳转重入保护：一次跳转未完成时忽略新的点击 */
  jumping: false,
  /** 跳转期间及结束后一小段时间内，暂停「当前节点」自动检测 */
  jumpingUntil: 0,
}

function resetHostState() {
  host.scroll = undefined
  host.detectKey = ""
  host.detectNodes = undefined
  host.detectResult = { atBottom: false }
  host.seenOffset = -1
  host.jumping = false
  host.jumpingUntil = 0
}

/**
 * 点击跳转：dispatch 宿主自带的导航命令。
 * 先跳到最后一个可定位的用户消息，再按“目标之后还有几条可定位消息”往回走 N 步。
 *
 * 关键：步数必须用宿主当前缓存里的消息列表计算——宿主导航只在这个集合里移动，
 * 用插件的全量列表（服务端历史）会因两边时间差导致光标落偏。
 */

/**
 * 快速路径：目标行已经挂在渲染树里时，直接把它滚到视口顶部，一次布局到位。
 *
 * 宿主内部的 jumpToMessage 就是这么做的（scroll.scrollTop + child.y - viewport.y），
 * 但它没暴露给插件。这里用同样的算法绕过去。
 *
 * 返回 false 表示这条消息还没渲染（窗口外的消息没有节点），调用方必须回退到
 * 逐条 dispatch——那是唯一能触发宿主向上分页的方式。
 */
function scrollToMessageDirectly(context: Context, id: string): boolean {
  try {
    const root = (context.renderer as any)?.root
    if (typeof root?.findDescendantById !== "function") return false
    const target = root.findDescendantById(id)
    if (!target) return false

    // 从目标行往上找第一个能滚的祖先
    let scroll: any = target.parent
    for (let i = 0; i < 24 && scroll; i++) {
      if (typeof scroll.scrollTo === "function" && typeof scroll.scrollTop === "number") break
      scroll = scroll.parent
    }
    if (!scroll || typeof scroll.scrollTo !== "function") return false

    const viewport = scroll.viewport ?? scroll
    const targetY = typeof target.y === "number" ? target.y : target.screenY
    const viewY = typeof viewport.y === "number" ? viewport.y : 0
    if (typeof targetY !== "number" || !Number.isFinite(targetY)) return false

    const next = scroll.scrollTop + targetY - viewY - 1
    if (!Number.isFinite(next)) return false
    scroll.scrollTo(Math.max(0, next))
    return true
  } catch {
    return false
  }
}

async function jumpTo(context: Context, sessionID: string, clicked: TimelineNode, mask: MaskControl) {
  if (host.jumping) return
  host.jumping = true
  const jumpStart = performance.now()

  // 快速路径优先：目标在窗口内时几毫秒到位，不用走逐条 dispatch（每步 180ms）。
  // 短抑制即可——这里没有逐条布局过程，位置一次就落定。
  if (scrollToMessageDirectly(context, clicked.id)) {
    perfNote(`jump: fast path, ${(performance.now() - jumpStart).toFixed(1)}ms, id=${clicked.id.slice(0, 12)}`)
    host.jumpingUntil = Date.now() + 300
    host.jumping = false
    return
  }

  host.jumpingUntil = Date.now() + 30_000 // 慢路径：逐条 dispatch 期间全程抑制
  let masked = false
  try {
    let hosts = hostUsers(context, sessionID)
    const needLoad = !hosts.some((node) => node.id === clicked.id)
    perfNote(`jump: slow path, hostNodes=${hosts.length}, targetPresent=${!needLoad}`)
    if (needLoad) {
      // 上罩（含目标预览），加载阶段视图滚动全部被遮住。
      mask.show(truncate(clicked.summary, 34), "正在加载较早的消息…")
      masked = true
      await nextFrame() // 同上：先让遮罩画出来，再开始可能阻塞的加载
      const loaded = await ensureLoaded(context, sessionID, clicked.id)
      perfNote(`jump: ensureLoaded=${loaded}, +${(performance.now() - jumpStart).toFixed(0)}ms`)
      if (!loaded) {
        await mask.drop()
        masked = false
        context.ui.toast.show({ message: "这条消息没能加载出来", variant: "warning" })
        return
      }
      hosts = hostUsers(context, sessionID)
      perfNote(`jump: after ensure, hostNodes=${hosts.length}, +${(performance.now() - jumpStart).toFixed(0)}ms`)
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

    // 每步 dispatch 约 180ms（宿主每次都要重新布局整个消息列表，插件侧改不掉）。
    // 步数一多，用户就会盯着僵住的界面一两秒，不知道它在动。
    // 预估超过 600ms 就提前把过程盖住；2 步以内约 220ms，上遮罩反而闪一下更烦。
    // 600ms 这个门槛配合遮罩 800ms 的最短显示，不会把短跳转拖长。
    const estimatedCost = steps * 180
    if (!masked && estimatedCost > 600) {
      mask.show(truncate(clicked.summary, 34), "正在跳转…")
      masked = true
      // 让遮罩真正画出来再开始 dispatch。不这一帧的话，紧接着的同步 dispatch
      // 会把主线程占住，遮罩被压到跳转快结束时才出现，看起来就是闪一下。
      await nextFrame()
      perfNote(`jump: mask up, steps=${steps}, estimated=${estimatedCost}ms`)
    }
    let positioned = false
    try {
      perfNote(`jump: steps=${steps}, dispatching last_user, +${(performance.now() - jumpStart).toFixed(0)}ms`)
      context.keymap.dispatch("session.messages_last_user")
      perfNote(`jump: last_user done, +${(performance.now() - jumpStart).toFixed(0)}ms`)

      if (masked) {
        // 首次分页后，data 中出现目标早于 createSessionRows 完成。last_user 会触发
        // ensureAllRows；等最终落点的 renderable 出现后再继续。
        //
        // 这里原本还有一次 waitForFrames(2)，实测在宿主刚做完全量布局时会被排到
        // 1.2 秒之后才执行——等两帧变成等一点二秒，纯属浪费，已去掉。
        const mounted = await waitForRenderable(context, landing.id)
        perfNote(`jump: waitForRenderable=${mounted}, +${(performance.now() - jumpStart).toFixed(0)}ms`)
        if (!mounted) {
          context.ui.toast.show({ message: "消息已加载，但会话行尚未准备好", variant: "warning" })
          return
        }
      }

      // 逐条 dispatch 是宿主唯一支持的跳转方式。
      //
      // 短距离（几 步）如果连续跑完，宿主会连续重渲染几次而不释放主线程，
      // 看起来就是「卡一下」。所以几步之内每一步都让一帧，让渲染均匀铺开。
      // 长距离（上百步）如果每步都让帧会拖到一两秒，退化成每 8 步一次。
      const frameEvery = steps <= 8 ? 1 : 8
      for (let i = 0; i < steps; i++) {
        context.keymap.dispatch("session.message.user.previous")
        if ((i + 1) % frameEvery === 0) await nextFrame()
      }
      positioned = true
      perfNote(`jump: loop done, +${(performance.now() - jumpStart).toFixed(0)}ms`)
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
    perfNote(`jump: total ${(performance.now() - jumpStart).toFixed(0)}ms`)
    host.jumping = false
    // 跳转结束后宿主可能还在异步滚动，再给 800ms 让位置稳定
    host.jumpingUntil = Date.now() + 800
  }
}

/** 固定配色：琥珀强调 + 冷白正文。 */
const COLORS = {
  text: "#ece3d4", // 正文：暖白（米白）
  muted: "#9a9088", // 次要：时间、计数、跨度
  accent: "#e0a458", // 强调：标题、选中点、滚动条、日期标题
  soft: "#8a7d6a", // 悬停摘要：暖灰棕，与琥珀/暖灰同源
  border: "#4a4238", // 分隔线：暖灰
  background: "#2a2622", // 遮罩：暖深灰
}

type MaskState = { show: boolean; preview: string; label: string }

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
            <text fg={COLORS.text}>{props.mask.label || "正在定位消息…"}</text>
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
  scrollStep: number
  mask: MaskControl
}

/**
 * 反查"会话视口顶部当前属于哪条用户消息"。
 * 用渲染坐标：取 screenY 在视口顶部之上（含）的最后一条。
 * 不能用行号累加——会话区里 assistant 回复占的行数不一样，
 * scrollHeight 是渲染行数，不是消息条数。
 */
// 宿主会话区 scrollbox 的缓存：避免每 150ms 都遍历整棵渲染树
// 上一次检测的 key（scrollTop + 节点版本）与结果，没变化就直接复用
// 缓存还要比对节点数组的引用：pool 全量替换时中段节点可能增删，
// 而 offset/length/lastId 三者都可能不变，只靠 key 会返回已经失效的 id。

/** 收集某个渲染节点的所有祖先（时间线面板就挂在侧边栏里，侧边栏容器不能被当成会话区）。 */
function ancestorSet(node: any): Set<any> {
  const out = new Set<any>()
  let cur = node?.parent ?? null
  let guard = 0
  while (cur && guard++ < 64) {
    out.add(cur)
    cur = cur.parent ?? null
  }
  return out
}

/** 子树里是否包含目标节点（parent 链不可用时的兜底判据）。 */
function containsNode(node: any, target: any, depth = 0): boolean {
  if (!node || depth > 24) return false
  if (node === target) return true
  const kids = typeof node.getChildren === "function" ? node.getChildren() : []
  for (const kid of kids) {
    if (containsNode(kid, target, depth + 1)) return true
  }
  return false
}

/** 找到宿主的会话区滚动容器（内容最高的滚动区，排除时间线自己及其祖先）。 */
function getHostScroll(context: Context, exclude?: unknown) {
  const blocked = exclude ? ancestorSet(exclude) : new Set<any>()
  if (exclude) blocked.add(exclude)
  if (
    host.scroll &&
    !blocked.has(host.scroll) &&
    typeof host.scroll.scrollTop === "number" &&
    (host.scroll.scrollHeight ?? 0) > 0
  ) {
    return host.scroll
  }
  try {
    const root = (context.renderer as any)?.root
    if (!root) return undefined
    const boxes: any[] = []
    const walk = (node: any, depth: number) => {
      if (!node || depth > 24) return
      if (
        typeof node.scrollTop === "number" &&
        typeof node.scrollHeight === "number" &&
        node.scrollHeight > 0
      ) {
        boxes.push(node)
      }
      const kids = typeof node.getChildren === "function" ? node.getChildren() : []
      for (const kid of kids) walk(kid, depth + 1)
    }
    walk(root, 0)
    const found = boxes
      .filter((box) => !blocked.has(box) && !(exclude && containsNode(box, exclude)))
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    host.scroll = found
    return found
  } catch {
    host.scroll = undefined
    return undefined
  }
}

/**
 * 一次遍历宿主会话区，收集「消息 id → screenY」。
 *
 * 替代对每条消息调用 root.findDescendantById 的写法：后者每次都是整树递归，
 * 220 条消息就是 220 次全树遍历，实测单次检测 380ms。
 *
 * 从 scroll 子树开始走而不是从 root，顺带排除了时间线自己的节点——
 * 时间线也挂了 id，全局查找会撞名。
 *
 * 同一个 id 出现多次时保留最先遇到的那个，和 findDescendantById 的深度优先顺序一致。
 */
function snapshotPositions(scroll: any): Map<string, number> {
  const positions = new Map<string, number>()
  const walk = (node: any, depth: number) => {
    if (!node || depth > 20) return
    const id = node.id
    if (typeof id === "string" && id.length > 0 && !positions.has(id)) {
      positions.set(id, typeof node.screenY === "number" ? node.screenY : 0)
    }
    const kids = typeof node.getChildren === "function" ? node.getChildren() : []
    for (const kid of kids) walk(kid, depth + 1)
  }
  walk(scroll, 0)
  return positions
}

function detectCurrentNode(
  context: Context,
  nodes: TimelineNode[],
  exclude?: unknown,
): { id?: string; atBottom: boolean } {
  try {
    const scroll = getHostScroll(context, exclude)
    if (!scroll) return { atBottom: false }

    const offset = scroll.scrollTop ?? 0
    const lastId = nodes[nodes.length - 1]?.id ?? ""
    const key = `${offset}|${nodes.length}|${lastId}`
    if (key === host.detectKey && nodes === host.detectNodes) return host.detectResult

    const viewport = scroll.viewport ?? scroll
    const top = viewport.screenY ?? 0
    const view = viewport.height ?? 0
    const total = scroll.scrollHeight ?? 0

    let result: { id?: string; atBottom: boolean }

    // 严格贴底（剩余可滚不足半行）→ 直接算最新那条
    if (view > 0 && total > view && offset >= total - view - 0.5) {
      result = { id: nodes[nodes.length - 1]?.id, atBottom: true }
    } else {
      // 视口顶部之上（含）的最后一条；滚到最顶上时退回第一条
      //
      // 这里必须一次遍历建位置表，不能对每条消息调 findDescendantById：
      // 后者每次都是从根节点整树递归，220 条消息就是 220 次全树遍历，
      // 实测单次检测 380ms，而 follow 每 150ms 就跑一次，界面会被完全占住。
      //
      // 从 scroll（宿主会话区）子树开始走，顺带排除了时间线自己的节点——
      // 时间线也挂了 id，从 root 全局查找会撞名。
      const positions = snapshotPositions(scroll)
      let best: string | undefined
      for (const node of nodes) {
        const y = positions.get(node.id)
        if (y === undefined) continue
        if (y <= top + 1) best = node.id
        else break
      }
      result = { id: best, atBottom: false }
    }

    host.detectKey = key
    host.detectResult = result
    host.detectNodes = nodes
    return result
  } catch {
    return { atBottom: false }
  }
}

/**
 * 悬停浮层：按固定宽度折行，最多 4 行，超出部分用省略号。
 * 侧边栏一行放不下多少字，所以用浮层而不是挤在分隔线里。
 */
function wrapSummary(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < text.length && lines.length < maxLines; i += width) {
    lines.push(text.slice(i, i + width))
  }
  if (text.length > width * maxLines && lines.length === maxLines) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, Math.max(0, width - 1)) + "…"
  }
  return lines
}

/** 把毫秒跨度格式化成「3 天 8 小时」这种。 */
function formatSpan(ms: number): string {
  const minute = Math.floor(ms / 60_000)
  if (minute < 1) return "不到 1 分钟"
  if (minute < 60) return `${minute} 分钟`
  const hour = Math.floor(minute / 60)
  if (hour < 24) return `${hour} 小时 ${minute % 60} 分`
  const day = Math.floor(hour / 24)
  return `${day} 天 ${hour % 24} 小时`
}

/** 侧边栏面板「足迹」：当前会话的用户消息节点列表（固定行高，剩余的可滚轮滚动）。 */
function UserNodesPanel(props: PanelProps) {
  // 节点池：id → 紧凑时间线节点。TUI 本地缓存只有"已加载窗口"（向上滚动才分页加载更早的），
  // 所以本地缓存负责实时增量，全量历史由 client.message.list 直接向服务端分页拉取。
  const [pool, setPool] = createSignal<Map<string, TimelineNode>>(new Map())
  // 初次打开时先不要把 TUI 的懒加载窗口直接画出来，避免 5 条本地缓存先闪现、
  // 服务端全量回来后又变成 10 条。全量请求失败时仍会揭示本地缓存作为兜底。
  const [initialReady, setInitialReady] = createSignal(false)
  const [selected, setSelected] = createSignal<string>("")
  // 日期跳转游标：-1 = 跟随最后一天，非负 = 用户选定的分组索引
  const [dayIndex, setDayIndex] = createSignal(-1)
  // 用户手动滚时间线后 3 秒内，不要被"宿主贴底"逻辑拉回最新
  let manualScrollUntil = 0
  // 宿主是否处于贴底状态：只在"由否变是"的那一刻联动一次，
  // 否则切日期后会被持续条件反复拉回最新，日期切换失效。
  let wasAtBottom = false
  // 鼠标悬停的节点：在标题下方那几行显示完整摘要（列表里只截断到 26 字符）
  const [hovered, setHovered] = createSignal<TimelineNode | undefined>(undefined)
  let hoverClear: ReturnType<typeof setTimeout> | undefined
  // 自绘滚动条状态（内置滑块是整块字符，太粗；这里用 ASCII | 画）
  const [bar, setBar] = createSignal({ top: 0, size: 0, visible: false })
  // 自绘滚动条状态已移除；内置滚动条改为同色 + 1 列宽
  let timelineScroll: { focus: () => void; blur: () => void } | undefined
  let prevLocalCount = 0 // 本地缓存中用户消息数：下降（undo）触发全量重拉
  let initialSessionID = ""

  // 滚轮事件可能命中外层 sidebar 的 scrollbox（尤其是原生 hit grid 暂时没有
  // 命中内部内容时会回退到当前 focus）。面板本身铺满可视宽度并捕获滚轮，
  // 进入面板时把 fallback focus 交给内部 scrollbox，离开时再还给宿主。
  function captureTimelineScroll(event: { stopPropagation: () => void }) {
    event.stopPropagation()
    // 用户手动滚动时间线：3 秒内不要被"宿主贴底"逻辑拉回最新
    manualScrollUntil = Date.now() + 3000
    // 滚轮到达时立即重算滚动条位置，不等 50ms 定时器
    updateBar()
    setTimeout(updateBar, 0)
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
   * 服务端分页约束（2.0.2 → 2.0.10 均如此）：limit 上限 200；翻页时只能带 cursor 单独传
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
   * 实测约束（2.0.2 → 2.0.10）：limit 上限 200；翻页时只能带 cursor 单独传
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
      // 跨会话的模块级缓存必须清空：宿主的 scrollbox 会重建，
      // 旧缓存的 scrollTop 若恰好和新会话相同，会让检测永久短路。
      resetHostState()
      manualScrollUntil = 0
      wasAtBottom = false

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

  // 跟随宿主视口：反查当前显示的是哪条用户消息，实时更新选中。
  // 点击跳转期间暂停，避免自动检测把刚选中的节点又冲掉。
  /** 把时间线滚到指定节点（日期标题 1 行 + 每条节点 1 行累加出行号）。 */
  function revealNode(id: string) {
    if (Date.now() < manualScrollUntil) return
    const groupsNow = groups()
    let line = 0
    for (const group of groupsNow) {
      line += 1
      for (const node of group.nodes) {
        if (node.id === id) {
          const scroll = timelineScroll as any
          if (typeof scroll?.scrollTo === "function") scroll.scrollTo(Math.max(0, line - 1))
          return
        }
        line += 1
      }
    }
  }

  const follow = setInterval(() => {
    if (Date.now() < host.jumpingUntil) return

    // 选中的节点被移出列表（pool 全量替换、分页窗口变化）时，
    // 清掉这个幽灵选中并强制下一轮重新判定，否则绿点会一直消失。
    const currentSelected = selected()
    if (currentSelected && !pool().has(currentSelected)) {
      setSelected("")
      host.seenOffset = -1
    }

    // 只在宿主滚动位置真的变化时才重新判定"当前节点"。
    // 位置没变 → 保持现状（点击跳转后的选择不会被自动检测覆盖）。
    const scroll = getHostScroll(props.context, timelineScroll) as any
    const offset = typeof scroll?.scrollTop === "number" ? scroll.scrollTop : -1
    if (offset === host.seenOffset) return
    host.seenOffset = offset

    const detectStart = performance.now()
    const found = detectCurrentNode(props.context, readyNodes(), timelineScroll)
    // TEMP perf probe：正常一次遍历约 30ms，只有明显异常时才记录，
    // 否则每次滚动都写一行，日志会一直长。
    const detectCost = performance.now() - detectStart
    if (detectCost > 60) {
      perfNote(`detect ${detectCost.toFixed(1)}ms nodes=${readyNodes().length} offset=${offset}`)
    }
    if (found.id && found.id !== selected()) {
      setSelected(found.id)
      // 让时间线也跟着滚到当前节点，否则绿点会跑出可视范围，看起来像"消失"
      revealNode(found.id)
    }
    // 宿主贴底（比如点了 jump to latest）：时间线也回到最新。
    // 只在"由非贴底变成贴底"那一下联动，之后不再干预用户操作。
    if (found.atBottom) {
      if (!wasAtBottom && Date.now() >= manualScrollUntil) {
        const s = timelineScroll as any
        if (s && typeof s.scrollTop === "number" && typeof s.scrollHeight === "number") {
          if (s.scrollTop + panelHeight() < s.scrollHeight - 1) s.scrollTo(s.scrollHeight)
        }
      }
      wasAtBottom = true
    } else {
      wasAtBottom = false
    }
  }, 150)

  // 自绘滚动条：按 scrollTop / scrollHeight 算滑块位置与长度
  function updateBar() {
    const scroll = timelineScroll as any
    if (!scroll || typeof scroll.scrollTop !== "number" || typeof scroll.scrollHeight !== "number") return
    const view = panelHeight()
    const total = scroll.scrollHeight
    if (total > view) {
      const size = Math.max(1, Math.round((view * view) / total))
      const maxTop = Math.max(0, view - size)
      const range = Math.max(1, total - view)
      const top = Math.min(maxTop, Math.max(0, Math.round((scroll.scrollTop / range) * maxTop)))
      const prev = bar()
      if (prev.top !== top || prev.size !== size || !prev.visible) setBar({ top, size, visible: true })
    } else if (bar().visible) {
      setBar({ top: 0, size: 0, visible: false })
    }
  }
  // 滚轮事件里立即刷新（不等定时器），50ms 轮询只做键盘翻页/程序滚动的兜底
  const syncBar = setInterval(updateBar, 50)

  onCleanup(() => {
    stopListen()
    clearInterval(poll)
    clearInterval(follow)
    clearInterval(syncBar)
    // 组件卸载时同样清空跨会话状态，避免重开面板后命中旧缓存
    resetHostState()
  })

  const nodes = createMemo(() => [...pool().values()].sort((a, b) => a.created - b.created))
  const readyNodes = createMemo(() => (initialReady() ? nodes() : []))
  const groups = createMemo(() => groupNodes(readyNodes()))
  // 当前日期游标（-1 表示跟随最新一天）
  const dayCursor = createMemo(() => {
    const gs = groups()
    if (gs.length === 0) return -1
    return dayIndex() < 0 ? gs.length - 1 : Math.min(Math.max(0, dayIndex()), gs.length - 1)
  })

  /** 按天切换：把时间线滚到那一天的第一条，并选中它。 */
  function jumpToDay(delta: number) {
    const gs = groups()
    if (gs.length === 0) return
    const cur = dayCursor()
    const next = Math.min(gs.length - 1, Math.max(0, cur + delta))
    if (next === cur) return
    setDayIndex(next)
    const target = gs[next]?.nodes[0]
    if (!target) return
    setSelected(target.id)
    // 切日期是用户的主动操作，3 秒内不要被"宿主贴底联动"拉回最新
    manualScrollUntil = Date.now() + 3000
    // scrollChildIntoView 只查直接子级，节点嵌在 box/DateGroup 里找不到，
    // 所以按"日期标题 1 行 + 每条节点 1 行"累加出行号，直接 scrollTo。
    let offset = 0
    for (let i = 0; i < next; i++) offset += 1 + gs[i].nodes.length
    const scroll = timelineScroll as any
    if (typeof scroll?.scrollTo === "function") scroll.scrollTo(offset)
  }
  // 滚动模式显示全部；静态回退只显示最新 N 条消息，并保留日期标题。
  const shownGroups = createMemo(() => (props.scroll ? groups() : latestGroups(groups(), props.visibleRows)))
  // 面板高度自适应：消息少时按实际行数收缩，避免大片空旷（每条节点 1 行 + 每个日期标题 1 行）
  const panelHeight = createMemo(() => {
    const total = groups().reduce((n, g) => n + 1 + g.nodes.length, 0)
    return Math.max(1, Math.min(props.visibleRows, total))
  })

  /** 单个节点行（滚动 / 静态两种容器共用）。 */
  function NodeRow(propsRow: { node: TimelineNode }) {
    const active = createMemo(() => selected() === propsRow.node.id)
    return (
      <box
        flexDirection="row"
        gap={1}
        onMouseUp={() => {
          const id = propsRow.node.id
          setSelected(id)
          // 跳转期间暂停自动跟随，跳完再交还
          host.jumpingUntil = Date.now() + 1500
          void jumpTo(props.context, props.sessionID, propsRow.node, props.mask).then(() => {
            // 跳转落地：把当前位置记为"已见过"，下一轮检测不会覆盖这次选中
            const scroll = getHostScroll(props.context, timelineScroll) as any
            host.seenOffset = typeof scroll?.scrollTop === "number" ? scroll.scrollTop : -1
            host.jumpingUntil = Date.now() + 300
          })
        }}
        onMouseOver={() => {
          clearTimeout(hoverClear)
          setHovered(propsRow.node)
        }}
        onMouseOut={() => {
          // 悬停会撑高上方区域、把列表往下推，鼠标可能瞬间移出；延迟清除防抖
          hoverClear = setTimeout(() => setHovered(undefined), 250)
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
      onMouseScroll={captureTimelineScroll}
      onMouseOver={focusTimelineScroll}
      onMouseOut={blurTimelineScroll}
      onMouseDown={focusTimelineScroll}
    >
      <box flexDirection="row" gap={1}>
        <text fg={COLORS.accent}>{"◆ 足迹"}</text>
        <text fg={COLORS.muted}>{initialReady() ? `(${readyNodes().length})` : "(加载中…)"}</text>
      </box>
      {/* 固定占 2 行：不悬停时显示跨度 + 日期切换，悬停时整块换成摘要 */}
      <Show
        when={hovered()}
        fallback={
          <box flexDirection="column" height={2}>
            <text fg={COLORS.muted} height={1} overflow="hidden">
              {(() => {
                const list = readyNodes()
                if (list.length === 0) return ""
                if (list.length === 1) return "单条消息"
                const ms = list[list.length - 1].created - list[0].created
                return `跨度 ${formatSpan(ms)}`
              })()}
            </text>
            <box flexDirection="row" gap={1} height={1}>
              <text fg={COLORS.muted} onMouseUp={() => jumpToDay(-1)}>
                {"◀"}
              </text>
              <text fg={COLORS.accent}>{groups()[dayCursor()]?.label ?? "—"}</text>
              <text fg={COLORS.muted} onMouseUp={() => jumpToDay(1)}>
                {"▶"}
              </text>
              <text fg={COLORS.border}>
                {groups().length > 0 ? `${dayCursor() + 1}/${groups().length}` : ""}
              </text>
            </box>
          </box>
        }
      >
        <box flexDirection="column" height={2}>
          <For each={[0, 1]}>
            {(i) => (
              <text fg={COLORS.soft} height={1} overflow="hidden">
                {wrapSummary(hovered()!.full, 30, 2)[i] ?? ""}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={initialReady()} fallback={<text fg={COLORS.muted}>{"正在加载用户消息…"}</text>}>
        <Show when={readyNodes().length > 0} fallback={<text fg={COLORS.muted}>{"暂无用户消息"}</text>}>
        <Show
          when={props.scroll}
          fallback={<For each={shownGroups()}>{(group) => <DateGroup group={group} />}</For>}
        >
          {/* 固定可视行数，剩余全部滚轮滚动；stickyScroll 保证新消息进来时保持在底部 */}
          <box flexDirection="column" width="100%" height={panelHeight()}>
            <scrollbox
              ref={(scroll) => {
                timelineScroll = scroll
              }}
              height={panelHeight()}
              width="100%"
              alignSelf="stretch"
              stickyScroll
              stickyStart="bottom"
              // 宿主只给自己的容器注入 scrollAcceleration，插件自建的 scrollbox
              // 不传就退回默认实现（每格 1 行），长会话几乎翻不动（issue #3）。
              scrollAcceleration={{ tick: () => props.scrollStep, reset: () => {} }}
              // 内置滚动条隐藏，用右侧自绘的细线版本
              verticalScrollbarOptions={{ visible: false }}
              // 嵌套在宿主侧边栏滚动容器中；无论事件命中行、content 还是
              // scrollbox 本身，都在这里截断冒泡，避免外层跟着滚动。
              onMouseScroll={captureTimelineScroll}
            >
              <box flexDirection="column" width="100%">
                <For each={shownGroups()}>{(group) => <DateGroup group={group} />}</For>
              </box>
            </scrollbox>
            {/* 右侧自绘滚动条：往内缩一列，避开侧边栏自身的滚动条 */}
            <box
              position="absolute"
              right={1}
              top={0}
              width={1}
              height={panelHeight()}
              zIndex={5}
              flexDirection="column"
            >
              <For each={Array.from({ length: panelHeight() }, (_, i) => i)}>
                {(i) => {
                  // 必须包成 memo：<For> 对相同数字不会重建 children，
                  // 直接写 const on = ... 只会求值一次。
                  const on = createMemo(() => {
                    const b = bar()
                    return b.visible && i >= b.top && i < b.top + b.size
                  })
                  return <text fg={COLORS.accent}>{on() ? "▌" : " "}</text>
                }}
              </For>
            </box>
          </box>
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
        title: "足迹：显示 / 隐藏面板",
        description: "在会话侧边栏显示或隐藏「足迹」面板",
        group: "Footprints",
        bind: "alt+u",
        palette: true,
        slash: { name: "footprints" },
        run: async () => {
          await props.update((draft) => {
            draft.visible = !draft.visible
          })
          props.context.ui.toast.show({
            message: props.settings.visible ? "足迹面板：已显示" : "足迹面板：已隐藏",
          })
        },
      },
      {
        id: "footprints.scroll-step",
        title: "足迹：切换滚轮步长",
        description: "在 1 / 2 / 3 / 5 行之间循环，调快或调慢时间线面板的滚轮滚动",
        group: "Footprints",
        palette: true,
        slash: { name: "footprints-step" },
        run: async () => {
          const current = props.settings.scrollStep ?? DEFAULT_STEP
          const index = SCROLL_STEPS.indexOf(current as (typeof SCROLL_STEPS)[number])
          const next = SCROLL_STEPS[(index + 1) % SCROLL_STEPS.length]
          await props.update((draft) => {
            draft.scrollStep = next
          })
          props.context.ui.toast.show({ message: `足迹面板滚轮步长：${next} 行/格` })
        },
      },
    ],
    bindings: [COMMAND_ID],
  }))

  return <></>
}

export default Plugin.define({
  id: "opencode-footprints",
  setup(context) {
    const visibleRows = typeof context.options.visibleRows === "number" && context.options.visibleRows > 0
      ? Math.floor(context.options.visibleRows)
      : 10
    // scroll: false 可关闭滚轮滚动区（退回静态最新 N 行）——
    // scrollbox 经过原生渲染核心，个别 beta 版本上可能不稳定，留一个不动代码的退路。
    const scroll = context.options.scroll !== false

    const [settings, updateSettings] = context.storage.store("settings", {
      initial: { visible: true, scrollStep: DEFAULT_STEP } satisfies Settings,
    })

    // 遮盖层状态（内存态，重启即弃），配合 app 级 slot 渲染全屏定位遮罩。
    const [mask, setMask] = context.storage.memory("mask", {
      initial: { show: false, preview: "", label: "" } as MaskState,
    })
    let maskShownAt = 0
    const maskControl: MaskControl = {
      show(preview, label) {
        maskShownAt = Date.now()
        setMask((draft) => {
          draft.show = true
          draft.preview = preview
          draft.label = label ?? "正在定位消息…"
        })
      },
      async drop() {
        if (!mask.show) return
        // 遮罩只在预估超过 600ms 时才出现，所以最短显示取 400ms 就够——
        // 它不会超过跳转本身，也就不会额外拖延，同时避免极快跳转时闪一下残影。
        const remain = 400 - (Date.now() - maskShownAt)
        if (remain > 0) await sleep(remain)
        // 关键：至少让出一帧再撤。show() 之后如果主线程被同步 dispatch 占住，
        // 遮罩根本没机会被画出来，等到快结束时才闪一下——这一帧就是为了避免那种残影。
        await nextFrame()
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
      // prepend：插到侧边栏内容最前面（append 会排到 Token/Context/MCP/Sessions 之后）
      prepend: "sidebar.content",
      render: ({ sessionID }) => (
        <Show when={settings.visible && typeof sessionID === "string" && sessionID.length > 0}>
          <UserNodesPanel
            context={context}
            sessionID={sessionID}
            visibleRows={visibleRows}
            scroll={scroll}
            scrollStep={settings.scrollStep ?? DEFAULT_STEP}
            mask={maskControl}
          />
        </Show>
      ),
    })

    return () => {
      unbind()
      unpick()
    }
  },
})
