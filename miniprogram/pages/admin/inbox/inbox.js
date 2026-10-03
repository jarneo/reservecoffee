const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

const p2 = n => String(n).padStart(2, '0')
const WK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// 毫秒时间戳 → 「刚刚 / N 分钟前 / 今天 14:05 / 昨天 14:05 / 10-03 14:05 / 2025-10-03」
// ⚠️ 云函数容器是 UTC，但这里只做**显示**，前端本身就在用户时区，可直接用本地 Date。
function relTime(ts) {
  if (!ts) return ''
  const d = new Date(Number(ts))
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
  const hm = p2(d.getHours()) + ':' + p2(d.getMinutes())
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, now)) return '今天 ' + hm
  const y = new Date(now.getTime() - 24 * 3600 * 1000)
  if (sameDay(d, y)) return '昨天 ' + hm
  if (d.getFullYear() === now.getFullYear()) return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + hm
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}

// 「2026-10-03」→「10-03」；非标准格式原样返回
function md(date) {
  const s = String(date || '')
  const m = s.match(/^\d{4}-(\d{2})-(\d{2})/)
  return m ? m[1] + '-' + m[2] : s
}

// WXML 不能调 JS（indexOf/map 恒 falsy）→ 展示字段一律在 JS 里预计算
// 「5 → ★★★★★」；评价提醒的副行要显示星级
function stars(n) {
  const c = Math.max(0, Math.min(5, Math.round(Number(n) || 0)))
  return '★'.repeat(c) + '☆'.repeat(5 - c)
}

