// pages/admin/customers/customers — 顾客名录（预约人明细）
// owner / manager 可见；聚合 getCustomers，支持本地搜索 + 固定条件筛选 + 排序。
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

// 固定筛选条件（值为后端返回的布尔/数值字段判定）
const FILTERS = {
  all: { label: '全部', test: () => true },
  today: { label: '当日预约', test: c => c.hasTodayReserve },
  cancelToday: { label: '当天取消', test: c => c.cancelToday > 0 },
  black: { label: '黑名单', test: c => c.isBlacklisted },
  cross: { label: '跨项目', test: c => c.projectCount >= 2 },
  new: { label: '新客', test: c => c.isNew }
}
// 排序（desc 居多；first 为最早预约升序）
const SORTS = {
  total: { label: '预约最多', cmp: (a, b) => (b.total || 0) - (a.total || 0) },
  last: { label: '最近预约', cmp: (a, b) => (b.lastAt || 0) - (a.lastAt || 0) },
  first: { label: '最早预约', cmp: (a, b) => (a.firstAt || 0) - (b.firstAt || 0) },
  cancel: { label: '取消最多', cmp: (a, b) => (b.cancelCount || 0) - (a.cancelCount || 0) }
}

Page({
  behaviors: [guard],
  data: {
    role: 'none',
    query: '',
    list: [],
    loading: false,
    filter: 'all',
    sort: 'total',
    filterDefs: Object.keys(FILTERS).map(k => ({ key: k, label: FILTERS[k].label })),
    sortDefs: Object.keys(SORTS).map(k => ({ key: k, label: SORTS[k].label })),
    blackCount: 0
  },
  onLoad() {
    this.guard(['owner', 'manager']).then(role => {
      if (!role) return
      this.setData({ role })
      this.loadAll()
    })
  },
  // 拉取全部顾客（分页累积，便于本地搜索/筛选/排序完整），再应用筛选
  async loadAll() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const all = []
      let page = 1
      while (true) {
        const d = await call('getCustomers', { page })
        const rows = (d && d.list) || []
        all.push(...rows)
        if (!d || !d.hasMore) break
        page++
      }
      this.all = all
      this.setData({ blackCount: all.filter(c => c.isBlacklisted).length })
      this.apply()
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },
  onSearch(e) {
    this.setData({ query: e.detail.value })
    this.apply()
  },
  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.k })
    this.apply()
  },
  setSort(e) {
    this.setData({ sort: e.currentTarget.dataset.k })
    this.apply()
  },
  apply() {
    const q = (this.data.query || '').trim().toLowerCase()
    const fKey = this.data.filter
    const sKey = this.data.sort
    let src = this.all || []
    if (fKey !== 'all') src = src.filter(FILTERS[fKey].test)
    if (q) {
      src = src.filter(c => {
        const hay = [
          c.name, c.phone, c.remark,
          (c.tags || []).join(' '),
          (c.autoTags || []).join(' ')
        ].join(' ').toLowerCase()
        return hay.indexOf(q) >= 0
      })
    }
    const list = src.slice().sort(SORTS[sKey].cmp).map(c => ({
      ...c,
      firstAtText: daysAgo(c.firstAt),
      lastAtText: daysAgo(c.lastAt),
      autoTags2: (c.autoTags || []).slice(0, 2),
      cancelBadge: c.cancelCount > 0 ? ('取消' + c.cancelCount) : ''
    }))
    this.setData({ list })
  },
  goDetail(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) return
    wx.navigateTo({ url: '/pages/admin/customers/detail?openid=' + openid })
  },
  // 设为管理员（owner 专属）：复用 addAdmin 云函数，授权为 manager，成功后刷新名录
  async setAdmin(e) {
    const { openid, name } = e.currentTarget.dataset
    if (!openid) return
    const confirmed = await new Promise(res => wx.showModal({
      title: '设为管理员',
      content: '将「' + (name || '该顾客') + '」设为普通管理员（manager）？\n授权后对方将获得管理端入口。',
      success: x => res(x.confirm)
    }))
    if (!confirmed) return
    wx.showLoading({ title: '处理中', mask: true })
    try {
      await call('addAdmin', { openid, role: 'manager' })
      wx.showToast({ title: '已设为管理员', icon: 'none' })
      this.loadAll()
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },
  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh())
  }
})
