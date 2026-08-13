const { call } = require('../../utils/cloud')
const { ymd, dateLabel, WEEK } = require('../../utils/util')

function addDaysDate(n) { const t = new Date(); t.setDate(t.getDate() + n); return t }

Page({
  data: {
    projectId: '', project: {}, schedules: [], openDays: [], advanceDays: 7,
    dayGrid: [], selectedDate: '', bizWindow: '', sessions: []
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
        const max = ymd(addDaysDate(adv))
        const grid = []
        for (let i = 0; i < 14; i++) {
          const dt = addDaysDate(i)
          const y = ymd(dt)
          const open = openDays.includes(y) && y <= max
          grid.push({ y, dayNum: dt.getDate(), wd: WEEK[dt.getDay()], open, disabled: !open })
        }
        this.setData({ project: p, schedules: sched, openDays, advanceDays: adv, dayGrid: grid })
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },

  pickDay(e) {
    const y = e.currentTarget.dataset.y
    const cell = this.data.dayGrid.find(c => c.y === y)
    if (!cell || !cell.open) return
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
  }
})
