/**
 * color.ts 的测试。
 *
 * 重点是「去饱和」的边界：本来就低饱和的颜色不能被反复拉低，
 * 高饱和的必须压到上限以下，否则面板颜色会随主题漂移。
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { desaturateTo, dimColor, FALLBACK, MAX_SAT, saturation, toRgb } from "../dist/color.js"

// ---------- toRgb ----------

test("toRgb: hex 字符串", () => {
  assert.deepEqual(toRgb("#ff8800"), { r: 255, g: 136, b: 0 })
})

test("toRgb: 不带 # 的 hex", () => {
  assert.deepEqual(toRgb("00ff00"), { r: 0, g: 255, b: 0 })
})

test("toRgb: 0-255 通道的对象", () => {
  assert.deepEqual(toRgb({ r: 255, g: 128, b: 0, a: 255 }), { r: 255, g: 128, b: 0 })
})

test("toRgb: 0-1 归一化的对象会被放大", () => {
  assert.deepEqual(toRgb({ r: 1, g: 0.5, b: 0 }), { r: 255, g: 128, b: 0 })
})

test("toRgb: 非法输入返回 null", () => {
  assert.equal(toRgb("not-a-color"), null)
  assert.equal(toRgb(null), null)
  assert.equal(toRgb(undefined), null)
  assert.equal(toRgb({}), null)
})

// ---------- saturation ----------

test("saturation: 灰色为 0", () => {
  assert.equal(saturation(128, 128, 128), 0)
  assert.equal(saturation(0, 0, 0), 0)
  assert.equal(saturation(255, 255, 255), 0)
})

test("saturation: 纯色为 1", () => {
  assert.equal(saturation(255, 0, 0), 1)
  assert.equal(saturation(0, 255, 0), 1)
  assert.equal(saturation(0, 0, 255), 1)
})

test("saturation: 中间值介于 0 和 1", () => {
  const value = saturation(180, 140, 100)
  assert.ok(value > 0 && value < 1)
})

// ---------- desaturateTo ----------

test("desaturateTo: 非法输入返回兜底色", () => {
  assert.equal(desaturateTo("nope", MAX_SAT, "#123456"), "#123456")
})

test("desaturateTo: 兜底色自身也会被压到上限", () => {
  // #C5B88D 的饱和度约 0.33，高于 0.28，所以不是原样返回而是被压一档。
  // 这正是想要的行为：兜底色和主题色走同一条处理链，视觉上才统一。
  const result = desaturateTo(FALLBACK.warning, MAX_SAT, "#000000")
  const rgb = toRgb(result)
  assert.ok(rgb)
  assert.ok(saturation(rgb.r, rgb.g, rgb.b) <= MAX_SAT + 0.01)
})

test("desaturateTo: 真正低饱和的颜色原样返回", () => {
  // 纯灰没有饱和度，不该被改动
  const result = desaturateTo("#808080", MAX_SAT, "#000000")
  assert.equal(result.toLowerCase(), "#808080")
})

test("desaturateTo: 高饱和颜色被压到上限以下", () => {
  // 纯红饱和度 1，必须降到 0.28 附近
  const result = desaturateTo("#ff0000", MAX_SAT, "#000000")
  const rgb = toRgb(result)
  assert.ok(rgb)
  const sat = saturation(rgb.r, rgb.g, rgb.b)
  assert.ok(sat <= MAX_SAT + 0.01, `饱和度 ${sat} 仍高于上限`)
  assert.ok(sat > 0.2, `饱和度 ${sat} 压得过头，色相丢了`)
})

test("desaturateTo: 保留色相（红的还是红）", () => {
  const result = desaturateTo("#ff0000", MAX_SAT, "#000000")
  const rgb = toRgb(result)
  assert.ok(rgb)
  assert.ok(rgb.r > rgb.g && rgb.r > rgb.b, `红色分量应该最高: ${JSON.stringify(rgb)}`)
})

test("desaturateTo: 输出始终是合法 hex", () => {
  for (const input of ["#ff0000", "#00ff88", { r: 200, g: 100, b: 50 }]) {
    const result = desaturateTo(input, MAX_SAT, "#000000")
    assert.match(result, /^#[0-9a-f]{6}$/i)
  }
})

// ---------- dimColor ----------

test("dimColor: 乘数 1 不变", () => {
  assert.equal(dimColor("#808080", 1), "#808080")
})

test("dimColor: 乘数 0.5 减半", () => {
  assert.equal(dimColor("#808080", 0.5), "#404040")
})

test("dimColor: 非法输入原样返回", () => {
  assert.equal(dimColor("nope"), "nope")
})

test("dimColor: 不会溢出到负数或超过 255", () => {
  assert.equal(dimColor("#ffffff", 1.5), "#ffffff")
  assert.equal(dimColor("#000000", 0.5), "#000000")
})
