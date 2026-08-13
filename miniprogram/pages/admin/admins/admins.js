const { call } = require('../../utils/cloud')
const guard = require('../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: { list: [], openid: '', role: 'manager', note: '' },
  onLoad() { this.guard(['owner']).then(r => { if (r) this.load() }) },
  load() {
    call('listAdmins').then(d => this.setData({ list: d.list || [] })).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  onOpenid(e) { this.setData({ openid: e.detail.value }) },
  onNote(e) { this.setData({ note: e.detail.value }) },
  pickRole(e) { this.setData({ role: e.currentTarget.dataset.r }) },
  add() {
    const { openid, role, note } = this.data
    if (!openid.trim()) return wx.showToast({ title: '请填写 openid', icon: 'none' })
    wx.showLoading({ title: '授权中' })
    call('addAdmin', { openid: openid.trim(), role, note })
      .then(() => { wx.hideLoading(); this.setData({ openid: '', note: '' }); this.load(); wx.showToast({ title: '已授权', icon: 'success' }) })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  remove(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '移除管理员', content: '确认移除该管理员？', confirmText: '移除',
      success: r => { if (r.confirm) call('removeAdmin', { adminId: id }).then(() => this.load()).catch(e => wx.showToast({ title: e.message, icon: 'none' })) }
    })
  }
})
