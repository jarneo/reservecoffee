const { call } = require('../../utils/cloud')
const { isPhone, requestSubscribe } = require('../../utils/util')
const { BOOKER_TPLS } = require('../../utils/subscribe')

Page({
  data: {
    projectId: '', date: '', sessionId: '',
    projectName: '', session: null,
    name: '', phone: '', partySize: 1, note: '', maxParty: 2
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
        this.setData({
          projectName: p.name,
          session: sess ? { ...sess, remaining: sess.capacity - sess.booked } : null,
          maxParty: p.maxParty || 2
        })
        this.prefill()
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },

  // 从 users 集合预填称呼/手机号（仅当本页尚未输入时），实现"下次预约自动带出"
  prefill() {
    call('getMyProfile')
      .then(d => {
        if (d && d.profile) {
          const patch = {}
          if (d.profile.name && !this.data.name) patch.name = d.profile.name
          if (d.profile.phone && !this.data.phone) patch.phone = d.profile.phone
          if (Object.keys(patch).length) this.setData(patch)
        }
      })
      .catch(() => {})
  },

  onName(e) { this.setData({ name: e.detail.value }) },
  onPhone(e) { this.setData({ phone: e.detail.value }) },
  onNote(e) { this.setData({ note: e.detail.value }) },

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
    const { name, phone, partySize, note } = this.data
    if (!name.trim()) return wx.showToast({ title: '请填写称呼', icon: 'none' })
    if (!isPhone(phone)) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' })
    // 必须在用户点击手势内同步请求订阅授权（成功/取消/开场提醒），否则微信会拦截导致授权失败、收不到推送
    requestSubscribe(BOOKER_TPLS)
    wx.showLoading({ title: '提交中' })
    call('createReservation', {
      projectId: this.data.projectId, date: this.data.date, sessionId: this.data.sessionId,
      name, phone, partySize, note
    })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '预约成功', icon: 'success' })
        // 持久化顾客资料，下次预约自动带出（失败不阻断主流程）
        call('saveProfile', { name: this.data.name.trim(), phone: this.data.phone }).catch(() => {})
        // 我的预约是 tabBar 页面，必须用 switchTab（redirectTo/navigateTo 对 tabBar 页无效）
        setTimeout(() => wx.switchTab({ url: '/pages/mine/mine' }), 800)
      })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message || '提交失败', icon: 'none' }) })
  }
})
