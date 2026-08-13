const { call } = require('../../utils/cloud')
const guard = require('../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: { form: {} },
  onLoad() { this.guard(['owner']).then(r => { if (r) this.load() }) },
  load() {
    call('getHomepage').then(d => this.setData({ form: d.homepage || {} })).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  on(e) { this.setData({ ['form.' + e.currentTarget.dataset.k]: e.detail.value }) },
  save() {
    wx.showLoading({ title: '保存中' })
    call('updateHomepage', this.data.form)
      .then(() => { wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' }) })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  }
})
