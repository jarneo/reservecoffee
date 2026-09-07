const { call } = require('../../utils/cloud')
const { isPhone, requestSubscribe } = require('../../utils/util')
const { BOOKER_TPLS } = require('../../utils/subscribe')

Page({
  data: {
    projectId: '', date: '', sessionId: '',
    projectName: '', session: null,
    name: '', phone: '', partySize: 1, note: '', maxParty: 2,
    fields: ['name', 'phone'],
    showPhone: true, showWechat: false, showGender: false, showAge: false, showNote: false,
    // 黑名单阻断态：进入页面即检出，禁用提交
    blocked: false, blockReason: ''
  },

  onLoad(q) {
    this.setData({ projectId: q.projectId, date: q.date, sessionId: q.sessionId })
    this.load()
  },

  load() {
    call('getProject', { projectId: this.data.projectId })
      .then(d => {
        const p = d.project
        const s = (d.schedules.find(x => x.date === this.data.date) || {})
        const sess = (s.sessions || []).find(x => x.id === this.data.sessionId)
        const fields = p.fields || ['name', 'phone']
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

  submit() {
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
    // 必须在用户点击手势内同步请求订阅授权（成功/取消/开场提醒），否则微信会拦截导致授权失败、收不到推送
    requestSubscribe(BOOKER_TPLS)
    wx.showLoading({ title: '提交中' })
    call('createReservation', payload)
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '预约成功', icon: 'success' })
        // 持久化顾客资料，下次预约自动带出（失败不阻断主流程）
        const prof = { name: this.data.name.trim() }
        if (phone) prof.phone = this.data.phone
        call('saveProfile', prof).catch(() => {})
        // 我的预约是 tabBar 页面，必须用 switchTab（redirectTo/navigateTo 对 tabBar 页无效）
        setTimeout(() => wx.switchTab({ url: '/pages/mine/mine' }), 800)
      })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message || '提交失败', icon: 'none' }) })
  }
})
