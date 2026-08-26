// @jsxImportSource @opentui/solid
// 离线验证：绝对定位遮盖层能否覆盖整个区域（不跑在 TUI 里，仅测试用）
import "@opentui/solid/runtime-plugin-support"
import { testRender } from "@opentui/solid"

const BG = "#2d353b" // everforest darkStep1
const TEXT = "#d3c6aa"
const MUTED = "#7a8478"
const ACCENT = "#a7c080"

function Veil() {
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      zIndex={999}
      backgroundColor={BG}
      justifyContent="center"
      alignItems="center"
    >
      <box border borderColor={ACCENT} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexDirection="column">
        <box flexDirection="row" gap={1}>
          <text fg={ACCENT}>{"◆"}</text>
          <text fg={TEXT}>{"正在定位消息…"}</text>
        </box>
        <text fg={MUTED}>{"构建一个opencode2插件…"}</text>
      </box>
    </box>
  )
}

const setup = await testRender(
  () => (
    <box width="100%" height="100%" flexDirection="column">
      {/* 模拟底层会话内容 */}
      <box flexDirection="column" flexGrow={1}>
        <text>会话内容第一行-应该被盖住</text>
        <text>会话内容第二行-应该被盖住</text>
        <text>11:31 ─ 节点行-应该被盖住</text>
      </box>
      <Veil />
    </box>
  ),
  { width: 60, height: 12 },
)
await setup.renderOnce()
const frame = setup.captureCharFrame()
console.log(frame)
console.log("===检查结果===")
console.log("包含遮盖标题:", frame.includes("正在定位消息"))
console.log("底层内容被盖住:", !frame.includes("会话内容第一行"))
await setup.renderer.destroy()
