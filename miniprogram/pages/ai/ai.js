const { call } = require('../../utils/cloud')
const { requestSubscribe, tmplIdsOfPlan, notifyPlanOf, normalizeSubs } = require('../../utils/subscribe')

let _mid = 0
function mkId() { return ++_mid }

Page({
  data: {
    messages: [],
    draft: '',
    intent: '',            // '' | 'confirm'
    confirmation: null,
    profile: { name: '', phone: '' },
    downgraded: false,
    scrollTo: '',
    success: false,
    successInfo: null,
    sending: false
  },

  onLoad(q) {
    const pid = (q && q.projectId) || ''
    this.projectId = pid
    const welcome = pid
      ? '我是 AI 预约助理，可以帮你完成预约或解答疑问～想约哪个时段直接说就行。'
      : '我是 AI 预约助理，可以帮你预约或解答疑问。试着说「明天两点，两人，法兰绒深烘」？'
    this.setData({ messages: [{ id: mkId(), role: 'assistant', content: welcome }] })
  },

  onDraft(e) { this.setData({ draft: e.detail.value }) },

  scrollBottom() {
    const len = this.data.messages.length
    if (len) this.setData({ scrollTo: 'm' + this.data.messages[len - 1].id })
  },

  async send() {
    const text = (this.data.draft || '').trim()
    if (!text || this.data.sending) return
    const userMsg = { id: mkId(), role: 'user', content: text }
    const msgs = this.data.messages.concat(userMsg)
    this.setData({ messages: msgs, draft: '', sending: true })
    this.scrollBottom()
    try {
      const res = await call('aiReserve', {
        messages: msgs.map(m => ({ role: m.role, content: m.content })),
        projectId: this.projectId
      })
      this.handleResult(res)
    } catch (e) {
      // 服务可用性降级（spec §5.5）：展示降级提示卡，提供「进入常规预约」，不阻断用户
      const tip = { id: mkId(), role: 'assistant', content: '抱歉，AI 助理暂时连接不上。您可以改用常规预约，不影响操作～' }
      this.setData({ downgraded: true, messages: this.data.messages.concat(tip) })
      this.scrollBottom()
    } finally {
      this.setData({ sending: false })
    }
  },

  quick(e) {
    this.setData({ draft: e.currentTarget.dataset.q }, () => this.send())
  },

  handleResult(res) {
    if (!res) return
    if (res.intent === 'confirm') {
      const assistantMsg = { id: mkId(), role: 'assistant', content: res.reply }
      this.setData({
        messages: this.data.messages.concat(assistantMsg),
        intent: 'confirm',
        confirmation: res.confirmation,
        profile: res.profile || { name: '', phone: '' }
      })
      this.scrollBottom()
      return
    }
    const reply = res.reply || (res.intent === 'ask' ? '请补充一下信息～' : '好的～')
    this.setData({
      messages: this.data.messages.concat([{ id: mkId(), role: 'assistant', content: reply }]),
      intent: ''
    })
    this.scrollBottom()
  },

  cancelConfirm() {
    this.setData({ intent: '', confirmation: null })
    this.setData({ messages: this.data.messages.concat([{ id: mkId(), role: 'assistant', content: '好的，已取消本次确认。您还想约什么？' }]) })
    this.scrollBottom()
  },

  async confirm() {
    const c = this.data.confirmation
    if (!c) return
    wx.showLoading({ title: '提交中' })
    try {
      const d = await call('getProject', { projectId: c.projectId })
      const plan = notifyPlanOf({ date: c.date, sessionStart: c.sessionStart, sessionEnd: c.sessionEnd }, d.notifyCfg)
      const ids = tmplIdsOfPlan(plan, null)
      if (ids.length) { try { await requestSubscribe(ids) } catch (e) { /* 订阅失败不阻断 */ } }
      const payload = { projectId: c.projectId, date: c.date, sessionId: c.sessionId, name: this.data.profile.name, partySize: c.partySize }
      if (this.data.profile.phone) payload.phone = this.data.profile.phone
      const r = await call('createReservation', { ...payload, subscribed: normalizeSubs({}) })
      wx.hideLoading()
      const needReview = r && r.review === 'pending'
      this.setData({
        intent: '',
        success: true,
        successInfo: { projectName: c.projectName, date: c.date, sessionStart: c.sessionStart, sessionEnd: c.sessionEnd, partySize: c.partySize, needReview }
      })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: e.message || '预约失败', icon: 'none' })
    }
  },

  goMine() { wx.switchTab({ url: '/pages/mine/mine' }) },
  closeSuccess() { wx.reLaunch({ url: '/pages/index/index' }) },
  goBooking() {
    const pid = this.projectId || ''
    wx.navigateTo({ url: '/pages/booking/booking' + (pid ? ('?projectId=' + pid) : '') })
  }
})
