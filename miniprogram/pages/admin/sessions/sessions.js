const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')
const boot = require('../../../utils/boot')
const { ymd } = require('../../../utils/util')

function addDaysDate(n) { const t = new Date(); t.setDate(t.getDate() + n); return t }

Page({
  behaviors: [guard],
  data: {
    // booting：与顾客端同一套 page-loading 全屏遮罩；必须在首帧声明，否则首帧不显示（白闪）
    booting: true,
    role: 'none', projects: [], projectId: '', projectName: '',
    scheduleDates: [], dateAnchor: '', dateChips: [], dateRangeLabel: '', canPrev: false,
    selDate: '', sessions: [], canChangeCap: false,
    peopleShow: false, peopleTitle: '', peopleLoading: false, list: [], detail: null,
    peopleExpired: false
  },
  // 入参（由预约页「进入预约管理」带入）：projectId=定位项目，date=预选该条预约对应日期
  onLoad(q) {
    this.q = q || {}
    // 首屏就绪门：guard → listProjects → getSchedule → loadDate 整条串行链跑完才收遮罩
    this._beginLoad()
    this.guard(['owner', 'manager']).then(role => {
      if (!role) { this._boot.close(); return }
      this.setData({ role, canChangeCap: role === 'owner' || role === 'manager' })
      this.loadProjects()
    }).catch(() => { if (this._boot) this._boot.close() })
  },
  // 开启一轮「数据加载」：boot 的计数池是一次性的（close 后 hold 失效），
  // 所以每次重新加载都要重建一扇门；遮罩随之出现，由数据链末端（loadDate 渲染完）收起。
  _beginLoad(timeout) {
    this.setData({ booting: true })
    try { delete this._boot } catch (e) { this._boot = undefined }
    this._boot = boot(this, { timeout: timeout || 8000 })
    this._boot.hold()
  },
  loadProjects() {
    call('listProjects').then(d => {
      const list = d.list || []
      this.setData({ projects: list })
      // 无项目：早退必须显式关门，否则遮罩永久盖住
      if (!list.length) { this._boot.close(); return }
      // 优先选中入参指定的项目，否则默认第一个
      const want = this.q.projectId
      const hit = want && list.find(x => x._id === want)
      this._autoDate = this.q.date || ''   // 仅首次自动选中时应用，之后手动切项目不再强制
      this.select(hit ? want : list[0]._id)
    }).catch(() => { if (this._boot) this._boot.close() })
  },
  // 切换项目：重建就绪门 → 与首次进入走同一套遮罩，
  // 避免中间态（selDate='' 时的「请选择日期」）在切项目瞬间闪一下
  onPick(e) {
    this._beginLoad()
    this.select(this.data.projects[e.detail.value]._id)
  },
  async select(id) {
    const sel = (this.data.projects || []).find(x => x._id === id)
    // 目标日期：仅首次自动选中时取入参，取一次即清空（之后用户手动浏览不再强制定位）
    const wantDate = this._autoDate || ''
    this._autoDate = ''
    this.setData({ projectId: id, projectName: sel ? sel.name : '', dateAnchor: wantDate || '', selDate: '', sessions: [] })
    try {
      const d = await call('getSchedule', { projectId: id })
      const scheduleDates = (d.schedules || []).map(s => s.date).sort()
      this.setData({ scheduleDates }, () => {
        this.buildDateChips()
        // ⚠️ 日期默认 =「今天」：切换项目/首次进入都定位到当天。
        //    旧逻辑回落到 scheduleDates.find(x => x >= today)——即「最早有场次的日期」，
        //    当天没场次时会自动跳到未来某天，与日期条锚点（今天）不一致、也不是管理员预期。
        //    仅入参指定日期（从某条预约跳转进来且该项目当天确有场次）才覆盖为入参日期。
        const todayStr = ymd(new Date())
        const target = (wantDate && scheduleDates.indexOf(wantDate) >= 0) ? wantDate : todayStr
        this.loadDate(target)
      })
    } catch (e) {
      if (this._boot) this._boot.close()
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
    }
  },
  onDate(e) {
    const y = e.currentTarget.dataset.ymd
    if (this.data.scheduleDates.indexOf(y) < 0) return
    this.loadDate(y)
  },
  async loadDate(date) {
    this.setData({ selDate: date })
    try {
      const d = await call('getSchedule', { projectId: this.data.projectId, date })
      const sch = (d.schedules || []).find(x => x.date === date)
      const base = (sch ? sch.sessions : []).map(x => ({ ...x, remaining: x.capacity - x.booked }))
      // 当日全部场次的预约人一次性加载，直接挂在对应场次下（无需再点「查看本场预约人」）
      const g = await call('listDateReservations', { projectId: this.data.projectId, date }).catch(() => null)
      const groups = (g && g.groups) || {}
      const withPeople = base.map(s => ({
        ...s,
        people: groups[s.id] || [],
        cancelable: !this.isSessionPast(date, s.end)
      }))
      this.setData({ sessions: withPeople }, () => {
        this.buildDateChips()
        // 数据链末端：日期条 + 场次都渲染完再收遮罩（settle = 再等两帧，避免露出半成品）。
        // 门已关闭时（如点日期切换、取消后刷新）settle 会自行 no-op，不影响交互。
        if (this._boot) this._boot.settle()
      })
    } catch (e) {
      if (this._boot) this._boot.close()
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
    }
  },
  // 在所有场次的 people 里按 _id 找预约人（列表已内联到各场次下，不再有集中的 list）
  findPerson(id) {
    for (const s of (this.data.sessions || [])) {
      const p = (s.people || []).find(x => x._id === id)
      if (p) return p
    }
    return null
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
  // 场次是否已成过去（按场次结束时间判断）
  isSessionPast(dateStr, endStr) {
    const [y, m, d] = String(dateStr || '').split('-').map(Number)
    const [hh, mm] = String(endStr || '').split(':').map(Number)
    if (!y) return true
    const end = new Date(y, m - 1, d, hh || 0, mm || 0)
    return Date.now() > end.getTime()
  },
  // 管理员代取消某条预约（释放名额 + 通知双方）；仅未过期场次可取消
  // 事件来自 reservee 组件：e.detail = { id }
  onCancel(e) {
    const id = (e.detail && e.detail.id) || e.currentTarget.dataset.id
    const item = this.findPerson(id)
    wx.showModal({
      title: '取消预约',
      content: `确认取消「${item ? item.name : '该顾客'}」本场预约？将释放名额并通知双方。`,
      confirmText: '取消预约', confirmColor: '#e34d59',
      success: async (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '取消中', mask: true })
        try {
          await call('cancelReservation', { reservationId: id })
          wx.hideLoading()
          wx.showToast({ title: '已取消', icon: 'success' })
          // 刷新整日：场次已约 / 剩余名额 / 各场预约人都会更新
          await this.loadDate(this.data.selDate)
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: (err && err.message) || '取消失败', icon: 'none' })
        }
      }
    })
  },
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
  // 审核预约：通过 / 不通过（owner/manager 均可）
  // 事件来自 reservee 组件：e.detail = { id, decision }
  onReview(e) {
    const d = e.detail || {}
    const id = d.id || e.currentTarget.dataset.id
    const decision = d.decision || e.currentTarget.dataset.decision
    if (!id || !['approve', 'reject'].includes(decision)) return
    const item = this.findPerson(id)
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
            wx.showToast({ title: decision === 'approve' ? '已通过' : '已拒绝', icon: 'success' })
            // 刷新整日：拒绝会释放名额，通过会更新状态与已约数
            this.loadDate(this.data.selDate)
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
