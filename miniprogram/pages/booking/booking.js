const { call } = require('../../utils/cloud')
const { ymd, isSessionExpired } = require('../../utils/util')

function addDaysDate(n) { const t = new Date(); t.setDate(t.getDate() + n); return t }

Page({
  data: {
    projectId: '', project: {}, introImages: [], schedules: [], openDays: [], advanceDays: 7,
    dateAnchor: '', dateChips: [], dateRangeLabel: '', canPrev: false,
    selectedDate: '', bizWindow: '', sessions: [],
    showSeatInfo: true
  },

  onLoad(q) {
    const pid = q.projectId || ''
    this.setData({
      projectId: pid,
      dateAnchor: '', selectedDate: '', sessions: [], bizWindow: ''
    })
    // 埋点：查看项目详情（转化漏斗第2层）
    this.track('view_project', pid)
    this.load()
  },

  // 埋点上报：写 events 集合供数据分析漏斗使用。失败静默，绝不影响预约主流程
  track(type, projectId) {
    try {
      call('trackEvent', { type, projectId: projectId || '' }).catch(() => {})
    } catch (e) { /* ignore */ }
  },

  load() {
    call('getProject', { projectId: this.data.projectId })
      .then(d => {
        const p = d.project
        const sched = d.schedules || []
        const openDays = p.openDays || []
        const adv = p.advanceDays || 7
        this.setData({
          project: p, introImages: p.introImages || [], schedules: sched,
          openDays, advanceDays: adv, showSeatInfo: p.showSeatInfo !== false
        }, () => {
          this.buildDateChips()
          // 默认展开「离当天最近、且确有可选场次」的可约日（今天若有可选场次则为今天，否则向后取第一个）
          this.autoSelectFirst()
        })
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },

  // 计算「离当天最近、且确有可选场次」的可约日（在提前预约窗口内）
  // 候选 = openDays ∩ 有场次 ∩ 未整体暂停 ∩ 存在「未暂停 / 未过期 / 未满」的场次
  nearestOpenDate() {
    const todayStr = ymd(new Date())
    const maxWin = ymd(addDaysDate(this.data.advanceDays))
    const openDays = this.data.openDays
    const projPaused = !!this.data.project.paused
    const cutoff = this.data.project.cutoff
    return (this.data.schedules || [])
      .filter(s => {
        if (s.date < todayStr || s.date > maxWin) return false
        if (openDays.indexOf(s.date) < 0 || s.closed || projPaused) return false
        const sess = s.sessions || []
        if (!sess.length) return false
        return sess.some(x => !x.paused && !isSessionExpired(s.date, x.start, cutoff) && (x.capacity - x.booked) > 0)
      })
      .map(s => s.date)
      .sort()[0] || null
  },

  // 自动选中并展开「离当天最近的可约日」（仅首次进入时）
  autoSelectFirst() {
    if (this.data.selectedDate) return
    const d = this.nearestOpenDate()
    if (!d) return
    // 若该日不在当前 14 天可视条内（较远的可约日），先把锚点移到它，确保顾客看得到
    if (!(this.data.dateChips || []).some(c => c.ymd === d)) {
      this.setData({ dateAnchor: d })
      this.buildDateChips()
    }
    this.selectDay(d)
  },

  // 横向日期条：固定 14 天（两周），以 dateAnchor 为起点
  buildDateChips() {
    const openDays = this.data.openDays
    // 已配置场次的日期集合：只显示「既开放、又有场次」的日期，避免顾客点到无场次日无法预约
    const schedDates = new Set((this.data.schedules || []).map(s => s.date))
    // 日期 → 场次列表，便于计算「当日整体状态」
    const schedMap = {}
    const closedMap = {}
    ;(this.data.schedules || []).forEach(s => { schedMap[s.date] = s.sessions || []; closedMap[s.date] = !!s.closed })
    const projPaused = !!this.data.project.paused
    const adv = this.data.advanceDays || 7
    const now = new Date()
    const todayStr = ymd(now)
    const maxWin = ymd(addDaysDate(adv))            // 可预约窗口上限（含）
    let anchorStr = this.data.dateAnchor || todayStr
    if (anchorStr < todayStr) anchorStr = todayStr   // 不允许翻到今天之前
    const [ay, am, ad] = anchorStr.split('-').map(Number)
    const anchor = new Date(ay, am - 1, ad)
    const WD = ['日', '一', '二', '三', '四', '五', '六']
    const tmrStr = ymd(addDaysDate(1))
    const chips = []
    let prevMonth = -1
    for (let i = 0; i < 14; i++) {
      const cur = new Date(anchor); cur.setDate(anchor.getDate() + i)
      const iso = ymd(cur)
      const inWin = iso <= maxWin
      const isOpen = openDays.indexOf(iso) >= 0 && schedDates.has(iso) && inWin
      const isToday = iso === todayStr
      const isTmr = iso === tmrStr
      const wk = isToday ? '今天' : (isTmr ? '明天' : '周' + WD[cur.getDay()])
      const md = `${String(cur.getMonth() + 1).padStart(2, '0')}/${String(cur.getDate()).padStart(2, '0')}`
      const sel = iso === this.data.selectedDate
      // 当日整体状态（仅对可约日有意义）：项目暂停 → 全部暂停；否则看当日场次
      let status = ''
      if (isOpen) {
        if (projPaused || closedMap[iso]) status = 'paused'
        else {
          const sess = schedMap[iso] || []
          if (sess.length) {
            const allPaused = sess.every(x => x.paused)
            const allFull = sess.every(x => (x.capacity - x.booked) <= 0)
            const allExpired = sess.every(x => isSessionExpired(iso, x.start, this.data.project.cutoff))
            if (allPaused) status = 'paused'
            else if (allExpired) status = 'expired'
            else if (allFull) status = 'full'
          }
        }
      }
      chips.push({ ymd: iso, wk, md, open: isOpen, today: isToday, sel, status })
    }
    const a0 = new Date(anchor)
    const a1 = new Date(anchor); a1.setDate(a1.getDate() + 13)
    const rangeLabel = `${String(a0.getMonth() + 1).padStart(2, '0')}/${String(a0.getDate()).padStart(2, '0')} – ${String(a1.getMonth() + 1).padStart(2, '0')}/${String(a1.getDate()).padStart(2, '0')}`
    const canPrev = anchorStr > todayStr
    this.setData({ dateChips: chips, dateRangeLabel: rangeLabel, canPrev, dateAnchor: anchorStr })
  },

  // 点击某一天：校验可约 + 取场次
  pickDate(e) {
    const y = e.currentTarget.dataset.ymd
    if (!y) return
    if (this.data.openDays.indexOf(y) < 0) return wx.showToast({ title: '该日暂未开放', icon: 'none' })
    const max = ymd(addDaysDate(this.data.advanceDays))
    if (y > max) return wx.showToast({ title: '超出可预约范围（提前 ' + this.data.advanceDays + ' 天）', icon: 'none' })
    this.selectDay(y)
  },

  // 取某日场次并展开（供点击与默认展开共用）
  selectDay(y) {
    const s = this.data.schedules.find(x => x.date === y)
    const dayClosed = !!(s && s.closed)
    const sessions = (s ? s.sessions : []).map(x => ({
      ...x,
      remaining: x.capacity - x.booked,
      blocked: !!this.data.project.paused || dayClosed,   // 项目整体暂停 或 当日整体暂停 时，所有场次视为不可选
      expired: isSessionExpired(y, x.start, this.data.project.cutoff)  // 已过预约截止规则 → 已过期，不可选
    }))
    let win = ''
    if (s && s.sessions.length) {
      const starts = s.sessions.map(t => t.start).sort()
      const ends = s.sessions.map(t => t.end).sort()
      win = starts[0] + ' – ' + ends[ends.length - 1]
    }
    this.setData({ selectedDate: y, sessions, bizWindow: win }, () => this.buildDateChips())
  },

  // 左右箭头翻页（±14 天），左翻到今天页时禁用
  moveDate(e) {
    const delta = Number(e.currentTarget.dataset.delta) || 14
    if (delta < 0 && !this.data.canPrev) return
    const todayStr = ymd(new Date())
    let anchorStr = this.data.dateAnchor || todayStr
    const [ay, am, ad] = anchorStr.split('-').map(Number)
    const anchor = new Date(ay, am - 1, ad)
    anchor.setDate(anchor.getDate() + delta)
    let na = ymd(anchor)
    if (na < todayStr) na = todayStr
    this.setData({ dateAnchor: na, selectedDate: '', sessions: [], bizWindow: '' }, () => this.buildDateChips())
  },

  // 点击介绍图放大预览
  previewIntro(e) {
    const i = e.currentTarget.dataset.i
    const imgs = this.data.introImages
    const urls = imgs.map(x => x.url).filter(Boolean)
    if (!urls.length) return
    wx.previewImage({ current: urls[i] || urls[0], urls })
  },

  pickSession(e) {
    const sid = e.currentTarget.dataset.id
    const s = this.data.sessions.find(x => x.id === sid)
    // 项目整体暂停 / 当日整体暂停 / 场次暂停 / 已满 / 已过期 均不可选
    if (!s || this.data.project.paused || s.paused || s.blocked || s.expired || s.remaining <= 0) return
    // 埋点：点击预约（转化漏斗第3层）——选中场次即进入确认页
    this.track('click_book', this.data.projectId)
    wx.navigateTo({ url: `/pages/confirm/confirm?projectId=${this.data.projectId}&date=${this.data.selectedDate}&sessionId=${sid}` })
  },

  // 转发给好友 / 分享朋友圈：分享当前预约项目
  onShareAppMessage() {
    const p = this.data.project || {}
    return {
      title: p.name || '二曜路8号咖啡和清酒 · 预约',
      path: '/pages/booking/booking?projectId=' + (this.data.projectId || '')
    }
  },
  onShareTimeline() {
    const p = this.data.project || {}
    return {
      title: p.name || '二曜路8号咖啡和清酒 · 预约',
      query: 'projectId=' + (this.data.projectId || '')
    }
  }
})
