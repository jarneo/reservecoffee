const { call } = require('../../utils/cloud')
const guard = require('../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: { projects: [], projectId: '', dates: [], selDate: '', sessions: [], selSession: '', list: [], detail: null },
  onLoad() { this.guard(['owner', 'manager']).then(r => { if (r) this.loadProjects() }) },
  loadProjects() {
    call('listProjects').then(d => {
      const list = d.list || []
      this.setData({ projects: list })
      if (list.length) this.select(list[0]._id)
    })
  },
  onPick(e) { this.select(this.data.projects[e.detail.value]._id) },
  async select(id) {
    this.setData({ projectId: id })
    const d = await call('getSchedule', { projectId: id })
    const dates = (d.schedules || []).map(s => s.date).sort()
    this.setData({ dates })
    if (dates.length) this.loadDate(dates[0])
  },
  onDate(e) { this.loadDate(e.currentTarget.dataset.d) },
  async loadDate(date) {
    this.setData({ selDate: date, selSession: '', list: [], detail: null })
    const d = await call('getSchedule', { projectId: this.data.projectId, date })
    const sch = (d.schedules || []).find(x => x.date === date)
    this.setData({ sessions: (sch ? sch.sessions : []).map(x => ({ ...x, remaining: x.capacity - x.booked })) })
  },
  onSession(e) { this.loadList(e.currentTarget.dataset.id) },
  async loadList(sessionId) {
    this.setData({ selSession: sessionId, detail: null })
    const d = await call('listSessionReservations', { projectId: this.data.projectId, date: this.data.selDate, sessionId })
    this.setData({ list: d.list || [] })
  },
  showDetail(e) {
    const id = e.currentTarget.dataset.id
    const r = (this.data.list || []).find(x => x._id === id)
    this.setData({ detail: r })
  },
  closeDetail() { this.setData({ detail: null }) },
  dial() { if (this.data.detail) wx.makePhoneCall({ phoneNumber: this.data.detail.phone }) }
})
