import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-user-timeline",
  // v2.0.2 起 TUI 部分由 package.json 的 exports["./tui"] 自动发现（2.0.10 机制不变），
  // 服务端定义不再接受 tui 标记（旧版 beta 的 tui: true 已移除）。
  setup() {
    // 全部功能都在 TUI 侧（./tui.tsx），服务端无需做任何事。
  },
})
