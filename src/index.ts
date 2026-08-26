import { Plugin } from "@opencode-ai/plugin"

export default Plugin.define({
  id: "opencode-user-timeline",
  tui: true,
  setup() {
    // 全部功能都在 TUI 侧（./tui.tsx），服务端无需做任何事。
  },
})
