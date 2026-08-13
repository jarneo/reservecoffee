const { call } = require('../../utils/cloud')
const { isPhone } = require('../../utils/util')

Page({
  data: {
    projectId: '', date: '', sessionId: '',
    projectName: '', session: null,
    name: '', phone: '', partySize: 1, note: ''
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
          session: sess ? { ...sess, remaining: sess.capacity - sess.booked } : null
        })
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },

  onName(e) { this.setData({ name: e.detail.value }) },
  onPhone(e) { this.setData({ phone: e.detail.value }) },
  onNote(e) { this.setData({ note: e.detail.value }) },

  step(e) {
    const d = Number(e.currentTarget.dataset.d)
    const max = this.data.session ? this.data.session.remaining : 9
    const v = Math.max(1, Math.min(max, this.data.partySize + d))
    this.setData({ partySize: v })
  },

  submit() {
    const { name, phone, partySize, note } = this.data
    if (!name.trim()) return wx.showToast({ title: '请填写称呼', icon: 'none' })
    if (!isPhone(phone)) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' })
    wx.showLoading({ title: '提交中' })
    call('createReservation', {
      projectId: this.data.projectId, date: this.data.date, sessionId: this.data.sessionId,
      name, phone, partySize, note
    })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '预约成功', icon: 'success' })
        setTimeout(() => wx.redirectTo({ url: '/pages/mine/mine' }), 800)
      })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message || '提交失败', icon: 'none' }) })
  }
})
