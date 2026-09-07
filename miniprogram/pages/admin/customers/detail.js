// pages/admin/customers/detail — 单用户分析（owner / manager 可见）
// 资料/备注/标签/黑名单由 owner 操作（adminUpdateCustomer 仅 owner）。
const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

function daysAgo(ts) {
  if (!ts) return ''
  const d = Math.floor((Date.now() - ts) / 86400000)
  if (d <= 0) return '今天'
  if (d === 1) return '昨天'
  if (d < 30) return d + '天前'
  if (d < 365) return Math.floor(d / 30) + '个月前'
  return Math.floor(d / 365) + '年前'
}
function fmtDay(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function srcLabel(scene) {
  const s = Number(scene)
  if (s === 1035) return '公众号菜单'
  if (s === 1005 || s === 1150) return '搜索'
  if (s === 1007 || s === 1008 || s === 1036) return '链接分享'
  return ''
}

Page({
  behaviors: [guard],
  data: {
    role: 'none',
    openid: '',
    profile: null,
    agg: null,
    autoTags: [],
    recent: [],
    // UI
    showEdit: false,
    editName: '', editPhone: '', editRemark: '',
    newTag: '',
    isBlacklisted: false,
    blacklistReason: '',
    // 展示用
    firstAtText: '', lastAtText: '', avgPartyText: '', avgLeadText: '', weekendText: '',
    firstSourceText: '', firstLaunchText: '',
    perProjectBars: [],
    hourBars: [],
    tagsView: []
  },
  onLoad(opt) {
    const openid = (opt && opt.openid) || ''
    this.guard(['owner', 'manager']).then(role => {
      if (!role) return
      this.setData({ role, openid })
      this.load()
    })
  },
  async load() {
    wx.showLoading({ title: '加载中', mask: true })
    try {
      const d = await call('getCustomer', { openid: this.data.openid })
      const profile = d.profile || {}
      const agg = d.agg || null
      const autoTags = d.autoTags || []
      const recent = (d.recent || []).map(r => ({
        ...r,
        statusText: r.status === 'confirmed' ? '已确认'
          : (r.status === 'pending' ? '待确认' : (r.status === 'cancelled' ? '已取消' : (r.status || ''))),
        reviewText: r.review === 'approved' ? '已审核'
          : (r.review === 'rejected' ? '已驳回' : (r.review === 'pending' ? '待审核' : ''))
      }))

      let perProjectBars = []
      if (agg && agg.perProject && agg.perProject.length) {
        const sorted = agg.perProject.slice().sort((a, b) => b.cnt - a.cnt)
        const max = sorted[0].cnt || 1
        perProjectBars = sorted.map(p => ({
          name: p.name || '未命名项目', cnt: p.cnt, pct: Math.round(p.cnt / max * 100)
        }))
      }
      let hourBars = []
      if (agg && agg.sessionHour) {
        const sh = agg.sessionHour
        const maxH = Math.max(1, ...sh)
        hourBars = sh.map((c, h) => ({ h, c, pct: Math.round(c / maxH * 100) })).filter(x => x.c > 0)
      }

      this.setData({
        profile, agg, autoTags, recent, perProjectBars, hourBars,
        editName: profile.name || '', editPhone: profile.phone || '', editRemark: profile.remark || '',
        isBlacklisted: !!profile.isBlacklisted, blacklistReason: profile.blacklistReason || '',
        firstAtText: agg ? daysAgo(agg.firstAt) : '',
        lastAtText: agg ? daysAgo(agg.lastAt) : '',
        avgPartyText: agg ? (agg.avgParty || 0).toFixed(1) : '',
        avgLeadText: agg ? (agg.avgLeadDays || 0).toFixed(1) : '',
        weekendText: agg ? Math.round((agg.weekendRatio || 0) * 100) + '%' : '',
        firstSourceText: srcLabel(profile.firstSource),
        firstLaunchText: fmtDay(profile.firstLaunchAt)
      })
      this.rebuildTags()
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  /* ---------- 资料编辑（owner） ---------- */
  toggleEdit() {
    this.setData({
      showEdit: !this.data.showEdit,
      editName: this.data.profile.name || '',
      editPhone: this.data.profile.phone || '',
      editRemark: this.data.profile.remark || ''
    })
  },
  onEditName(e) { this.setData({ editName: e.detail.value }) },
  onEditPhone(e) { this.setData({ editPhone: e.detail.value }) },
  onEditRemark(e) { this.setData({ editRemark: e.detail.value }) },
  async saveProfile() {
    const { editName, editPhone, editRemark } = this.data
    if (editPhone && !/^1[3-9]\d{9}$/.test(editPhone)) {
      wx.showToast({ title: '手机号格式不正确', icon: 'none' }); return
    }
    wx.showLoading({ title: '保存中', mask: true })
    try {
      await call('adminUpdateCustomer', { openid: this.data.openid, name: editName, phone: editPhone, remark: editRemark })
      this.setData({
        'profile.name': editName, 'profile.phone': editPhone, 'profile.remark': editRemark, showEdit: false
      })
      wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' })
    } catch (err) {
      wx.hideLoading(); wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' })
    }
  },

  /* ---------- 手动标签（owner） ---------- */
  onNewTag(e) { this.setData({ newTag: e.detail.value }) },
  addTag() {
    const v = (this.data.newTag || '').trim()
    if (!v) return
    const cur = this.data.profile.tags || []
    const next = Array.from(new Set([...cur, v])).slice(-20)
    this.saveTags(next)
    this.setData({ newTag: '' })
  },
  async saveTags(tags) {
    wx.showLoading({ title: '保存中', mask: true })
    try {
      await call('adminUpdateCustomer', { openid: this.data.openid, tags })
      this.setData({ 'profile.tags': tags })
      this.rebuildTags()
      wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' })
    } catch (err) {
      wx.hideLoading(); wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' })
    }
  },
  rebuildTags() {
    const role = this.data.role
    const tagsView = (this.data.profile.tags || []).map(t => ({ t, removable: role === 'owner' }))
    this.setData({ tagsView })
  },
  removeTag(e) {
    if (this.data.role !== 'owner') return
    const t = e.currentTarget.dataset.t
    const cur = this.data.profile.tags || []
    const next = cur.filter(x => x !== t)
    this.saveTags(next)
  },

  /* ---------- 黑名单（owner） ---------- */
  toggleBlacklist(e) {
    if (this.data.role !== 'owner') return
    const on = e.detail.value
    if (on) {
      wx.showModal({
        title: '加入黑名单',
        content: '该用户将无法再预约。可填写原因（选填）。',
        editable: true, placeholderText: '拉黑原因（选填）',
        success: async r => {
          if (!r.confirm) { this.setData({ isBlacklisted: false }); return }
          await this.doBlacklist(true, r.content || '')
        }
      })
    } else {
      wx.showModal({
        title: '移出黑名单', content: '确认恢复该用户预约权限？',
        success: async r => {
          if (!r.confirm) { this.setData({ isBlacklisted: true }); return }
          await this.doBlacklist(false, '')
        }
      })
    }
  },
  async doBlacklist(on, reason) {
    wx.showLoading({ title: '处理中', mask: true })
    try {
      await call('adminUpdateCustomer', { openid: this.data.openid, blacklisted: on, blacklistReason: reason })
      this.setData({ isBlacklisted: on, blacklistReason: reason })
      wx.hideLoading(); wx.showToast({ title: on ? '已加入黑名单' : '已移出黑名单', icon: 'success' })
    } catch (err) {
      wx.hideLoading(); wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
      this.setData({ isBlacklisted: !on })
    }
  },

  onPhone(e) {
    const phone = e.currentTarget.dataset.phone
    if (phone) wx.makePhoneCall({ phoneNumber: phone })
  },
  callDetailPhone() {
    const phone = this.data.profile && this.data.profile.phone
    if (phone) wx.makePhoneCall({ phoneNumber: phone })
  },
  reload() { this.load() }
})
