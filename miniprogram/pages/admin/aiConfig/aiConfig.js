const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: { enabled: true, saving: false },
  onLoad() {
    this.guard(['owner']).then(role => {
      if (!role) return
      call('getAiConfig').then(d => {
        this.setData({ enabled: d.enabled !== false })
      }).catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
    })
  },
  toggle(e) { this.setData({ enabled: !!e.detail.value }) },
  save() {
    if (this.data.saving) return
    this.data.saving = true
    wx.showLoading({ title: '保存中' })
    call('saveAiConfig', { enabled: this.data.enabled })
      .then(() => { wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' }); this.data.saving = false })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message || '保存失败', icon: 'none' }); this.data.saving = false })
  }
})
