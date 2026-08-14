const { call } = require('../../utils/cloud')
const app = getApp()

Page({
  data: { homepage: {}, projects: [], role: 'none' },

  onShow() {
    this.load()
    // 重新拉取角色，避免 onLaunch 异步未返回时拿到过期的 'none' 导致按钮不显示
    app.refreshRole().then(r => {
      this.setData({ role: (r && r.role) || 'none' })
    })
  },

  load() {
    call('getHomepage')
      .then(d => this.setData({ homepage: d.homepage || {}, projects: d.projects || [] }))
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },

  goBooking(e) {
    wx.navigateTo({ url: '/pages/booking/booking?projectId=' + e.currentTarget.dataset.id })
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/hub/hub' })
  }
})
