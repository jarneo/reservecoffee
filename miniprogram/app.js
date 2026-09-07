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
  refreshRole() {
    const { call } = require('./utils/cloud')
    return call('getRole')
      .then(r => {
        this.globalData.role = (r && r.role) || 'none'
        this.globalData.openid = (r && r.openid) || ''
        return r
      })
      .catch(() => ({ role: 'none' }))
  }
})
