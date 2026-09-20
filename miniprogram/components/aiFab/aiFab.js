// aiFab — 可拖动「AI预约」浮窗（首页 / 项目详情页常驻）
// 显隐由 aiEnabled 控制（来自 getHomepage / getProject 的 aiEnabled，全站不直读 config 集合）。
// 点击（非拖动）进入独立路由页 pages/ai（可带 projectId，便于从详情页预选项目）。
Component({
  properties: {
    aiEnabled: { type: Boolean, value: true },
    projectId: { type: String, value: '' }
  },
  data: {
    visible: false,
    left: 0,
    top: 0,
    sysW: 375,
    sysH: 667
  },
  lifetimes: {
    attached() {
      this.setData({ visible: this.properties.aiEnabled })
      try {
        const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync())
        const w = info.windowWidth || 375
        const h = info.windowHeight || 667
        // 初始位置：右下角（避开 tabBar 与底部安全区）
        this.setData({ sysW: w, sysH: h, left: w - 160, top: h - 190 })
      } catch (e) { /* ignore */ }
    }
  },
  observers: {
    aiEnabled(v) { this.setData({ visible: !!v }) }
  },
  methods: {
    onStart(e) {
      const t = e.touches[0]
      this._moved = false
      this._sx = t.clientX
      this._sy = t.clientY
      this._bl = this.data.left
      this._bt = this.data.top
    },
    onMove(e) {
      const t = e.touches[0]
      const dx = t.clientX - this._sx
      const dy = t.clientY - this._sy
      if (Math.abs(dx) + Math.abs(dy) > 6) this._moved = true
      let nl = this._bl + dx
      let nt = this._bt + dy
      nl = Math.max(8, Math.min(this.data.sysW - 160, nl))
      nt = Math.max(8, Math.min(this.data.sysH - 90, nt))
      this.setData({ left: nl, top: nt })
    },
    onEnd() {
      if (this._moved) return
      const pid = this.properties.projectId || ''
      wx.navigateTo({ url: '/pages/ai/ai' + (pid ? ('?projectId=' + pid) : '') })
    }
  }
})
