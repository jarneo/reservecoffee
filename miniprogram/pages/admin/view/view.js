const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')
const { ymd } = require('../../../utils/util')

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const STEP = 5   // 箭头每按一次滚动的日期个数

Page({
  behaviors: [guard],
  data: { projects: [], projectId: '', projectName: '', dates: [], dateChips: [], dateAnchorIdx: 0, scrollInto: '', canPrev: false, canNext: false, dateRangeLabel: '', selDate: '', sessions: [], selSession: '', list: [], detail: null, sessionExpired: false },
  onLoad(q) { this.q = q || {}; this.guard(['owner', 'manager']).then(r => { if (r) this.loadProjects() }) },
  loadProjects() {
    call('listProjects').then(d => {
      const list = d.list || []
      this.setData({ projects: list })
      if (!list.length) return
      const target = (this.q.projectId && list.find(x => x._id === this.q.projectId)) ? this.q.projectId : list[0]._id
      this.select(target)
    })
  },
  onPick(e) { this.select(this.data.projects[e.detail.value]._id) },
  async select(id) {
    const sel = (this.data.projects || []).find(x => x._id === id)
    this.setData({ projectId: id, projectName: sel ? sel.name : '' })
    const d = await call('getSchedule', { projectId: id })
    const dates = (d.schedules || []).map(s => s.date).sort()
    const start = (this.q.date && dates.indexOf(this.q.date) >= 0) ? this.q.date : (dates[0] || '')
    const built = this.buildChips(dates, start, 0)
    const n = dates.length
    this.setData({
      dates, dateChips: built.chips, dateRangeLabel: built.range,
      dateAnchorIdx: 0, canPrev: false, canNext: n - 1 >= STEP, scrollInto: n ? 'dc0' : ''
    })
    if (dates.length) this.loadDate(start)
  },
  onDate(e) { this.loadDate(e.currentTarget.dataset.ymd) },
  // 构建日期条 chips（与预约页一致：月/周/日、今天高亮、选中黑底、可约黑边）
  buildChips(dates, selDate, anchorIdx) {
    const todayStr = ymd(new Date())
    const chips = (dates || []).map((iso, i) => {
      const [y, m, dd] = iso.split('-').map(Number)
      const cur = new Date(y, m - 1, dd)
      const pp = i > 0 ? dates[i - 1].split('-').map(Number) : null
      const prev = pp ? new Date(pp[0], pp[1] - 1, pp[2]) : null
      const mo = (!prev || prev.getMonth() !== cur.getMonth()) ? (cur.getMonth() + 1) + '月' : ''
      return {
        ymd: iso,
        wk: iso === todayStr ? '今天' : '周' + WEEK[cur.getDay()],
        dd: cur.getDate(),
        mo,
        open: true,
        today: iso === todayStr,
        sel: iso === selDate
      }
    })
    const n = chips.length
    const a0 = n ? chips[Math.min(anchorIdx, n - 1)].ymd : ''
    const a1 = n ? chips[Math.min(anchorIdx + STEP - 1, n - 1)].ymd : ''
    const range = (a0 && a1) ? this.fmtRange(a0, a1) : ''
    return { chips, range }
  },
  fmtRange(a, b) {
    const [ay, am, ad] = a.split('-').map(Number)
    const [by, bm, bd] = b.split('-').map(Number)
    return am + '/' + ad + ' – ' + bm + '/' + bd
  },
  // 左右箭头：在已有日期间翻页滚动（与预约页翻页手感一致）
  moveDate(e) {
    const delta = Number(e.currentTarget.dataset.delta) || 1
    const n = this.data.dateChips.length
    if (!n) return
    if (delta < 0 && !this.data.canPrev) return
    if (delta > 0 && !this.data.canNext) return
    const idx = Math.max(0, Math.min(n - 1, this.data.dateAnchorIdx + delta * STEP))
    this.setData({ dateAnchorIdx: idx, canPrev: idx > 0, canNext: idx < n - 1, scrollInto: 'dc' + idx })
  },
  async loadDate(date) {
    this.setData({ selDate: date, selSession: '', list: [], detail: null })
    const chips = this.data.dateChips.map(c => ({ ...c, sel: c.ymd === date }))
    const idx = this.data.dateChips.findIndex(c => c.ymd === date)
    this.setData({ dateChips: chips, scrollInto: idx >= 0 ? 'dc' + idx : '' })
    const d = await call('getSchedule', { projectId: this.data.projectId, date })
    const sch = (d.schedules || []).find(x => x.date === date)
    const sessions = (sch ? sch.sessions : []).map(x => ({ ...x, remaining: x.capacity - x.booked }))
    this.setData({ sessions })
    const sid = (this.q.sessionId && sessions.find(x => x.id === this.q.sessionId)) ? this.q.sessionId : ''
    if (sid) this.loadList(sid)
    this.q = {}   // 仅首次从「预约管理」跳入时自动定位，之后用户手动浏览不再强制
  },
  onSession(e) { this.loadList(e.currentTarget.dataset.id) },
  async loadList(sessionId) {
    this.setData({ selSession: sessionId, detail: null })
    const d = await call('listSessionReservations', { projectId: this.data.projectId, date: this.data.selDate, sessionId })
    // 场次是否已过（结束时间早于现在）→ 过期场次不可取消
    const sess = (this.data.sessions || []).find(x => x.id === sessionId)
    const expired = sess ? this.isSessionPast(this.data.selDate, sess.end) : true
    this.setData({ list: d.list || [], sessionExpired: expired })
  },
  // 场次是否已成过去（按场次结束时间判断）；用于决定是否展示「取消预约」
  isSessionPast(dateStr, endStr) {
    const [y, m, d] = String(dateStr || '').split('-').map(Number)
    const [hh, mm] = String(endStr || '').split(':').map(Number)
    if (!y) return true
    const end = new Date(y, m - 1, d, hh || 0, mm || 0)
    return Date.now() > end.getTime()
  },
  // 管理员代取消本场某条预约（释放名额 + 通知双方）；仅未过期场次可取消
  onCancel(e) {
    const id = e.currentTarget.dataset.id
    const item = (this.data.list || []).find(x => x._id === id)
    wx.showModal({
      title: '取消预约',
      content: `确认取消「${item ? item.name : '该顾客'}」本场预约？将释放名额并通知双方。`,
      confirmText: '取消预约', confirmColor: '#e34d59',
      success: async (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '取消中', mask: true })
        try {
          await call('cancelReservation', { reservationId: id })
          const list = this.data.list.filter(x => x._id !== id)
          const detail = (this.data.detail && this.data.detail._id === id) ? null : this.data.detail
          this.setData({ list, detail })
          await this.refreshSessions()
          wx.hideLoading(); wx.showToast({ title: '已取消', icon: 'success' })
        } catch (err) {
          wx.hideLoading(); wx.showToast({ title: (err && err.message) || '取消失败', icon: 'none' })
        }
      }
    })
  },
  // 重新拉取当前日期场次（刷新已约 / 剩余名额）
  async refreshSessions() {
    const d = await call('getSchedule', { projectId: this.data.projectId, date: this.data.selDate })
    const sch = (d.schedules || []).find(x => x.date === this.data.selDate)
    const sessions = (sch ? sch.sessions : []).map(x => ({ ...x, remaining: x.capacity - x.booked }))
    this.setData({ sessions })
  },
  showDetail(e) {
    const id = e.currentTarget.dataset.id
    const r = (this.data.list || []).find(x => x._id === id)
    this.setData({ detail: r })
  },
  closeDetail() { this.setData({ detail: null }) },
  dial() { if (this.data.detail) wx.makePhoneCall({ phoneNumber: this.data.detail.phone }) }
})
