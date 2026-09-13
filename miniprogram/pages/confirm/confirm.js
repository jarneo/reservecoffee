const { call } = require('../../utils/cloud')
const { isPhone, requestSubscribe } = require('../../utils/util')
const { normalizeSubs, notifyPlanOf, tmplIdsOfPlan, CUSTOMER_SUBS } = require('../../utils/subscribe')

Page({
  data: {
    projectId: '', date: '', sessionId: '',
    projectName: '', session: null,
    name: '', phone: '', partySize: 1, note: '', maxParty: 2,
    fields: ['name', 'phone'],
    showPhone: true, showWechat: false, showGender: false, showAge: false, showNote: false,
    // 黑名单阻断态：进入页面即检出，禁用提交
    blocked: false, blockReason: '',
    // 用户长期通知偏好（users.subscriptions，缺省全订阅）。
    // 页面不再自绘勾选弹窗：授权直接交给微信原生弹窗（它本身就是带勾选框的列表）。
    // 这里只用于「提交时随预约一起落库」以及「哪几类不必申请」的过滤。
    subs: {},
    // 提交成功页（应用内必达确认 UI）：成功后展示留座信息覆盖层
    success: false,
    successInfo: null
  },

  onLoad(q) {
    this.setData({ projectId: q.projectId, date: q.date, sessionId: q.sessionId })
    this.setData({ subs: normalizeSubs({}) })
    this.load()
  },

  load() {
    call('getProject', { projectId: this.data.projectId })
      .then(d => {
        const p = d.project
        const s = (d.schedules.find(x => x.date === this.data.date) || {})
        const sess = (s.sessions || []).find(x => x.id === this.data.sessionId)
        const fields = p.fields || ['name', 'phone']
        // 按预约时间轴算出「本次会真正触发」的通知类型（≤3），提交时只申请这几个模板。
        // 在页面加载时算好，使 submit 的 tap 处理器能同步取用（requestSubscribe 必须在手势内同步调用）。
        this.notifyCfg = d.notifyCfg               // 通知时间窗配置（getProject 下发；缺失时用默认值）
        this.plan = notifyPlanOf(
          { date: this.data.date, sessionStart: sess && sess.start, sessionEnd: sess && sess.end },
          d.notifyCfg
        )
        this.setData({
          projectName: p.name,
          session: sess ? { ...sess, remaining: sess.capacity - sess.booked } : null,
          maxParty: p.maxParty || 2,
          fields,
          // 预计算各可选字段显隐标志：WXML 不支持方法调用（如 .indexOf），故用 JS 预算布尔，避免字段不显示
          showPhone: fields.indexOf('phone') >= 0,
          showWechat: fields.indexOf('wechat') >= 0,
          showGender: fields.indexOf('gender') >= 0,
          showAge: fields.indexOf('age') >= 0,
          showNote: fields.indexOf('note') >= 0
        })
        this.prefill()
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },

  // 从 users 集合预填称呼/手机号（仅当本页尚未输入时），实现"下次预约自动带出"
  // 同时检出黑名单：命中则进入阻断态，避免用户填完表单提交后才被服务端拒绝
  // 并取回该顾客的长期通知偏好（提交时随预约落库；也可在「我的 → 通知偏好」修改）
  prefill() {
    call('getMyProfile')
      .then(d => {
        const profile = d && d.profile
        if (!profile) return
        if (profile.isBlacklisted) {
          this.setData({ blocked: true, blockReason: profile.blacklistReason || '' })
          return
        }
        const patch = {}
        if (profile.name && !this.data.name) patch.name = profile.name
        if (profile.phone && !this.data.phone) patch.phone = profile.phone
        if (Object.keys(patch).length) this.setData(patch)
        if (profile.subscriptions) this.setData({ subs: normalizeSubs(profile.subscriptions) })
      })
      .catch(() => {})
  },

  onName(e) { this.setData({ name: e.detail.value }) },
  onPhone(e) { this.setData({ phone: e.detail.value }) },
  onWechat(e) { this.setData({ wechat: e.detail.value }) },
  onNote(e) { this.setData({ note: e.detail.value }) },
  onGender(e) { this.setData({ gender: e.detail.value }) },
  onAge(e) { this.setData({ age: e.detail.value }) },

  // 微信手机号快捷获取：用户点按钮授权后，用返回的 code 到服务端换取真实手机号
  onGetPhone(e) {
    const { errMsg, code } = e.detail
    if (errMsg !== 'getPhoneNumber:ok') return
    if (!code) return wx.showToast({ title: '未能获取授权', icon: 'none' })
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
    const max = Math.min(this.data.session ? this.data.session.remaining : 9, this.data.maxParty || 2)
    const v = Math.max(1, Math.min(max, this.data.partySize + d))
    this.setData({ partySize: v })
  },

  // 取本次通知计划；若 load() 尚未返回或失败则就地补算，保证永远有值
  // （否则会一个模板都不申请、原生弹窗根本不出现）
  ensurePlan() {
    if (this.plan) return this.plan
    const s = this.data.session
    this.plan = notifyPlanOf(
      { date: this.data.date, sessionStart: s && s.start, sessionEnd: s && s.end },
      this.notifyCfg
    )
    return this.plan
  },

  // 直接拉起微信原生订阅弹窗（它本身就是带勾选框的列表，无需再自绘一层）。
  // 申请「预约成功 + 适用时间轴(≤2) + 有空位顺带取消」的授权集（由 subscribe.tmplIdsOfPlan 分配，恒 ≤3，1 次弹窗），且**忽略长期偏好**：
  //    长期偏好只闸「后端是否发送」，不闸「前端申请」——否则用户在偏好里关掉的项永远不在弹窗里、无法重新开启。
  //    弹窗里用户勾选/取消的结果会回写 this.data.subs（作为本次预约的订阅快照，并供 doSubmit 落库）。
  // ⚠️ 必须在本 tap 处理器里**同步**发起（不能放在任何 await 之后），否则脱离用户手势上下文 → 微信不弹窗。
  requestNotify() {
    const plan = this.ensurePlan()
    const ids = tmplIdsOfPlan(plan, null) // 申请集由 tmplIdsOfPlan 按档位分配（预约成功必含 + 时间轴≤2 + 有空位填取消），恒≤3
    console.info('[confirm] notifyPlan=', JSON.stringify(plan), 'requestIds=', ids.length, 'ids=', JSON.stringify(ids))
    if (!ids.length) {
      // 走到这里只可能是日期/场次异常导致计划为空；显式记录，避免静默失败被误认为「功能没生效」
      console.warn('[confirm] 无任何模板需要申请，微信订阅弹窗不会出现')
      return Promise.resolve()
    }
    return requestSubscribe(ids).then(r => {
      const accepted = (r && r.accepted) || []
      const rejected = (r.rejected || [])
      const failed = (r.failed || [])
      const code = r && r.errCode
      console.info('[confirm] subscribe accepted=', accepted.length, 'rejected=', rejected.length, 'failed=', failed.length, 'errCode=', code)
      // 回写订阅偏好：用户在该弹窗里允许的项 → true，拒绝/被禁用 → false（仅限本次申请的模板）
      const subs = { ...this.data.subs }
      const keyOf = id => { const s = CUSTOMER_SUBS.find(x => x.tmplId === id); return s ? s.key : null }
      accepted.forEach(id => { const k = keyOf(id); if (k) subs[k] = true })
      rejected.forEach(id => { const k = keyOf(id); if (k) subs[k] = false })
      this.setData({ subs })
      if (!accepted.length) {
        // 未拿到任何授权 —— 必须让用户/开发者看得见原因，否则表现为「弹窗不弹、静默改短信」
        //   errCode 20003：tmplIds 非法（含后台未选用/已失效的模板）→ 整次调用失败且不弹窗
        //   errCode 20004：用户在弹窗里点了「取消」（整体拒绝）
        //   注意：「一次性额度用尽 / 用户拒绝接收」是「发送」阶段(subscribeMessage.send)返回的 43101，
        //        不是本「请求授权」阶段；本阶段「总是保持+拒绝」会走 success 回调的 reject 分支（见上）。
        const msg = code
          ? ('订阅授权失败 ' + code + '，将改用短信通知')
          : (rejected.length ? '未开启微信通知，将改用短信通知' : '微信订阅未生效，将改用短信通知')
        wx.showToast({ title: msg, icon: 'none', duration: 2500 })
      }
    }).catch(() => { wx.showToast({ title: '微信订阅调用失败，将改用短信通知', icon: 'none', duration: 2500 }) })
  },

  async submit() {
    // 黑名单兜底：profile 尚未返回时用户就点了提交（服务端 createReservation 亦会拦截，此处仅为体验兜底）
    if (this.data.blocked) {
      return wx.showModal({
        title: '暂时无法预约',
        content: '您的账号当前无法在线预约，如有疑问请直接联系店家沟通。',
        showCancel: false
      })
    }
    const { name, phone, partySize, note, wechat, gender, age, fields } = this.data
    if (!name.trim()) return wx.showToast({ title: '请填写称呼', icon: 'none' })
    // 手机号非必填：填了才校验格式
    if (phone && !isPhone(phone)) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' })
    // 只提交「项目配置勾选」的字段，保证与管理端设置联动
    const payload = { projectId: this.data.projectId, date: this.data.date, sessionId: this.data.sessionId, name, partySize }
    if (fields.indexOf('phone') >= 0) payload.phone = phone || ''
    if (fields.indexOf('wechat') >= 0) payload.wechat = wechat || ''
    if (fields.indexOf('note') >= 0) payload.note = note || ''
    if (fields.indexOf('gender') >= 0) payload.gender = gender || ''
    if (fields.indexOf('age') >= 0) payload.age = age || ''
    // 先同步拉起微信订阅弹窗（必须在手势内）；等用户授权/拒绝结果回写 subs 后再提交预约。
    // 用 Promise.race 加 20s 兜底：万一弹窗异常未回调（如用户强行退出），不至于卡住提交。
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
        // 提交成功页（应用内必达确认）：展示留座信息；待审核项目显示「待审核」态
        const needReview = res && res.review === 'pending'
        this.setData({
          success: true,
          successInfo: {
            projectName: this.data.projectName,
            date: this.data.date,
            session: this.data.session,
            partySize: this.data.partySize,
            needReview
          }
        })
        // 持久化顾客资料，下次预约自动带出（失败不阻断主流程）
        const prof = { name: this.data.name.trim() }
        if (this.data.phone) prof.phone = this.data.phone
        call('saveProfile', prof).catch(() => {})
      })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message || '提交失败', icon: 'none' }) })
  },

  // 提交成功页：查看我的预约（我的预约是 tabBar 页，必须用 switchTab）
  goMine() { wx.switchTab({ url: '/pages/mine/mine' }) },
  // 提交成功页：返回首页继续逛
  closeSuccess() { wx.reLaunch({ url: '/pages/index/index' }) }
})
