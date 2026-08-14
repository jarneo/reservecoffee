const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

function fmt(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

Page({
  behaviors: [guard],
  data: { list: [], visitors: [], openid: '', role: 'manager', note: '' },
  onLoad() {
    this.guard(['owner']).then(r => {
      if (r) { this.load(); this.loadVisitors() }
    })
  },
  load() {
    call('listAdmins').then(d => this.setData({ list: d.list || [] })).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  loadVisitors() {
    call('listVisitors')
      .then(d => this.setData({
        visitors: (d.list || []).map(v => ({ ...v, lastSeenText: fmt(v.lastSeen) }))
      }))
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  onOpenid(e) { this.setData({ openid: e.detail.value }) },
  onNote(e) { this.setData({ note: e.detail.value }) },
  pickRole(e) { this.setData({ role: e.currentTarget.dataset.r }) },
  add() {
    const { openid, role, note } = this.data
    if (!openid.trim()) return wx.showToast({ title: '请填写 openid', icon: 'none' })
    this.doAdd(openid.trim(), role, note, () => this.setData({ openid: '', note: '' }))
  },
  addVisitor(e) {
    const { openid, role } = e.currentTarget.dataset
    this.doAdd(openid, role, '', null)
  },
  doAdd(openid, role, note, after) {
    wx.showLoading({ title: '授权中' })
    call('addAdmin', { openid, role, note })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '已授权', icon: 'success' })
        this.load()
        this.loadVisitors()
        if (after) after()
      })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  remove(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '移除管理员', content: '确认移除该管理员？', confirmText: '移除',
      success: r => {
        if (r.confirm) call('removeAdmin', { adminId: id }).then(() => this.load()).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
      }
    })
  }
})