Page({
  behaviors: [guard],
  data: {
    tab: 'all',        // all | unread
    list: [],          // 已整形的展示列表
    unread: 0,
    total: 0,
    page: 1,
    hasMore: false,
    loading: false,
    emptyText: '加载中…',

    // ===== 待处理（实时计数，与列表内容无关）=====
    pendRes: 0,        // 待审核预约（review pending 且 status pending）
    pendDish: 0,       // 待审核评价（reviewStatus pending）

    // ===== 顶部「预约情况」看板 =====
    bkLoading: true,
    bkDays: [],        // 日期条：[{date, md, wk, has, today, sel}]
    bkProjs: [],       // 表格列头（已发布项目）
    bkRows: [],        // 表格行：[{tm, cells:[{txt, cls, k}]}]
    bkTotals: [],      // 合计行（每项目当日已约人数）
    bkSum: '',         // 「10-03 · 合计 11 人 / 2 场」
    bkEmpty: '',       // 看板空态文案（无项目 / 该日无场次）
    selDate: ''
  },
  onLoad() {
    this.guard(['owner', 'manager']).then(role => {
      if (role) { this.reload(); this.loadBoard() }
    })
  },
  // 从详情返回时刷新：详情会把该条标记为已读，列表必须同步（否则红点不消失）
  // ⚠️ 首次 onShow 紧跟 onLoad，此时数据已在 onLoad 里加载过，用 _shown 跳过避免重复请求
  onShow() {
    if (this._shown) this.reload()
    this._shown = true
  },
  onPullDownRefresh() {
    Promise.all([this.reload(), this.loadBoard()])
      .then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh())
  },
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.more()
  },

  // ---------- 通知列表 ----------
  reload() {
    this.setData({ page: 1, loading: true })
    return call('getInbox', { page: 1, onlyUnread: this.data.tab === 'unread' })
      .then(d => {
        const list = (d && d.list) || []
        const pend = (d && d.pending) || {}
        this.setData({
          list: list.map(this.decorate),
          unread: (d && d.unread) || 0,
          total: (d && d.total) || 0,
          pendRes: pend.res || 0,
          pendDish: pend.dish || 0,
          hasMore: !!(d && d.hasMore),
          loading: false,
          emptyText: this.data.tab === 'unread' ? '暂无未读通知' : '暂无通知'
        })
      })
      .catch(() => {
        this.setData({ loading: false, emptyText: '加载失败，下拉重试' })
      })
  },
  more() {
    const next = this.data.page + 1
    this.setData({ loading: true })
    return call('getInbox', { page: next, onlyUnread: this.data.tab === 'unread' })
      .then(d => {
        const add = ((d && d.list) || []).map(this.decorate)
        this.setData({
          list: this.data.list.concat(add),
          page: next,
          hasMore: !!(d && d.hasMore),
          loading: false
        })
      })
      .catch(() => { this.setData({ loading: false }) })
  },
  // WXML 不能调 JS（indexOf/map 恒 falsy）→ 展示字段一律在 JS 里预计算
  decorate(it) {
    // 评价类：字段与预约类完全不同，单独一条支路
    if (it.type === 'reviewDish') {
      return Object.assign({}, it, {
        // 「评论审核 · 提拉米苏」
        title: '评论审核 · ' + (it.productName || '菜品'),
        tagText: '评论审核',
        // ⚠️ 用 dish（品牌色浅底）而不是 wait（实心）：评论审核不影响名额，
        //    实心留给「预约审核」（它占着名额，最该先处理）→ 两类一眼可分主次。
        tagCls: 'dish',
        // ★★★★★　小李　这款甜品口感细腻…
        sub: [stars(it.rating), it.customerName || '', it.text || ''].filter(Boolean).join('　'),
        time: relTime(it.createdAt) + (it.imageCount ? '　·　' + it.imageCount + ' 张图' : ''),
        byAdminText: ''
      })
    }
    const isCancel = it.type === 'cancel'
    const isReview = it.type === 'reviewRes'
    return Object.assign({}, it, {
      // 「新预约 · 法兰绒深烘咖啡」/「取消预约 · 清酒品鉴」/「预约审核 · 法兰绒深烘咖啡」
      title: (isCancel ? '取消预约' : (isReview ? '预约审核' : '新预约')) + ' · ' + (it.projectName || '预约'),
      tagText: isCancel ? '取消' : (isReview ? '预约审核' : '新建'),
      // tagCls 预计算（WXML 里写三元表达式可读性差，且类型一多容易漏）
      tagCls: isCancel ? 'cancel' : (isReview ? 'wait' : ''),
      // 10-03 14:00-16:00　张先生　2 人
      sub: [md(it.date), it.sessionStart && it.sessionEnd ? it.sessionStart + '-' + it.sessionEnd : '',
        it.customerName || '', (it.count || 1) + ' 人'].filter(Boolean).join('　'),
      time: relTime(it.createdAt),
      // 管理员自己取消的，标出来（顾客取消才需要立刻处理）
      byAdminText: isCancel && it.byAdmin ? '管理员取消' : ''
    })
  },
  switchTab(e) {
    const t = e.currentTarget.dataset.t
    if (t === this.data.tab) return
    this.setData({ tab: t }, () => this.reload())
  },
  readAll() {
    if (!this.data.unread) { wx.showToast({ title: '没有未读通知', icon: 'none' }); return }
    wx.showModal({
      title: '全部已读',
      content: `将把 ${this.data.unread} 条未读通知标记为已读（只影响你自己，其他管理员不受影响）。`,
      success: r => {
        if (!r.confirm) return
        wx.showLoading({ title: '处理中', mask: true })
        call('markInboxRead', {}).then(d => {
          wx.hideLoading()
          wx.showToast({ title: `已标记 ${(d && d.count) || 0} 条`, icon: 'none' })
          this.reload()
        }).catch(() => {
          wx.hideLoading()
          wx.showToast({ title: '操作失败', icon: 'none' })
        })
      }
    })
  },
  open(e) {
    const i = Number(e.currentTarget.dataset.i)
    const it = this.data.list[i]
    if (!it) return
    wx.navigateTo({ url: '/pages/admin/inbox/detail?id=' + it._id })
  },

  // ---------- 待处理入口（实时计数，点击直达对应审核页）----------
  goReview() {
    if (!this.data.pendRes) { wx.showToast({ title: '暂无待审核预约', icon: 'none' }); return }
    wx.navigateTo({ url: '/pages/admin/review/review' })
  },
  goReviewDish() {
    if (!this.data.pendDish) { wx.showToast({ title: '暂无待审核评价', icon: 'none' }); return }
    wx.navigateTo({ url: '/pages/admin/reviewAdmin/reviewAdmin' })
  },

  // ---------- 顶部「预约情况」看板 ----------
  // 一次拉回未来 14 天全部数据，之后切日期纯本地，不再发请求
  loadBoard() {
    this.setData({ bkLoading: true })
    return call('getBookingBoard', {}).then(d => {
      const projects = (d && d.projects) || []
      const days = (d && d.days) || []
      const board = (d && d.board) || {}
      const today = (d && d.today) || ''

      this._board = board
      this._projects = projects

      const selDate = this.data.selDate || today
      const bkDays = days.map(x => {
        const p = String(x.date || '').split('-').map(Number)
        const w = p.length === 3 ? WK[new Date(p[0], p[1] - 1, p[2]).getDay()] : ''
        return {
          date: x.date, md: md(x.date), wk: w,
          has: !!x.has, today: x.date === today,
          sel: x.date === selDate
        }
      })

      this.setData({ bkLoading: false, bkProjs: projects, bkDays, selDate }, () => {
        this.applyBoard(selDate, projects, board)
      })
    }).catch(() => {
      this.setData({ bkLoading: false, bkEmpty: '预约情况加载失败，下拉重试' })
    })
  },
  onBkDate(e) {
    const d = e.currentTarget.dataset.d
    if (!d || d === this.data.selDate) return
    const bkDays = this.data.bkDays.map(x => Object.assign({}, x, { sel: x.date === d }))
    this.setData({ selDate: d, bkDays }, () => {
      this.applyBoard(d, this._projects || [], this._board || {})
    })
  },
  // 把某日的 board 数据翻成 WXML 能直接渲染的结构（WXML 不能调 JS，也不能做下标运算）
  applyBoard(date, projects, board) {
    const b = board[date]
    if (!b || !b.rows || !b.rows.length) {
      this.setData({
        bkRows: [], bkTotals: [],
        bkSum: md(date),
        bkEmpty: (projects && projects.length) ? '该日暂无可预约场次' : '暂无已发布项目'
      })
      return
    }
    const bkRows = b.rows.map(r => ({
      tm: r.tm,
      cells: r.cells.map((c, i) => {
        if (!c) return { txt: '—', cls: 'none', k: i }
        if (c.paused) return { txt: '暂停', cls: 'pause', k: i }
        const full = c.capacity > 0 && c.booked >= c.capacity
        return {
          txt: c.booked + '/' + c.capacity,
          cls: full ? 'full' : (c.booked > 0 ? 'has' : 'empty'),
          k: i
        }
      })
    }))
    const bkTotals = (b.totals || []).map((n, i) => {
      const any = b.rows.some(r => r.cells && r.cells[i])
      return any ? (n + ' 人') : '—'
    })
    this.setData({
      bkRows,
      bkTotals,
      bkSum: md(date) + ' · 合计 ' + (b.people || 0) + ' 人 / ' + (b.sessions || 0) + ' 场',
      bkEmpty: ''
    })
  }
})
