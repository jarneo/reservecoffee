// pages/admin/blacklist/blacklist — 黑名单专用页（仅 owner）
// 列出黑名单用户、支持移出；按昵称/手机号 findUser 定位并加入黑名单。
const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

function fmtDay(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

Page({
  behaviors: [guard],
  data: {
    role: 'none',
    list: [],
    query: '',
    results: []
  },
  onLoad() {
    this.guard(['owner']).then(role => {
      if (!role) return
      this.setData({ role })
      this.load()
    })
  },
  async load() {
    try {
      const d = await call('getBlacklist', {})
      this.setData({
        list: (d.list || []).map(x => ({ ...x, updatedText: fmtDay(x.updatedAt) }))
      })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' })
    }
  },
  async onSearch(e) {
    const q = (e.detail.value || '').trim()
    this.setData({ query: q })
    if (!q) { this.setData({ results: [] }); return }
    try {
      const d = await call('findUser', { q })
      this.setData({ results: d.list || [] })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '查询失败', icon: 'none' })
    }
  },
  async addToBlacklist(e) {
    const openid = e.currentTarget.dataset.openid
    const name = e.currentTarget.dataset.name || openid
    wx.showModal({
      title: '加入黑名单',
      content: `确认将「${name}」加入黑名单？加入后将无法预约。`,
      editable: true, placeholderText: '原因（选填）',
      success: async r => {
        if (!r.confirm) return
        wx.showLoading({ title: '处理中', mask: true })
        try {
          await call('adminUpdateCustomer', { openid, blacklisted: true, blacklistReason: r.content || '' })
          wx.hideLoading(); wx.showToast({ title: '已加入', icon: 'success' })
          this.setData({ results: [], query: '' })
          this.load()
        } catch (err) {
          wx.hideLoading(); wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
        }
      }
    })
  },
  async remove(e) {
    const openid = e.currentTarget.dataset.openid
    const name = e.currentTarget.dataset.name || openid
    wx.showModal({
      title: '移出黑名单',
      content: `确认将「${name}」移出黑名单？`,
      success: async r => {
        if (!r.confirm) return
        wx.showLoading({ title: '处理中', mask: true })
        try {
          await call('adminUpdateCustomer', { openid, blacklisted: false })
          wx.hideLoading(); wx.showToast({ title: '已移出', icon: 'success' })
          this.load()
        } catch (err) {
          wx.hideLoading(); wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
        }
      }
    })
  },
  onPhone(e) {
    const phone = e.currentTarget.dataset.phone
    if (phone) wx.makePhoneCall({ phoneNumber: phone })
  }
})
