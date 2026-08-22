const { call } = require('../../utils/cloud')
const app = getApp()

Page({
  data: {
    homepage: {}, projects: [], products: [], featured: null, role: 'none',
    showProfile: false, pName: '', pAvatar: ''
  },

  onShow() {
    this.load()
    // 重新拉取角色，避免 onLaunch 异步未返回时拿到过期的 'none' 导致按钮不显示
    app.refreshRole().then(r => {
      this.setData({ role: (r && r.role) || 'none' })
    })
    this.maybeProfile()
  },

  load() {
    call('getHomepage')
      .then(d => this.setData({
        homepage: d.homepage || {},
        projects: d.projects || [],
        products: d.products || [],
        featured: (d.projects && d.projects[0]) || null
      }))
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },

  // 首次进入：本机未标记完成且云端无昵称时，弹资料引导卡
  maybeProfile() {
    if (wx.getStorageSync('profileCardDone')) return
    call('getMyProfile')
      .then(d => {
        if (d && d.profile && d.profile.name) {
          wx.setStorageSync('profileCardDone', true)
          return
        }
        this.setData({ showProfile: true })
      })
      .catch(() => {})
  },

  onPName(e) { this.setData({ pName: e.detail.value }) },
  onChooseAvatar(e) { this.setData({ pAvatar: e.detail.avatarUrl }) },

  saveProfileCard() {
    const name = (this.data.pName || '').trim()
    if (!name) return wx.showToast({ title: '请填写称呼', icon: 'none' })
    wx.showLoading({ title: '保存中' })
    const data = { name }
    const finish = (avatar) => {
      if (avatar) data.avatar = avatar
      call('saveProfile', data)
        .then(() => {
          wx.hideLoading()
          wx.setStorageSync('profileCardDone', true)
          this.setData({ showProfile: false })
          wx.showToast({ title: '已保存', icon: 'success' })
        })
        .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message || '保存失败', icon: 'none' }) })
    }
    // 头像：chooseAvatar 给的是临时路径，需上传云存储后存 fileID；失败不阻断昵称保存
    if (this.data.pAvatar) {
      const oid = app.globalData.openid || Date.now()
      const cloudPath = `avatars/${oid}_${Date.now()}.png`
      wx.cloud.uploadFile({ cloudPath, filePath: this.data.pAvatar })
        .then(res => finish(res.fileID))
        .catch(() => finish())
    } else {
      finish()
    }
  },

  skipProfile() {
    wx.setStorageSync('profileCardDone', true)
    this.setData({ showProfile: false })
  },

  goBooking(e) {
    wx.navigateTo({ url: '/pages/booking/booking?projectId=' + e.currentTarget.dataset.id })
  },

  goProduct(e) {
    wx.navigateTo({ url: '/pages/product/product?productId=' + e.currentTarget.dataset.id })
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/hub/hub' })
  }
})
