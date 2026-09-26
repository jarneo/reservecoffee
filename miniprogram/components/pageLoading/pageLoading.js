// components/页面加载遮罩/pageLoading.js — 全屏首屏加载遮罩
//
// 设计要点：
// 1) show 默认 **false**：漏接入的页面表现为「没有遮罩」而非「永久白屏」——安全降级。
// 2) 对外不暴露命令式方法（selectComponent 在 onLoad 阶段可能返回 null），
//    全部由 show 属性驱动。
// 3) 支持最小展示时长 minShow，避免数据 50ms 返回时遮罩「闪一下」。
// 4) logo 文件缺失时 binderror 自动降级为文字占位，替换 logo 无需改任何代码。
// 5) **跟随系统深浅色**（见下）：遮罩底色/文字色随系统外观切换，与微信自己的
//    启动页（扫码那一瞬间的黑/白屏）视觉无缝衔接，避免「黑 → 白」跳变。
//
// ⚠️ 关于微信启动页：扫码进入小程序时先出现的是**微信自己的启动页**（Splash），
//    它由微信渲染、跟随系统外观（白天白底黑字 / 晚上黑底白字），且**小程序无法设置**。
//    所以「loadmask 和启动页一模一样」只能靠本组件跟随系统深浅色来逼近，
//    而不是硬编码某个颜色。
Component({
  properties: {
    show:    { type: Boolean, value: false },
    // logo 路径。文件不存在时会触发 binderror → 降级为 phText 字标占位
    logoSrc: { type: String,  value: '/assets/logo.png' },
    title:   { type: String,  value: '二曜路8号咖啡和清酒预约' },
    slogan:  { type: String,  value: '' },   // 默认留空：与微信启动页一样只出一行标题
    // 占位字标（logo 未投放 / 加载失败时显示）
    phText:  { type: String,  value: '曜' },
    minShow: { type: Number,  value: 300 },   // 最小展示时长(ms)，置 0 关闭
    fadeMs:  { type: Number,  value: 420 },   // 淡出时长(ms)：遮罩纯白、页面 #FAFAFA，拉长一点让色差过渡更柔和
    // 层级：默认 1050（> aiFab 999）。AI 页需传 1090（必须 < ai.wxss 的 .pmask 1100）
    zIndex:  { type: Number,  value: 1050 }
    // theme 不由外部传：组件自己探测系统外观（见 attached）
  },

  data: {
    visible: false,
    fading: false,
    logoErr: false,
    theme: 'light'   // 'light' | 'dark'，用于切换 .pl-dark
  },

  lifetimes: {
    attached() {
      this._timers = []
      this._shownAt = 0
      this._detectTheme()

      // 监听系统外观切换（用户在遮罩显示期间切深色，也能实时跟上）
      this._themeCb = (res) => {
        const t = (res && res.theme) || 'light'
        if (t !== this.data.theme) this.setData({ theme: t })
      }
      try {
        if (wx.onThemeChange) wx.onThemeChange(this._themeCb)
      } catch (e) { /* 低版本基础库无此 API，静默降级为 light */ }
    },
    detached() {
      (this._timers || []).forEach(clearTimeout)
      this._timers = []
      try {
        if (wx.offThemeChange && this._themeCb) wx.offThemeChange(this._themeCb)
      } catch (e) { /* ignore */ }
    }
  },

  observers: {
    show(v) {
      if (v) {
        // 显示：立即上屏，清掉上一轮淡出状态（防止复用组件实例时残留 pl-fade）
        this._shownAt = Date.now()
        this._clearTimers()
        // 每次上屏前重探一次：遮罩可能跨越了前后台切换（期间系统外观可能已变）
        this._detectTheme()
        this.setData({ visible: true, fading: false })
        return
      }
      // 隐藏：先补足最小展示时长，再加 .pl-fade，最后摘除节点
      if (!this.data.visible || this.data.fading) return
      const min = this.properties.minShow || 0
      const waited = Date.now() - (this._shownAt || 0)
      const wait = Math.max(0, min - waited)
      const fade = this.properties.fadeMs || 0
      this._timers.push(setTimeout(() => {
        // 下一帧再加 class，确保 opacity:1 → 0 的 transition 能生效
        this._timers.push(setTimeout(() => {
          this.setData({ fading: true })
          this._timers.push(setTimeout(() => {
            this.setData({ visible: false, fading: false })
          }, fade + 20))
        }, 20))
      }, wait))
    }
  },

  methods: {
    _clearTimers() {
      (this._timers || []).forEach(clearTimeout)
      this._timers = []
    },
    // 探测系统外观。取不到（老基础库 / 异常）时按 light 处理，绝不影响遮罩显示
    _detectTheme() {
      try {
        const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
        const t = (info && info.theme) === 'dark' ? 'dark' : 'light'
        if (t !== this.data.theme) this.setData({ theme: t })
      } catch (e) { /* ignore */ }
    },
    // 拦截穿透：遮罩期间不让底层列表滚动 / 元素被误触
    noop() {},
    // logo 文件缺失或损坏 → 降级到字标占位（换 logo 时无需改代码）
    onLogoErr() {
      this.setData({ logoErr: true })
    }
  }
})
