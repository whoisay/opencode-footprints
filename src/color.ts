/**
 * 主题色的莫兰迪化。
 *
 * 抄自 opencode-visual-cache 的做法：不管用户用什么主题，把颜色饱和度压到
 * 0.28 以下再显示。高饱和主题（Dracula、Solarized）的刺眼感会被削掉，
 * 同时保留色相，绿/黄/红仍然能区分。
 *
 * 纯函数，不依赖运行时。
 */

export type Rgb = { r: number; g: number; b: number }

/** 饱和度上限。0.15–0.30 是莫兰迪色的区间，0.28 取上沿。 */
export const MAX_SAT = 0.28

/**
 * 主题取色失败时的兜底。这几个值本身就是低饱和的，
 * 即使用户主题缺某个 feedback 色也不会退化成刺眼的默认色。
 */
export const FALLBACK = {
  primary: "#8B9DAF",
  text: "#C5C5BB",
  muted: "#7A7A72",
  success: "#9CAF8B",
  warning: "#C5B88D",
  error: "#B08A8A",
  border: "#6B6B63",
} as const

/**
 * 把 hex 字符串或 RGBA 对象统一成 0–255 的 RGB。
 *
 * OpenTUI 的 RGBA 通道是 0–255；但有些主题会把通道归一化到 0–1，
 * 所以三个通道都 <= 1 时按 0–1 处理。
 */
export function toRgb(raw: unknown): Rgb | null {
  if (typeof raw === "string") {
    const match = raw.trim().match(/^#?([0-9a-f]{6})$/i)
    if (!match) return null
    const value = parseInt(match[1], 16)
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
  }
  if (raw && typeof raw === "object") {
    const candidate = raw as { r?: unknown; g?: unknown; b?: unknown }
    if ([candidate.r, candidate.g, candidate.b].every((item) => typeof item === "number")) {
      const r = candidate.r as number
      const g = candidate.g as number
      const b = candidate.b as number
      const scale = r <= 1 && g <= 1 && b <= 1 ? 255 : 1
      return { r: Math.round(r * scale), g: Math.round(g * scale), b: Math.round(b * scale) }
    }
  }
  return null
}

/** HSL 空间的饱和度，0–1。 */
export function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  if (max === min) return 0
  const delta = max - min
  const lightness = (max + min) / 2
  return lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const lightness = (max + min) / 2
  if (max === min) return [0, 0, lightness]
  const delta = max - min
  const sat = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue: number
  if (max === rn) hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) hue = ((bn - rn) / delta + 2) / 6
  else hue = ((rn - gn) / delta + 4) / 6
  return [hue, sat, lightness]
}

function fromHsl(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const value = Math.round(l * 255)
    return { r: value, g: value, b: value }
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let shifted = t
    if (shifted < 0) shifted += 1
    if (shifted > 1) shifted -= 1
    if (shifted < 1 / 6) return p + (q - p) * 6 * shifted
    if (shifted < 1 / 2) return q
    if (shifted < 2 / 3) return p + (q - p) * (2 / 3 - shifted) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  }
}

function toHex(color: Rgb): string {
  const hex = (value: number) =>
    Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`
}

/**
 * 把颜色压到 maxSat 以下的饱和度，返回 hex 字符串。
 *
 * 已经低于上限的颜色原样返回（只是转成 hex），不做任何改动——
 * 否则用户本来就选好的低饱和主题会被反复拉低。
 */
export function desaturateTo(raw: unknown, maxSat: number, fallback: string): string {
  const color = toRgb(raw)
  if (!color) return fallback
  const [hue, sat, lightness] = toHsl(color.r, color.g, color.b)
  if (sat <= maxSat) return toHex(color)
  return toHex(fromHsl(hue, maxSat, lightness))
}

/** 整体调暗，factor 是乘数（0–1）。 */
export function dimColor(hex: string, factor = 0.7): string {
  const color = toRgb(hex)
  if (!color) return hex
  return toHex({
    r: Math.round(color.r * factor),
    g: Math.round(color.g * factor),
    b: Math.round(color.b * factor),
  })
}

/** 时间线用到的六个语义色。 */
export type Palette = {
  text: string
  muted: string
  accent: string
  soft: string
  border: string
  background: string
}

/**
 * 从宿主主题派生调色板。
 *
 * 每个槽位都是「主题取色 → 去饱和 → 失败用兜底」：
 * - text/muted/soft 跟随主题正文的三级灰
 * - accent 取主题主色（action.primary 的 selected 状态）
 * - border/background 取更暗的层级
 *
 * accent 不能用 feedback.warning：那是语义色，各主题都是同一个黄/橙，
 * 切主题不会变。也不能用 action.primary.base：那个在主题定义里就是
 * $text.base（白），是按钮文字色。主色只在 selected 状态里。
 *
 * 主题缺字段时退回 footprints 原来的暖色板，不会退化成纯白/纯黑。
 */
export function derivePalette(theme: any, fallback: Palette): Palette {
  const action = theme?.text?.action?.primary
  const primary = action?.selected ?? action?.focused
  return {
    text: desaturateTo(theme?.text?.base, MAX_SAT, fallback.text),
    muted: desaturateTo(theme?.text?.muted, MAX_SAT, fallback.muted),
    accent: primary ? desaturateTo(primary, MAX_SAT, fallback.accent) : fallback.accent,
    soft: desaturateTo(theme?.text?.faint, MAX_SAT, fallback.soft),
    border: desaturateTo(theme?.border?.base, MAX_SAT, fallback.border),
    background: desaturateTo(theme?.background?.raised?.base, MAX_SAT, fallback.background),
  }
}
