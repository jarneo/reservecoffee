// components/pageLoading/pageLoading.js — 全屏首屏加载遮罩
//
// 视觉（2026-09-28 重构）：竖排书法「咖啡与清酒」**静态常显、不做动画**；
//   其下「二曜路8号」逐字落笔作落款，播完若仍未就绪 → 循环重播。
//   ⚠️ 旧版的「五字逐字落笔 + 墨迹呼吸」已移除：入场需 ~950ms，加载快时
//      常出现「大字没展示全就进小程序」。改为静态后，首帧即完整可见，不再依赖时长。
//   循环由纯 CSS（animation ... infinite）实现，JS 不持有任何循环定时器。
//
// 设计要点：
// 1) show 默认 **false**：漏接入的页面表现为「没有遮罩」而非「永久白屏」——安全降级。
// 2) 对外不暴露命令式方法（selectComponent 在 onLoad 阶段可能返回 null），全部由 show 属性驱动。
// 3) 支持最小展示时长 minShow，避免数据 50ms 返回时遮罩「闪一下」。
// 4) 素材缺失/损坏 → binderror → inkErr 降级为竖排文字，更换素材无需改任何代码。
// 5) **跟随系统深浅色**：底色 + 墨色随系统外观切换，与微信自己的启动页（扫码瞬间的黑/白屏）
//    视觉无缝衔接，避免「黑 → 白」跳变。墨色由素材决定：浅色黑墨(hero-l)、深色白墨(hero-d)。
//
// ⚠️ 关于微信启动页：扫码进入小程序时先出现的是**微信自己的启动页**（Splash），
//    它由微信渲染、跟随系统外观，且**小程序无法设置**。所以只能靠本组件跟随系统深浅色来逼近。
Component({
  properties: {
    show:    { type: Boolean, value: false },
    // 落款文字：默认「二曜路8号」，逐字落笔。传空串可关闭（无品牌/调试场景）。
    subText: { type: String,  value: '二曜路8号' },
    minShow: { type: Number,  value: 300 },   // 最小展示时长(ms)，置 0 关闭
    fadeMs:  { type: Number,  value: 420 },   // 淡出时长(ms)：遮罩纯白、页面 #FAFAFA，拉长一点让色差过渡更柔和
    // 层级：默认 1050（> aiFab 999）。AI 页需传 1090（必须 < ai.wxss 的 .pmask 1100）
    zIndex:  { type: Number,  value: 1050 }
    // theme 不由外部传：组件自己探测系统外观（见 attached）
  },

  data: {
    visible: false,
    fading: false,
    inkErr: false,
    theme: 'light',    // 'light' | 'dark'
    inkTone: 'l',      // 'l' 黑墨(浅色) | 'd' 白墨(深色)
    inkSrc: '',        // 书法整幅（静态单图）
    subChars: []       // 落款逐字数组，顺序即落笔顺序
  },

  lifetimes: {
    attached() {
      this._timers = []
      this._shownAt = 0
      this._syncSub(this.properties.subText)
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
    subText(v) { this._syncSub(v) },

    show(v) {
      if (v) {
        // 显示：立即上屏并复位状态，清掉上一轮残留（防复用实例时残留 pl-fade）
        this._shownAt = Date.now()
        this._clearTimers()
        // 每次上屏前重探一次：遮罩可能跨越了前后台切换（期间系统外观可能已变）
        this._setTheme(this._readTheme())
        this._syncSub(this.properties.subText)
        // visible 由 false→true 会重建节点，逐字动画自然从 0 重新起跑，无需手动复位
        this.setData({ visible: true, fading: false, inkErr: false })
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
    // 落款文字 → 逐字数组（仅内容变化时 setData，避免无谓渲染）
    _syncSub(text) {
      const chars = String(text == null ? '' : text).split('')
      if (chars.join('') === (this.data.subChars || []).join('')) return
      this.setData({ subChars: chars })
    },
    // 读系统外观。取不到（老基础库 / 异常）时按 light 处理，绝不影响遮罩显示
    _readTheme() {
      try {
        const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
        return (info && info.theme) === 'dark' ? 'dark' : 'light'
      } catch (e) { return 'light' }
    },
    // 应用外观：theme + 墨色 + 素材路径（hero-l 浅色黑墨 / hero-d 深色白墨）
    _setTheme(t) {
      const tone = t === 'dark' ? 'd' : 'l'
      if (t === this.data.theme && tone === this.data.inkTone && this.data.inkSrc) return
      this.setData({
        theme: t,
        inkTone: tone,
        inkSrc: `/assets/logink/hero-${tone}.png`
      })
    },
    // 拦截穿透：遮罩期间不让底层列表滚动 / 元素被误触
    noop() {},
    // 素材缺失或损坏 → 降级到竖排文字占位（换素材时无需改代码）
    onInkErr() {
      if (!this.data.inkErr) this.setData({ inkErr: true })
    }
  }
})
