/**
 * timeline.ts 的纯逻辑测试。
 *
 * 每个用例对应一个真实会遇到的边界，不为了覆盖率凑数。
 * 这些函数决定侧边栏显示什么，而 TUI 渲染没法自动验证，只能测这一层。
 *
 * 运行：npm test（需要先 build，verify 会一起做）
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  dateKey,
  displayWidth,
  formatDate,
  formatTime,
  groupNodes,
  latestGroups,
  navigable,
  sameTimelineNode,
  timelineNode,
  truncate,
} from "../dist/timeline.js"

/** 造一条用户消息。 */
const msg = (id, created, text = "", files = []) => ({
  id,
  text,
  files,
  time: { created },
})

/** 造一个时间线节点。 */
const node = (id, created) => ({
  id,
  created,
  summary: id,
  full: id,
})

// ---------- displayWidth ----------

test("displayWidth: ASCII 每字符 1 列", () => {
  assert.equal(displayWidth("abc"), 3)
})

test("displayWidth: 中文每字符 2 列", () => {
  assert.equal(displayWidth("中文"), 4)
})

test("displayWidth: 中英混排按列累加", () => {
  assert.equal(displayWidth("a中b"), 4)
})

test("displayWidth: 空字符串为 0", () => {
  assert.equal(displayWidth(""), 0)
})

// ---------- truncate ----------

test("truncate: 未超长时原样返回", () => {
  assert.equal(truncate("短文本", 10), "短文本")
})

test("truncate: 超长时加省略号且总宽不超过 max", () => {
  const out = truncate("这是一段很长很长的中文文本", 10)
  assert.ok(out.endsWith("…"))
  assert.ok(displayWidth(out) <= 10, `宽度 ${displayWidth(out)} 超过 10`)
})

test("truncate: 中文按 2 列算，截断后总宽不超过 max", () => {
  // "四个中文字" = 10 列，max=9 必须截断。
  // 断言性质而不是精确字符串——手算列宽太容易错。
  const out = truncate("四个中文字", 9)
  assert.ok(out.endsWith("…"), `应当以省略号结尾: ${out}`)
  assert.ok(displayWidth(out) <= 9, `宽度 ${displayWidth(out)} 超过 9`)
  assert.ok("四个中文字".startsWith(out.slice(0, -1)), `截断后应当是原串前缀: ${out}`)
})

// ---------- timelineNode ----------

test("timelineNode: 取第一行作摘要", () => {
  const n = timelineNode(msg("m1", 1000, "第一行\n第二行"))
  assert.equal(n.summary, "第一行")
  assert.equal(n.id, "m1")
  assert.equal(n.created, 1000)
})

test("timelineNode: 多行合并进 full", () => {
  const n = timelineNode(msg("m1", 1000, "第一行\n第二行"))
  assert.ok(n.full.includes("第一行"))
  assert.ok(n.full.includes("第二行"))
})

test("timelineNode: 空文本但没有附件时显示占位", () => {
  // 真实场景：用户只发了个图片但 files 为空，或消息还在流式写入
  assert.equal(timelineNode(msg("m1", 1000, "")).summary, "(空消息)")
})

test("timelineNode: 只有附件时显示附件数", () => {
  const n = timelineNode(msg("m1", 1000, "", [{}, {}]))
  assert.equal(n.summary, "[附件 ×2]")
})

test("timelineNode: 全空白行会被过滤掉", () => {
  const n = timelineNode(msg("m1", 1000, "   \n\n  \n正文"))
  assert.equal(n.summary, "正文")
})

test("timelineNode: 超长文本在 full 里被截断到 400 附近", () => {
  const long = "字".repeat(400)
  const n = timelineNode(msg("m1", 1000, long))
  assert.ok(displayWidth(n.full) <= 400)
  assert.ok(n.full.endsWith("…"))
})

// ---------- sameTimelineNode ----------

test("sameTimelineNode: 三个字段都一样才算相同", () => {
  const a = { id: "x", created: 1, summary: "s", full: "f" }
  assert.equal(sameTimelineNode(a, { ...a }), true)
})

test("sameTimelineNode: id 不同但内容相同也算相同", () => {
  // 这个函数不比较 id，只比较内容，用于避免无谓的 Map 写入
  const a = { id: "x", created: 1, summary: "s", full: "f" }
  const b = { id: "y", created: 1, summary: "s", full: "f" }
  assert.equal(sameTimelineNode(a, b), true)
})

