const { call } = require('../../utils/cloud')
const boot = require('../../utils/boot')
const { ymd, isSessionExpired, isPhone, requestSubscribe } = require('../../utils/util')
const { normalizeSubs, notifyPlanOf, tmplIdsOfPlan, normalizeNotifyCfg } = require('../../utils/subscribe')

function addDaysDate(n) { const t = new Date(); t.setDate(t.getDate() + n); return t }

Page({
  data: {
    projectId: '', project: {}, introImages: [], relatedProjects: [], schedules: [], openDays: [], advanceDays: 7,
    dateAnchor: '', dateChips: [], dateRangeLabel: '', canPrev: false,
    selectedDate: '', bizWindow: '', sessions: [],
    showSeatInfo: true,
    role: 'none', isAdmin: false,
    // ===== 内嵌确认表单状态（原 confirm 页逻辑，移入本页底部）=====
    selSession: null,
    name: '', phone: '', wechat: '', gender: '', age: '', partySize: 1, note: '',
    maxParty: 2, fields: ['name', 'phone'],
    showPhone: true, showWechat: false, showGender: false, showAge: false, showNote: false,
    subs: {},
    needFill: false, partyCapped: false, partyMax: 1, submitting: false,
    unavailable: '', blocked: false, blockReason: '',
    success: false, successInfo: null,
    booting: true
  },

  onLoad(q) {
    this._boot = boot(this, { timeout: 6000 })
    wx.showShareMenu({ menus: ['shareAppMessage'] })
    this.q = q || {}
    const pid = this.q.projectId || ''
    // 公众号 AI 卡片落地参数（常规顾客路径走 confirm 页，此处仅作深度链接预选兼容）
    this.fromOa = this.q.from === 'oa'
    if (this.q.log) this._aiLogId = this.q.log
    this.setData({
      projectId: pid,
      dateAnchor: '', selectedDate: '', sessions: [], bizWindow: '', selSession: null
    })
    this.track('view_project', pid)
    // 需求2：判定管理员身份（owner/manager 才在选日期页看到各场次预约人）
    const app = getApp()
    if (app && typeof app.refreshRole === 'function') {
      app.refreshRole().then(r => {
        const role = (r && r.role) || 'none'
        this.setData({ role, isAdmin: role === 'owner' || role === 'manager' })
        if (this.data.selectedDate) this.loadReservees(this.data.selectedDate)
      }).catch(() => {})
    }
    this.load()
  },

  // 埋点上报：写 events 集合供数据分析漏斗使用。失败静默，绝不影响预约主流程
  track(type, projectId) {
    try {
      call('trackEvent', { type, projectId: projectId || '' }).catch(() => {})
    } catch (e) { /* ignore */ }
  },

  load() {
    // 「数据在路上」由渲染回调里的 settle 释放
    this._boot.hold()
    call('getProject', { projectId: this.data.projectId })
      .then(d => {
        const p = d.project
        const sched = d.schedules || []
        const openDays = p.openDays || []
        const adv = p.advanceDays || 7
        const fields = p.fields || ['name', 'phone']
        // 通知时间窗配置（与 confirm 同源）：提交时按预约时间轴裁剪订阅授权集
        this.notifyCfg = normalizeNotifyCfg(d.notifyCfg)
        this.setData({
          project: p, introImages: p.introImages || [], relatedProjects: p.relatedProjects || [], schedules: sched,
          openDays, advanceDays: adv, showSeatInfo: p.showSeatInfo !== false,
          aiEnabled: d.aiEnabled !== false,
          maxParty: p.maxParty || 2, fields,
          // 座位信息开关：与确认页同口径，缺省为开（仅隐藏余量展示，不隐藏人数夹取）
          showPhone: fields.indexOf('phone') >= 0,
          showWechat: fields.indexOf('wechat') >= 0,
          showGender: fields.indexOf('gender') >= 0,
          showAge: fields.indexOf('age') >= 0,
          showNote: fields.indexOf('note') >= 0
        }, () => {
          // 第二跳：资料预填 + 黑名单 + 订阅偏好，全部就绪后再放行遮罩
          this.getProfile().then(() => {
            this.buildDateChips()
            this.autoSelectFirst()
            const introN = (p.introImages || []).length
            this._boot.images(introN).settle(2)
            this.applyDeepLink()
          })
        })
      })
      .catch(e => {
        wx.showToast({ title: e.message || '加载失败', icon: 'none' })
        this._boot.close('loadFail')
      })
  },

  // 资料完整性检查：称呼/手机号缺任一项就亮出引导条
  checkNeedFill() {
    const need = !String(this.data.name || '').trim() || !String(this.data.phone || '').trim()
    if (need !== this.data.needFill) this.setData({ needFill: need })
  },

  // 从 users 集合预填称呼/手机号；检出黑名单则进入阻断态；取回长期订阅偏好
  getProfile() {
    return call('getMyProfile')
      .then(d => {
        const profile = d && d.profile
        if (!profile) { this.checkNeedFill(); return }
        if (profile.isBlacklisted) {
          this.setData({ blocked: true, blockReason: profile.blacklistReason || '' })
          this.checkNeedFill()
          return
        }
        const patch = {}
        if (profile.name && !this.data.name) patch.name = profile.name
        if (profile.phone && !this.data.phone) patch.phone = profile.phone
        if (Object.keys(patch).length) this.setData(patch)
        if (profile.subscriptions) this.setData({ subs: normalizeSubs(profile.subscriptions) })
        this.checkNeedFill()
      })
      .catch(() => { this.checkNeedFill() })
  },

  // bindload / binderror 共用：单张图失败也算完成，不阻塞整页
  onBootImg() {
    this._boot.image()
  },

  // 计算「离当天最近、且确有可选场次」的可约日（在提前预约窗口内）
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
    if (this.data.dateAnchor !== d) {
      this.setData({ dateAnchor: d })
      this.buildDateChips()
    }
    this.selectDay(d)
  },

  // 横向日期条：固定 14 天（两周），以 dateAnchor 为起点
  buildDateChips() {
    const openDays = this.data.openDays
    const schedDates = new Set((this.data.schedules || []).map(s => s.date))
    const schedMap = {}
    const closedMap = {}
    ;(this.data.schedules || []).forEach(s => { schedMap[s.date] = s.sessions || []; closedMap[s.date] = !!s.closed })
    const projPaused = !!this.data.project.paused
    const adv = this.data.advanceDays || 7
    const now = new Date()
    const todayStr = ymd(now)
    const maxWin = ymd(addDaysDate(adv))
    let anchorStr = this.data.dateAnchor || todayStr
    if (anchorStr < todayStr) anchorStr = todayStr
    const [ay, am, ad] = anchorStr.split('-').map(Number)
    const anchor = new Date(ay, am - 1, ad)
    const WD = ['日', '一', '二', '三', '四', '五', '六']
    const tmrStr = ymd(addDaysDate(1))
    const chips = []
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

  // 取某日场次并展开（供点击与默认展开共用）；cb 在渲染收敛后回调（供深度链接预选）
  selectDay(y, cb) {
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
    // 切换日期时收起内嵌表单，避免停留在上一日的已选场次上
    this.setData({ selectedDate: y, sessions, bizWindow: win, selSession: null }, () => {
      this.buildDateChips()
      if (this.data.isAdmin) this.loadReservees(y)
      if (typeof cb === 'function') cb()
    })
  },

  // 深度链接预选（分享/AI 落地带 date+sessionId 时，自动展开对应场次并选中）
  applyDeepLink() {
    const q = this.q || {}
    if (!q.date || !q.sessionId) return
    if (this.data.openDays.indexOf(q.date) < 0) return
    const ps = Number(q.partySize) || 1
    this.setData({ partySize: Math.max(1, Math.min(20, ps)) })
    // 深度链接预选：若需切换日期，必须等 selectDay 的 setData 收敛（场次列表就绪）后再选场次，
    // 否则 selectSessionById 读到的还是上一日的 sessions，会静默失败。
    const pick = () => this.selectSessionById(q.sessionId)
    if (this.data.selectedDate !== q.date) this.selectDay(q.date, pick)
    else pick()
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
    this.setData({ dateAnchor: na, selectedDate: '', sessions: [], bizWindow: '', selSession: null }, () => this.buildDateChips())
  },

  // ===== 顾客端：点选场次（替代原「跳 confirm 页」）=====
  selectSession(e) {
    this.selectSessionById(e.currentTarget.dataset.id)
  },
  // 管理员代客预约：在管理端场次卡片 / 「＋ 代客预约」按钮上点选场次，复用同一内嵌表单
  adminSelectSession(e) {
    this.selectSessionById(e.currentTarget.dataset.id, true)
  },
  selectSessionById(sid, admin) {
    const s = (this.data.sessions || []).find(x => x.id === sid)
    if (!s) return
    if (admin) {
      // 管理员代客预约：仅「项目整体暂停」与「场次已过期」不可选；满员 / 暂停场次仍允许代客补位（如现场到店）
      if (this.data.project.paused || s.expired) {
        return wx.showToast({ title: this.data.project.paused ? '本项目已暂停预约' : '该场次已过期', icon: 'none' })
      }
      // 代客预约：清空预填的店家自身资料，改由店家录入顾客信息
      this.setData({ name: '', phone: '', wechat: '', gender: '', age: '', note: '' })
    } else {
      if (this.data.project.paused || s.paused || s.blocked || s.expired || s.remaining <= 0) {
        return wx.showToast({ title: '该场次不可选', icon: 'none' })
      }
    }
    this.track('click_book', this.data.projectId)
    // 选中场次 → 展开页面底部的内嵌表单
    const unavailable = (!admin && s.remaining <= 0) ? '这个场次刚刚被约满了，请换一个时间～' : ''
    const cap = Math.max(1, Math.min(this.data.maxParty || 2, Math.max(1, s.remaining)))
    this.setData({ selSession: s, unavailable, partySize: cap, partyMax: cap, partyCapped: false }, () => {
      // 滚动到内嵌表单区，减少寻找成本
      wx.pageScrollTo({ selector: '#bookForm', duration: 260 })
    })
  },

  // ===== 内嵌表单输入处理（原 confirm 页逻辑）=====
  onName(e) { this.setData({ name: e.detail.value }, () => this.checkNeedFill()) },
  onPhone(e) { this.setData({ phone: e.detail.value }, () => this.checkNeedFill()) },
  onWechat(e) { this.setData({ wechat: e.detail.value }) },
  onNote(e) { this.setData({ note: e.detail.value }) },
  onGender(e) { this.setData({ gender: e.detail.value }) },
  onAge(e) { this.setData({ age: e.detail.value }) },

  // 微信手机号快捷获取
  onGetPhone(e) {
    const { errMsg, code } = e.detail
    if (errMsg !== 'getPhoneNumber:ok') {
      const deny = String(errMsg || '').indexOf('deny') >= 0
      wx.showToast({ title: deny ? '已跳过，请手工填写手机号' : '未能获取，请手工填写手机号', icon: 'none' })
      return
    }
    if (!code) return wx.showToast({ title: '未能获取授权，请手工填写手机号', icon: 'none' })
    wx.showLoading({ title: '获取中' })
    call('getPhoneNumber', { code })
      .then(d => {
        if (d && d.phone) {
          this.setData({ phone: d.phone })
          call('saveProfile', { phone: d.phone }).catch(() => {})
          wx.showToast({ title: '已填入手机号', icon: 'success' })
        } else {
          wx.showToast({ title: '获取失败', icon: 'none' })
        }
      })
      .catch(err => wx.showToast({ title: err.message || '获取失败', icon: 'none' }))
      .finally(() => wx.hideLoading())
  },

  step(e) {
    const d = Number(e.currentTarget.dataset.d)
    const s = this.data.selSession
    if (!s) return
    const maxParty = this.data.maxParty || 2
    // 本场真实可约上限 = min(单次上限, 本场余位)
    const max = Math.min(maxParty, s.remaining)
    const v = Math.max(1, Math.min(max, this.data.partySize + d))
    if (d > 0 && v === this.data.partySize) {
      // 已到上限：按**真正的限制来源**给提示，且与真实可约上限动态一致（不再报固定的单次上限数字）
      if (s.remaining <= maxParty) {
        wx.showToast({ title: `该场次人员不足，无法成行（本场最多可约 ${s.remaining} 人）`, icon: 'none', duration: 2600 })
      } else {
        wx.showToast({ title: `单次最多 ${maxParty} 人，更多请致电 19292757851`, icon: 'none', duration: 2600 })
      }
      return
    }
    this.setData({ partySize: v, partyCapped: false })
  },

  // 取本次通知计划；若尚未载入则就地补算，保证永远有值
  ensurePlan() {
    if (this.plan) return this.plan
    const s = this.data.selSession
    this.plan = notifyPlanOf(
      { date: this.data.selectedDate, sessionStart: s && s.start, sessionEnd: s && s.end },
      this.notifyCfg
    )
    return this.plan
  },

  // 拉起微信原生订阅弹窗（带勾选框的列表，无需自绘）。申请「预约成功 + 适用时间轴(≤2) + 有空位顺带取消」的授权集（恒≤3，1 次弹窗），忽略长期偏好。
  // ⚠️ 必须在本 tap 处理器内同步发起，否则脱离用户手势上下文 → 微信不弹窗。
  requestNotify() {
    const plan = this.ensurePlan()
    const ids = tmplIdsOfPlan(plan, null)
    if (!ids.length) {
      console.warn('[booking] 无任何模板需要申请，微信订阅弹窗不会出现')
      return Promise.resolve()
    }
    return requestSubscribe(ids).then(r => {
      const accepted = (r && r.accepted) || []
      const rejected = (r.rejected || [])
      const failed = (r.failed || [])
      const code = r && r.errCode
      const subs = { ...this.data.subs }
      const keyOf = id => { const s = CUSTOMER_SUBS && CUSTOMER_SUBS.find(x => x.tmplId === id); return s ? s.key : null }
      accepted.forEach(id => { const k = keyOf(id); if (k) subs[k] = true })
      rejected.forEach(id => { const k = keyOf(id); if (k) subs[k] = false })
      this.setData({ subs })
      if (!accepted.length) {
        const msg = code ? ('订阅授权失败 ' + code + '，将改用短信通知') : (rejected.length ? '未开启微信通知，将改用短信通知' : '微信订阅未生效，将改用短信通知')
        wx.showToast({ title: msg, icon: 'none', duration: 2500 })
      }
    }).catch(() => { wx.showToast({ title: '微信订阅调用失败，将改用短信通知', icon: 'none', duration: 2500 }) })
  },

  async submit() {
    // 提交防重复：已在提交中则直接忽略本次点击（微信订阅弹窗期间用户会误以为没反应而连点）
    if (this._submitting) return
    if (this.data.unavailable) {
      return wx.showModal({ title: '这个场次约不上了', content: this.data.unavailable, showCancel: false })
    }
    if (this.data.blocked) {
      return wx.showModal({ title: '暂时无法预约', content: '您的账号当前无法在线预约，如有疑问请直接联系店家沟通。', showCancel: false })
    }
    const { name, phone, partySize, note, wechat, gender, age, fields } = this.data
    if (!name.trim()) {
      this.setData({ needFill: true })
      return wx.showModal({ title: '请填写称呼', content: '称呼是必填项，可直接在「称呼」处手工输入；手机号可点「获取手机号」一键填入，也可手工输入。', showCancel: false })
    }
    if (fields.indexOf('phone') >= 0) {
      if (!phone.trim()) {
        this.setData({ needFill: true })
        return wx.showModal({ title: '手机号是必填项', content: '手机号点「获取手机号」即可一键授权填入，也可以手工输入。手机号只会用于本次预约的通知，您不用担心。', showCancel: false })
      }
      if (!isPhone(phone)) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' })
    }
    const s = this.data.selSession
    if (!s) return wx.showToast({ title: '请先选择场次', icon: 'none' })
    const payload = { projectId: this.data.projectId, date: this.data.selectedDate, sessionId: s.id, name, partySize }
    if (fields.indexOf('phone') >= 0) payload.phone = phone || ''
    if (fields.indexOf('wechat') >= 0) payload.wechat = wechat || ''
    if (fields.indexOf('note') >= 0) payload.note = note || ''
    if (fields.indexOf('gender') >= 0) payload.gender = gender || ''
    if (fields.indexOf('age') >= 0) payload.age = age || ''
    if (this.fromOa) {
      payload.source = 'oa'
      if (this._aiLogId) payload.aiLogId = this._aiLogId
    }
    // 校验全部通过 → 锁定提交（按钮置灰 + 文案转「提交中」），直至本次请求完成
    this._submitting = true
    this.setData({ submitting: true })
    // 先同步拉起微信订阅弹窗（手势内），结果回写 subs 后再提交
    await Promise.race([
      this.requestNotify(),
      new Promise(res => setTimeout(res, 20000))
    ])
    this.doSubmit(payload)
  },

  doSubmit(payload) {
    wx.showLoading({ title: '提交中' })
    call('createReservation', { ...payload, subscribed: this.data.subs })
      .then(res => {
        wx.hideLoading()
        // 管理员代客预约成功后，刷新本日各场次预约人列表，使新单立即呈现
        if (this.data.isAdmin && this.data.selectedDate) this.loadReservees(this.data.selectedDate).catch(() => {})
        const needReview = res && res.review === 'pending'
        const info = {
          projectName: this.data.project.name,
          date: this.data.selectedDate,
          session: this.data.selSession,
          partySize: this.data.partySize,
          needReview
        }
        const prof = { name: this.data.name.trim() }
        if (this.data.phone) prof.phone = this.data.phone
        call('saveProfile', prof).catch(() => {})

        // 跳独立结果页（与 confirm 页历史行为一致）；fail 兜底回退到本页成功覆盖层
        const sess = info.session || {}
        const qs = [
          'pid=' + encodeURIComponent(this.data.projectId || ''),
          'pn=' + encodeURIComponent(info.projectName || ''),
          'd=' + encodeURIComponent(info.date || ''),
          'ss=' + encodeURIComponent(sess.start || ''),
          'se=' + encodeURIComponent(sess.end || ''),
          'ps=' + (info.partySize || 1),
          'nr=' + (needReview ? 1 : 0),
          'ph=' + encodeURIComponent(this.data.phone || '')
        ].join('&')
        wx.redirectTo({
          url: '/pages/result/result?' + qs,
          fail: () => this.setData({ success: true, successInfo: info })
        })
      })
      .catch(e => { wx.hideLoading(); this._submitting = false; this.setData({ submitting: false }); wx.showToast({ title: e.message || '提交失败', icon: 'none' }) })
  },

  goMine() { wx.switchTab({ url: '/pages/mine/mine' }) },
  closeSuccess() { wx.reLaunch({ url: '/pages/index/index' }) },

  // 管理员：带当前项目 + 日期进入完整「预约管理」页（该页已支持 date 入参预选）
  goManage() {
    const pid = this.data.projectId || ''
    const d = this.data.selectedDate || ''
    wx.navigateTo({
      url: '/pages/admin/sessions/sessions?projectId=' + encodeURIComponent(pid) + '&date=' + encodeURIComponent(d)
    })
  },

  // ===== 管理端：每场次下挂预约人列表（沿用上一版 reservee 组件，不受影响）=====
  async loadReservees(date) {
    if (!this.data.isAdmin) return
    const [sch, g] = await Promise.all([
      call('getSchedule', { projectId: this.data.projectId, date }).catch(() => null),
      call('listDateReservations', { projectId: this.data.projectId, date }).catch(() => null)
    ])
    const day = (sch && sch.schedules || []).find(x => x.date === date)
    const cutoff = this.data.project.cutoff
    const projPaused = !!this.data.project.paused
    const base = (day ? day.sessions : []).map(x => {
      const expired = isSessionExpired(date, x.start, cutoff)
      return { ...x, remaining: x.capacity - x.booked, blocked: projPaused || !!day.closed, expired }
    })
    const groups = (g && g.groups) || {}
    const withPeople = base.map(s => ({ ...s, people: groups[s.id] || [], cancelable: !this.isSessionPast(date, s.end) }))
    this.setData({ sessions: withPeople })
  },
  isSessionPast(dateStr, endStr) {
    const [y, m, d] = String(dateStr || '').split('-').map(Number)
    const [hh, mm] = String(endStr || '').split(':').map(Number)
    if (!y) return true
    const end = new Date(y, m - 1, d, hh || 0, mm || 0)
    return Date.now() > end.getTime()
  },
  onCancel(e) {
    const id = e.detail.id
    const sess = (this.data.sessions || []).find(s => (s.people || []).some(p => p._id === id))
    const person = sess ? sess.people.find(p => p._id === id) : null
    const name = person ? person.name : '该顾客'
    wx.showModal({
      title: '取消预约',
      content: `确认取消「${name}」本场预约？将释放名额并通知双方。`,
      confirmText: '取消预约', confirmColor: '#e34d59',
      success: async (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '取消中', mask: true })
        try {
          await call('cancelReservation', { reservationId: id })
          wx.hideLoading()
          wx.showToast({ title: '已取消', icon: 'success' })
          await this.loadReservees(this.data.selectedDate)
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: (err && err.message) || '取消失败', icon: 'none' })
        }
      }
    })
  },
  // 审核预约（与「预约管理」页一致）：事件来自 reservee 组件，e.detail = { id, decision }
  onReview(e) {
    const d = e.detail || {}
    const id = d.id
    const decision = d.decision
    if (!id || (decision !== 'approve' && decision !== 'reject')) return
    const sess = (this.data.sessions || []).find(s => (s.people || []).some(p => p._id === id))
    const person = sess ? sess.people.find(p => p._id === id) : null
    const name = person ? person.name : '该顾客'
    const okTxt = decision === 'approve' ? '通过' : '拒绝'
    wx.showModal({
      title: decision === 'approve' ? '通过审核' : '拒绝预约',
      content: `确认${okTxt}「${name}」的预约？`,
      confirmText: okTxt,
      confirmColor: decision === 'approve' ? '#07c160' : '#e34d59',
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '处理中', mask: true })
        call('reviewReservation', { reservationId: id, decision })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: decision === 'approve' ? '已通过' : '已拒绝', icon: 'success' })
            this.loadReservees(this.data.selectedDate)
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
          })
      }
    })
  },

  // 点击介绍图放大预览
  previewIntro(e) {
    const i = e.currentTarget.dataset.i
    const imgs = this.data.introImages
    const urls = imgs.map(x => x.url).filter(Boolean)
    if (!urls.length) return
    wx.previewImage({ current: urls[i] || urls[0], urls })
  },

  // 点击关联项目：跳转到目标项目详情页（复用本页，参数 projectId 切换）
  goRelated(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/booking/booking?projectId=' + id })
  },

  // 转发给好友 / 分享朋友圈：分享当前预约项目
  onShareAppMessage() {
    const p = this.data.project || {}
    return {
      title: p.name || '二曜路8号咖啡和清酒 · 预约',
      path: '/pages/booking/booking?projectId=' + (this.data.projectId || '')
    }
  },
})
