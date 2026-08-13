const { call } = require('../../utils/cloud')
const guard = require('../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: { list: [] },
  onLoad() { this.guard(['owner']).then(r => { if (r) this.load() }) },
  load() {
    call('listReviews').then(d => this.setData({ list: d.list || [] })).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  approve(e) { this.act(e.currentTarget.dataset.id, 'approve') },
  reject(e) { this.act(e.currentTarget.dataset.id, 'reject') },
  act(id, decision) {
    wx.showLoading({ title: '处理中' })
    call('reviewReservation', { reservationId: id, decision })
      .then(() => { wx.hideLoading(); this.load(); wx.showToast({ title: '已处理', icon: 'success' }) })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  }
})
