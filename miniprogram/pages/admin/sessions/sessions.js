const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')
const { ymd } = require('../../../utils/util')

function addDaysDate(n) { const t = new Date(); t.setDate(t.getDate() + n); return t }

Page({
  behaviors: [guard],
  data: {
    role: 'none', projects: [], projectId: '', projectName: '',
    scheduleDates: [], dateAnchor: '', dateChips: [], dateRangeLabel: '', canPrev: false,
    selDate: '', sessions: [], canChangeCap: false,
    peopleShow: false, peopleTitle: '', peopleLoading: false, list: [], detail: null,
    peopleExpired: false
  },
  onLoad() {
    this.guard(['owner', 'manager']).then(role => {
      if (!role) return
      this.setData({ role, canChangeCap: role === 'owner' || role === 'manager' })
      this.loadProjects()
    })
  },
  loadProjects() {
    call('listProjects').then(d => {
      const list = d.list || []
      this.setData({ projects: list })
      if (list.length) this.select(list[0]._id)
    })
  },
  onPick(e) { this.select(this.data.projects[e.detail.value]._id) },
  async select(id) {
    const sel = (this.data.projects || []).find(x => x._id === id)
    this.setData({ projectId: id, projectName: sel ? sel.name : '', dateAnchor: '', selDate: '', sessions: [] })
    const d = await call('getSchedule', { projectId: id })
    const scheduleDates = (d.schedules || []).map(s => s.date).sort()
    this.setData({ scheduleDates }, () => {
      this.buildDateChips()
      // 自动选中今天及之后第一个有场次的日期
      const todayStr = ymd(new Date())
      const firstHas = scheduleDates.find(x => x >= todayStr)
      if (firstHas) this.loadDate(firstHas)
    })
  },
  onDate(e) {
    const y = e.currentTarget.dataset.ymd
    if (this.data.scheduleDates.indexOf(y) < 0) return
    this.loadDate(y)
  },
  async loadDate(date) {
    this.setData({ selDate: date })
    const d = await call('getSchedule', { projectId: this.data.projectId, date })
    const sch = (d.schedules || []).find(x => x.date === date)
    this.setData({ sessions: (sch ? sch.sessions : []).map(x => ({ ...x, remaining: x.capacity - x.booked })) }, () => this.buildDateChips())
  },
  // 横向日期条：以 dateAnchor 为起点，14 天窗口，只显示今天及之后（参考预约项目页）
  buildDateChips() {
    const schedDates = new Set(this.data.scheduleDates || [])
    const now = new Date()
    const todayStr = ymd(now)
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
      const has = schedDates.has(iso)
      const isToday = iso === todayStr
      const isTmr = iso === tmrStr
      const wk = isToday ? '今天' : (isTmr ? '明天' : '周' + WD[cur.getDay()])
      const mo = (cur.getMonth() !== prevMonth) ? (cur.getMonth() + 1) + '月' : ''
      prevMonth = cur.getMonth()
      const sel = iso === this.data.selDate
      chips.push({ ymd: iso, wk, dd: cur.getDate(), mo, has, today: isToday, sel })
    }
    const a0 = new Date(anchor)
    const a1 = new Date(anchor); a1.setDate(a1.getDate() + 13)
    const rangeLabel = (a0.getMonth() + 1) + '/' + a0.getDate() + ' – ' + (a1.getMonth() + 1) + '/' + a1.getDate()
    const canPrev = anchorStr > todayStr
    this.setData({ dateChips: chips, dateRangeLabel: rangeLabel, canPrev, dateAnchor: anchorStr })
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
    this.setData({ dateAnchor: na, selDate: '', sessions: [] }, () => this.buildDateChips())
  },
  onOp(e) { this.handleOp(e.detail.action, e.detail.id) },
  // 点击「查看本场预约人」→ 直接弹出本场预约人弹层（不再跳转页面）
  async onShowPeople(e) {
    const id = e.currentTarget.dataset.id
    const sess = (this.data.sessions || []).find(x => x.id === id)
    const title = sess ? `${sess.start}–${sess.end}` : ''
    // 场次是否已过（按结束时间判断）→ 过期场次不可取消
    const expired = sess ? this.isSessionPast(this.data.selDate, sess.end) : true
    this.setData({ peopleShow: true, peopleTitle: title, list: [], detail: null, peopleExpired: expired, peopleLoading: true })
    try {
      const d = await call('listSessionReservations', { projectId: this.data.projectId, date: this.data.selDate, sessionId: id })
      this.setData({ list: d.list || [], peopleLoading: false })
    } catch (err) {
      this.setData({ peopleLoading: false })
      wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' })
    }
  },
  // 场次是否已成过去（按场次结束时间判断）
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
          // 刷新底层场次已约 / 剩余名额（卡片上的「X 人」会随之更新）
          this.loadDate(this.data.selDate)
          wx.hideLoading(); wx.showToast({ title: '已取消', icon: 'success' })
        } catch (err) {
          wx.hideLoading(); wx.showToast({ title: (err && err.message) || '取消失败', icon: 'none' })
        }
      }
    })
  },
  closePeople() { this.setData({ peopleShow: false, detail: null }) },
  // 预约人「查看顾客」→ 单用户分析（结合预约管理入口）
  goCustomer(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) return
    wx.navigateTo({ url: '/pages/admin/customers/detail?openid=' + openid })
  },
  showDetail(e) {
    const id = e.currentTarget.dataset.id
    const r = (this.data.list || []).find(x => x._id === id)
    this.setData({ detail: r || null })
  },
  closeDetail() { this.setData({ detail: null }) },
  // 列表中直接点击电话拨打（catchtap 阻止冒泡到 showDetail）
  onPhone(e) {
    const phone = e.currentTarget.dataset.phone
    if (phone) wx.makePhoneCall({ phoneNumber: phone })
  },
  dial() { if (this.data.detail && this.data.detail.phone) wx.makePhoneCall({ phoneNumber: this.data.detail.phone }) },
  // 审核预约：通过 / 不通过（owner/manager 均可，与弹层权限一致）
  onReview(e) {
    const id = e.currentTarget.dataset.id
    const decision = e.currentTarget.dataset.decision
    if (!id || !['approve', 'reject'].includes(decision)) return
    const item = (this.data.list || []).find(x => x._id === id)
    wx.showModal({
      title: decision === 'approve' ? '通过审核' : '拒绝预约',
      content: `确认${decision === 'approve' ? '通过' : '拒绝'}「${item ? item.name : '该顾客'}」的预约？`,
      confirmText: decision === 'approve' ? '通过' : '拒绝',
      confirmColor: decision === 'approve' ? '#07c160' : '#e34d59',
      success: r => {
        if (!r.confirm) return
        wx.showLoading({ title: '处理中', mask: true })
        call('reviewReservation', { reservationId: id, decision })
          .then(() => {
            wx.hideLoading()
            const review = decision === 'approve' ? 'approved' : 'rejected'
            const status = decision === 'approve' ? 'confirmed' : 'cancelled'
            // 本地更新列表：拒绝的会被查询过滤掉，直接移除；通过的更新状态
            const list = this.data.list
              .filter(x => x._id !== id || decision === 'approve')
              .map(x => x._id === id ? { ...x, review, status } : x)
            const detail = (this.data.detail && this.data.detail._id === id)
              ? (decision === 'approve' ? { ...this.data.detail, review, status } : null)
              : this.data.detail
            this.setData({ list, detail })
            // 刷新底层场次已约名额（拒绝会释放名额）
            this.loadDate(this.data.selDate)
            wx.showToast({ title: decision === 'approve' ? '已通过' : '已拒绝', icon: 'success' })
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
          })
      }
    })
  },
  copyPhone() {
    const phone = this.data.detail && this.data.detail.phone
    if (!phone) return
    wx.setClipboardData({ data: phone, success: () => wx.showToast({ title: '号码已复制', icon: 'none' }) })
  },
  // 复制微信号（管理员加好友/联系用）
  copyWechat() {
    const w = this.data.detail && this.data.detail.wechat
    if (!w) return
    wx.setClipboardData({ data: w, success: () => wx.showToast({ title: '微信号已复制', icon: 'none' }) })
  },
  noop() {},
  handleOp(action, id) {
    const date = this.data.selDate
    if (action === 'changeCap') {
      wx.showModal({
        title: '修改名额', editable: true, placeholderText: '新名额(≥已约)',
        success: r => {
          if (r.confirm) call('setSession', { projectId: this.data.projectId, date, sessionId: id, action: 'changeCap', capacity: Number(r.content) })
            .then(() => this.loadDate(date)).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
        }
      })
    } else if (action === 'cancelAll') {
      wx.showModal({
        title: '取消全部预约', content: '将取消该场次所有有效预约', confirmText: '确认',
        success: r => {
          if (r.confirm) call('setSession', { projectId: this.data.projectId, date, sessionId: id, action: 'cancelAll' })
            .then(() => this.loadDate(date)).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
        }
      })
    } else {
      call('setSession', { projectId: this.data.projectId, date, sessionId: id, action })
        .then(() => this.loadDate(date)).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
    }
  }
})
