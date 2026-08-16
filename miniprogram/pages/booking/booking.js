const { call } = require('../../utils/cloud')
const { ymd, dateLabel, WEEK } = require('../../utils/util')

function addDaysDate(n) { const t = new Date(); t.setDate(t.getDate() + n); return t }

Page({
  data: {
    projectId: '', project: {}, introImages: [], schedules: [], openDays: [], advanceDays: 7,
    calYear: 2026, calMonth: 8, selectedDate: '', bizWindow: '', sessions: []
  },

  onLoad(q) {
    this.setData({ projectId: q.projectId })
    this.load()
  },

  load() {
    call('getProject', { projectId: this.data.projectId })
      .then(d => {
        const p = d.project
        const sched = d.schedules || []
        const openDays = p.openDays || []
        const adv = p.advanceDays || 7
        const now = new Date()
        this.setData({
          project: p, introImages: p.introImages || [], schedules: sched,
          openDays, advanceDays: adv,
          calYear: now.getFullYear(), calMonth: now.getMonth() + 1
        })
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },

  // 点击介绍图放大预览
  previewIntro(e) {
    const i = e.currentTarget.dataset.i
    const imgs = this.data.introImages
    const urls = imgs.map(x => x.url).filter(Boolean)
    if (!urls.length) return
    wx.previewImage({ current: urls[i] || urls[0], urls })
  },

  onCalSelect(e) {
    const y = e.detail.ymd
    if (!this.data.openDays.includes(y)) return wx.showToast({ title: '该日暂未开放', icon: 'none' })
    const max = ymd(addDaysDate(this.data.advanceDays))
    if (y > max) return wx.showToast({ title: '超出可预约范围（提前 ' + this.data.advanceDays + ' 天）', icon: 'none' })
    const s = this.data.schedules.find(x => x.date === y)
    const sessions = (s ? s.sessions : []).map(x => ({ ...x, remaining: x.capacity - x.booked }))
    let win = ''
    if (s && s.sessions.length) {
      const starts = s.sessions.map(t => t.start).sort()
      const ends = s.sessions.map(t => t.end).sort()
      win = starts[0] + ' – ' + ends[ends.length - 1]
    }
    this.setData({ selectedDate: y, sessions, bizWindow: win })
  },

  pickSession(e) {
    const sid = e.currentTarget.dataset.id
    const s = this.data.sessions.find(x => x.id === sid)
    if (!s || s.paused || s.remaining <= 0) return
    wx.navigateTo({ url: `/pages/confirm/confirm?projectId=${this.data.projectId}&date=${this.data.selectedDate}&sessionId=${sid}` })
  },

  // 跳转到店铺菜单（独立页面）
  goMenu() {
    wx.navigateTo({ url: '/pages/menu/menu?projectId=' + this.data.projectId })
  }
})
