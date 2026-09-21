// pages/admin/aiLogs — AI 对话记录浏览（owner/manager 可见，导出仅 owner）
// 每条记录来自 aiReserve 异步写入的 aiLogs 集合：提问 / 小曜回答 / 意图 / 抽取槽位 / 模型用量。
const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

// 北京时间格式化（云函数存的是服务端时间，+8h 还原为本地展示）
function fmt(ts) {
  if (!ts) return ''
  const ms = (ts instanceof Date) ? ts.getTime() : Date.parse(ts)
  if (isNaN(ms)) return ''
  const d = new Date(ms + 8 * 3600 * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

Page({
  behaviors: [guard],
  data: {
    role: 'none',
    list: [],
    page: 1,
    hasMore: false,
    loading: false,
    intent: 'all',     // all / chat / ask / confirm
    keyword: '',
    from: '',
    to: '',
    expandedId: '',
    // 导出预览
    showExport: false,
    exportCsv: '',
    exportCount: 0
  },
  onLoad() {
    this.guard(['owner', 'manager']).then(role => {
      if (!role) return
      this.setData({ role })
      this.load(true)
    })
  },
  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh())
  },
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.load(false)
  },
  async load(reset) {
    if (this.data.loading) return
    const page = reset ? 1 : this.data.page + 1
    this.setData({ loading: true })
    try {
      const d = await call('getAiLogs', {
        page, intent: this.data.intent,
        keyword: this.data.keyword, from: this.data.from, to: this.data.to
      })
      const rows = (d.list || []).map(r => ({
        ...r,
        timeText: fmt(r.createdAt),
        slotsText: r.slots ? JSON.stringify(r.slots) : ''
      }))
      const list = reset ? rows : this.data.list.concat(rows)
      this.setData({ list, page, hasMore: d.hasMore, loading: false })
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
    }
  },
  setIntent(e) {
    const v = e.currentTarget.dataset.v
    if (v === this.data.intent) return
    this.setData({ intent: v })
    this.load(true)
  },
  onKeyword(e) { this.setData({ keyword: e.detail.value }) },
  search() { this.load(true) },
  clearKw() { this.setData({ keyword: '' }); this.load(true) },
  onFrom(e) { this.setData({ from: e.detail.value }); this.load(true) },
  onTo(e) { this.setData({ to: e.detail.value }); this.load(true) },
  toggleExpand(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ expandedId: this.data.expandedId === id ? '' : id })
  },
  async doExport() {
    if (this.data.role !== 'owner') {
      wx.showToast({ title: '仅超级管理员可导出', icon: 'none' })
      return
    }
    wx.showLoading({ title: '生成中' })
    try {
      const d = await call('exportData', { type: 'ai', from: this.data.from, to: this.data.to })
      this.setData({ showExport: true, exportCsv: d.csv || '', exportCount: d.count || 0 })
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '导出失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },
  copyCsv() {
    wx.setClipboardData({
      data: this.data.exportCsv,
      success: () => wx.showToast({ title: '已复制，可粘贴到 Excel', icon: 'none' })
    })
  },
  closeExport() { this.setData({ showExport: false }) },
  noop() {}
})
