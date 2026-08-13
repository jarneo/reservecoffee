// app.js — 二曜路8号咖啡和清酒 · 预约小程序
// 将下方 ENV_ID 替换为你的 CloudBase 环境 ID（云开发控制台获取）。
const ENV_ID = 'your-env-id'

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
  },

  // 获取/刷新管理员角色（写入 globalData）
  refreshRole() {
    return wx.cloud.callFunction({ name: 'getRole' })
      .then(res => {
        const r = (res && res.result) || {}
        this.globalData.role = r.role || 'none'
        this.globalData.openid = r.openid || ''
        return r
      })
      .catch(() => ({ role: 'none' }))
  }
})
