// app.js — 二曜路8号咖啡和清酒 · 预约小程序
// 将下方 ENV_ID 替换为你的 CloudBase 环境 ID（云开发控制台获取）。
const ENV_ID = 'cloud1-d8g9mhgxm32d2eac6'

App({
  globalData: {
    envId: ENV_ID,
    role: 'none',      // none | owner | manager
    openid: '',
    userInfo: null
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }
    wx.cloud.init({
      env: ENV_ID,
      traceUser: true
    })
    // 进入即探测角色（用于底部 tab / 入口自适应）
    this.refreshRole()
    // 首启采集来源 scene（用于顾客「初次来源」标签）；失败静默，不阻断启动
    try {
      const opt = (wx.getEnterOptionsSync && wx.getEnterOptionsSync()) || {}
      require('./utils/cloud').call('markLaunch', { scene: opt.scene || '' }).catch(() => {})
    } catch (e) { /* ignore */ }
    // 埋点：访问小程序（转化漏斗第1层 + 「只看不约」用户识别）。
    // ⚠️ 必须在 refreshRole().then 之后触发：首云调用的 OPENID 上下文可能尚未就绪，
    // 若与 refreshRole 并行发出，trackEvent 会因「未登录」静默丢弃 → 访问UV 长期为 0。
    // 链式调用保证 OPENID 已可用（refreshRole 的 getRole 已证明其可用）。
    this.refreshRole().then(() => {
      try {
        require('./utils/cloud').call('trackEvent', { type: 'visit' }).catch(() => {})
      } catch (e) { /* ignore */ }
    }).catch(() => {})
  },

  // 获取/刷新管理员角色（写入 globalData）
  //
  // ⚠️ 启动时这里原本会被并发调用两次（onLaunch 的「探测角色」与「链式埋点」各一次），
  // 加上首页 onShow 的一次，同一次冷启动要跑 3 遍 getRole —— 白白多两次云函数往返。
  // 改为「短 TTL 内复用同一个 Promise」：
  //   · onLaunch 两处 + 首页 onShow 间隔极短 → 合并为 1 次请求
  //   · 超过 TTL（30s）后再次调用仍会真发请求，不会把角色永久钉死
  //   · 失败不缓存（清空 _rolePromise），下次调用正常重试
  //   · force=true 强制刷新：管理端门禁必须拿到最新权限，不能吃缓存
  refreshRole(force) {
    const now = Date.now()
    const TTL = 30 * 1000
    if (!force && this._rolePromise && (now - (this._roleAt || 0)) < TTL) {
      return this._rolePromise
    }
    this._roleAt = now
    const { call } = require('./utils/cloud')
    this._rolePromise = call('getRole')
      .then(r => {
        this.globalData.role = (r && r.role) || 'none'
        this.globalData.openid = (r && r.openid) || ''
        return r
      })
      .catch(() => {
        this._rolePromise = null   // 失败不留缓存，下次重试
        return { role: 'none' }
      })
    return this._rolePromise
  }
})
