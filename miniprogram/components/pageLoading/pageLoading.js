// components/pageLoading/pageLoading.js — 全屏首屏加载遮罩
//
// 设计：竖排书法「咖啡与清酒」的「墨迹落笔」三段式动效（2026-09-28 替换旧的圆形 logo 呼吸）
//   ① 入場·逐字落笔（固定 ~800ms）  ② 静息·墨迹呼吸（随加载自适应）  ③ 收笔·淡出（fadeMs）
//
// 设计要点：
// 1) show 默认 **false**：漏接入的页面表现为「没有遮罩」而非「永久白屏」——安全降级。
// 2) 对外不暴露命令式方法（selectComponent 在 onLoad 阶段可能返回 null），全部由 show 属性驱动。
// 3) 支持最小展示时长 minShow，避免数据 50ms 返回时遮罩「闪一下」。
// 4) 素材缺失/损坏 → binderror → inkErr 降级为竖排文字，更换素材无需改任何代码。
// 5) **跟随系统深浅色**：底色 + 墨色随系统外观切换，与微信自己的启动页（扫码瞬间的黑/白屏）
//    视觉无缝衔接，避免「黑 → 白」跳变。墨色由素材决定：浅色黑墨(l*)、深色白墨(d*)。
//
// ⚠️ 关于微信启动页：扫码进入小程序时先出现的是**微信自己的启动页**（Splash），
//    它由微信渲染、跟随系统外观，且**小程序无法设置**。所以只能靠本组件跟随系统深浅色来逼近。
Component({
  properties: {
    show:    { type: Boolean, value: false },
    // 落款小字：默认空串 —— 书法本身已是完整主体，与旧版「一行标题」不同；
    // 页面显式传值才在书法下方渲染一行小字（如「二曜路 8 号」）
    title:   { type: String,  value: '' },
    minShow: { type: Number,  value: 300 },   // 最小展示时长(ms)，置 0 关闭
    fadeMs:  { type: Number,  value: 420 },   // 淡出时长(ms)：遮罩纯白、页面 #FAFAFA，拉长一点让色差过渡更柔和
    // 入场总时长(ms)：逐字落笔播完后转入「静息呼吸」，需 ≥ 5×130ms + 单字 550ms
    entranceMs: { type: Number, value: 950 },
    // 层级：默认 1050（> aiFab 999）。AI 页需传 1090（必须 < ai.wxss 的 .pmask 1100）
    zIndex:  { type: Number,  value: 1050 }
    // theme 不由外部传：组件自己探测系统外观（见 attached）
  },

  data: {
    visible: false,
    fading: false,
    inkErr: false,
    inkOn: false,      // 触发「逐字落笔」入场
    inkBreath: false,  // 入场结束后开启「墨迹呼吸」循环
    theme: 'light',    // 'light' | 'dark'
    inkTone: 'l',      // 'l' 黑墨(浅色) | 'd' 白墨(深色)
    inkSrcs: [],       // 五字切片路径
    inkMark: ''        // 小横笔路径
  },

  lifetimes: {
    attached() {
      this._timers = []
      this._shownAt = 0
      this._setTheme(this._readTheme())

      // 监听系统外观切换（遮罩显示期间用户切深色也能实时跟上，墨色随之切换）
      this._themeCb = (res) => {
        const t = (res && res.theme) || 'light'
        if (t !== this.data.theme) this._setTheme(t)
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
        // 显示：立即上屏并复位动画状态，清掉上一轮残留（防复用实例时残留 pl-fade / pl-ink-run）
        this._shownAt = Date.now()
        this._clearTimers()
        // 每次上屏前重探一次：遮罩可能跨越了前后台切换（期间系统外观可能已变）
        this._setTheme(this._readTheme())
        this.setData({ visible: true, fading: false, inkOn: false, inkBreath: false, inkErr: false })
        // 下一帧再加 pl-ink-run，确保 opacity 0 → 1 的过渡能生效（首帧先以 0 透明上屏）
        this._timers.push(setTimeout(() => {
          this.setData({ inkOn: true })
          // 入场播完 → 开启静息呼吸（用属性而非硬编码，便于调参）
          this._timers.push(setTimeout(() => {
            this.setData({ inkBreath: true })
          }, this.properties.entranceMs || 950))
        }, 20))
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
    // 读系统外观。取不到（老基础库 / 异常）时按 light 处理，绝不影响遮罩显示
    _readTheme() {
      try {
        const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
        return (info && info.theme) === 'dark' ? 'dark' : 'light'
      } catch (e) { return 'light' }
    },
    // 应用外观：theme + 墨色 + 素材路径（l*=浅色黑墨 / d*=深色白墨）
    _setTheme(t) {
      const tone = t === 'dark' ? 'd' : 'l'
      if (t === this.data.theme && tone === this.data.inkTone && this.data.inkSrcs.length) return
      this.setData({
        theme: t,
        inkTone: tone,
        inkSrcs: [1, 2, 3, 4, 5].map((n) => `/assets/logink/${tone}${n}.png`),
        inkMark: `/assets/logink/${tone}m.png`
      })
    },
    // 拦截穿透：遮罩期间不让底层列表滚动 / 元素被误触
    noop() {},
    // 任一素材缺失或损坏 → 降级到竖排文字占位（换素材时无需改代码）
    onInkErr() {
      if (!this.data.inkErr) this.setData({ inkErr: true })
    }
  }
})
