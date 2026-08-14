const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: { role: 'none', projects: [], projectId: '', dates: [], selDate: '', sessions: [], canChangeCap: false },
  onLoad() {
    this.guard(['owner', 'manager']).then(role => {
      if (!role) return
      this.setData({ role, canChangeCap: role === 'owner' })
      this.loadProjects()
    })
  },
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
    this.setData({ selDate: date })
    const d = await call('getSchedule', { projectId: this.data.projectId, date })
    const sch = (d.schedules || []).find(x => x.date === date)
    this.setData({ sessions: (sch ? sch.sessions : []).map(x => ({ ...x, remaining: x.capacity - x.booked })) })
  },
  onOp(e) { this.handleOp(e.detail.action, e.detail.id) },
  handleOp(action, id) {
    const date = this.data.selDate
    if (action === 'changeCap') {
      if (this.data.role !== 'owner') return wx.showToast({ title: '普通管理员不可改名额', icon: 'none' })
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