test("sameTimelineNode: summary 变了就不相同", () => {
  const a = { id: "x", created: 1, summary: "s", full: "f" }
  assert.equal(sameTimelineNode(a, { ...a, summary: "t" }), false)
})

// ---------- 日期格式化 ----------

test("dateKey: 输出 YYYY-MM-DD", () => {
  const t = new Date(2026, 9, 31, 15, 30).getTime()
  assert.equal(dateKey(t), "2026-10-31")
})

test("formatDate: 输出 MM-DD 且补零", () => {
  const t = new Date(2026, 0, 5).getTime()
  assert.equal(formatDate(t), "01-05")
})

test("formatTime: 输出 HH:mm 且补零", () => {
  const t = new Date(2026, 9, 31, 9, 5).getTime()
  assert.equal(formatTime(t), "09:05")
})

test("dateKey: 跨年边界不会串年", () => {
  const t = new Date(2026, 11, 31, 23, 59).getTime()
  assert.equal(dateKey(t), "2026-12-31")
})

// ---------- groupNodes ----------

test("groupNodes: 空数组返回空", () => {
  assert.deepEqual(groupNodes([]), [])
})

test("groupNodes: 同一天的节点合并成一组", () => {
  const t = new Date(2026, 9, 31, 10, 0).getTime()
  const groups = groupNodes([node("a", t), node("b", t + 3600_000)])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].nodes.length, 2)
})

test("groupNodes: 跨天分成两组且保持顺序", () => {
  const d1 = new Date(2026, 9, 30, 10, 0).getTime()
  const d2 = new Date(2026, 9, 31, 10, 0).getTime()
  const groups = groupNodes([node("a", d1), node("b", d2)])
  assert.equal(groups.length, 2)
  assert.equal(groups[0].key, "2026-10-30")
  assert.equal(groups[1].key, "2026-10-31")
})

test("groupNodes: 返回的 label 是 MM-DD", () => {
  const t = new Date(2026, 9, 31, 10, 0).getTime()
  assert.equal(groupNodes([node("a", t)])[0].label, "10-31")
})

// ---------- latestGroups ----------

test("latestGroups: 取最近 N 条，从最后一组往前取", () => {
  const d1 = new Date(2026, 9, 30, 10, 0).getTime()
  const d2 = new Date(2026, 9, 31, 10, 0).getTime()
  const groups = groupNodes([node("a", d1), node("b", d2), node("c", d2 + 60_000)])
  const out = latestGroups(groups, 2)
  const ids = out.flatMap((g) => g.nodes.map((n) => n.id))
  assert.deepEqual(ids, ["b", "c"])
})

test("latestGroups: limit 大于总数时返回全部", () => {
  const t = new Date(2026, 9, 31, 10, 0).getTime()
  const groups = groupNodes([node("a", t), node("b", t + 1000)])
  const out = latestGroups(groups, 99)
  assert.equal(out.flatMap((g) => g.nodes).length, 2)
})

test("latestGroups: limit 为 0 时返回空", () => {
  const t = new Date(2026, 9, 31, 10, 0).getTime()
  assert.deepEqual(latestGroups(groupNodes([node("a", t)]), 0), [])
})

test("latestGroups: 跨组截断只保留尾部节点", () => {
  // 真实场景：消息少时面板按行数收缩，需要精确到「最后 2 条」
  const d1 = new Date(2026, 9, 30, 10, 0).getTime()
  const d2 = new Date(2026, 9, 31, 10, 0).getTime()
  const groups = groupNodes([
    node("a", d1),
    node("b", d1 + 1000),
    node("c", d2),
    node("d", d2 + 1000),
  ])
  const out = latestGroups(groups, 3)
  const ids = out.flatMap((g) => g.nodes.map((n) => n.id))
  assert.deepEqual(ids, ["b", "c", "d"])
})

// ---------- navigable ----------

test("navigable: 有文本的消息可定位", () => {
  assert.equal(navigable(msg("m", 1, "内容")), true)
})

test("navigable: 纯空白消息宿主会跳过，所以不可定位", () => {
  // 宿主实现是 trim 后判空，这里必须一致，否则步数算错导致跳错位置
  assert.equal(navigable(msg("m", 1, "   \n\t ")), false)
})

test("navigable: 只有附件的消息不可定位", () => {
  assert.equal(navigable(msg("m", 1, "", [{}])), false)
})
