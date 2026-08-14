const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

function parseTemplate(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean).map(s => {
    const [start, end] = s.split('-')
    return { start: (start || '').trim(), end: (end || '').trim() }
  }).filter(t => t.start && t.end)
}

Page({
  behaviors: [guard],
  data: {
    projects: [], projectId: '', project: null, openDays: [], selected: [],
    year: 2026, month: 8,
    editDate: '', sessions: [], newSess: { start: '', end: '', capacity: 6 },
    global: { needReview: false, paused: false, dailyLimit: 1, advanceDays: 7, useSlotTemplate: false, slotTemplateText: '' }
  },

  onLoad() { this.guard(['owner']).then(r => { if (r) this.loadProjects() }) },

  loadProjects() {
    call('listProjects').then(d => {
      const list = d.list || []
      this.setData({ projects: list })
      if (list.length) this.selectProject(list[0]._id)
    })
  },

  onProjectPick(e) {
    const id = this.data.projects[e.detail.value]._id
    this.selectProject(id)
  },

  async selectProject(id) {
    this.setData({ projectId: id })
    const d = await call('getProject', { projectId: id })
    const p = d.project
    const now = new Date()
    this.setData({
      project: p, openDays: p.openDays || [], selected: [],
      year: now.getFullYear(), month: now.getMonth() + 1,
      global: {
        needReview: !!p.needReview, paused: !!p.paused, dailyLimit: p.dailyLimit || 1,
        advanceDays: p.advanceDays || 7, useSlotTemplate: !!p.useSlotTemplate,
        slotTemplateText: (p.slotTemplate || []).map(t => t.start + '-' + t.end).join('\n')
      },
      editDate: '', sessions: []
    })
  },

  onCalSelect(e) {
    const ymd = e.detail.ymd
    const sel = this.data.selected.slice()
    const i = sel.indexOf(ymd)
    if (i >= 0) sel.splice(i, 1); else sel.push(ymd)
    this.setData({ selected: sel })
  },
  batchOpen() {
    if (!this.data.selected.length) return wx.showToast({ title: '请先选择日期', icon: 'none' })
    call('setOpenDays', { projectId: this.data.projectId, action: 'open', dates: this.data.selected })
      .then(d => { this.setData({ openDays: d.open, selected: [] }); wx.showToast({ title: '已开放', icon: 'success' }) })
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  batchClose() {
    if (!this.data.selected.length) return wx.showToast({ title: '请先选择日期', icon: 'none' })
    call('setOpenDays', { projectId: this.data.projectId, action: 'close', dates: this.data.selected })
      .then(d => {
        this.setData({ openDays: d.open, selected: [] })
        if (d.protectedDays && d.protectedDays.length) wx.showModal({ title: '部分日期未关闭', content: d.message, showCancel: false })
        else wx.showToast({ title: '已关闭', icon: 'success' })
      }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  clearSel() { this.setData({ selected: [] }) },

  gReview(e) { this.setData({ 'global.needReview': e.detail.value }) },
  gPaused(e) { this.setData({ 'global.paused': e.detail.value }) },
  gTemplate(e) { this.setData({ 'global.useSlotTemplate': e.detail.value }) },
  gDaily(e) { this.setData({ 'global.dailyLimit': Number(e.detail.value) || 1 }) },
  gAdv(e) { this.setData({ 'global.advanceDays': Number(e.detail.value) || 7 }) },
  onSlotText(e) { this.setData({ 'global.slotTemplateText': e.detail.value }) },
  saveGlobal() {
    const g = this.data.global
    const slotTemplate = parseTemplate(g.slotTemplateText)
    if (!(g.advanceDays >= 1 && g.advanceDays <= 30)) return wx.showToast({ title: '提前天数须在1–30', icon: 'none' })
    call('updateProject', {
      projectId: this.data.projectId, needReview: g.needReview, paused: g.paused,
      dailyLimit: g.dailyLimit, advanceDays: g.advanceDays, useSlotTemplate: g.useSlotTemplate, slotTemplate
    }).then(() => wx.showToast({ title: '已保存全局', icon: 'success' }))
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  publish(e) {
    call('publishProject', { projectId: this.data.projectId, published: e.currentTarget.dataset.v })
      .then(() => wx.showToast({ title: e.currentTarget.dataset.v ? '已发布' : '已下架', icon: 'success' }))
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },

  onEditDate(e) {
    this.setData({ editDate: e.detail.value })
    this.loadSessions(e.detail.value)
  },
  async loadSessions(date) {
    if (!date) return this.setData({ sessions: [] })
    const d = await call('getSchedule', { projectId: this.data.projectId, date })
    const sch = (d.schedules || []).find(x => x.date === date)
    this.setData({ sessions: (sch ? sch.sessions : []).map(x => ({ ...x, remaining: x.capacity - x.booked })) })
  },
  onStart(e) { this.setData({ 'newSess.start': e.detail.value }) },
  onEnd(e) { this.setData({ 'newSess.end': e.detail.value }) },
  onCap(e) { this.setData({ 'newSess.capacity': Number(e.detail.value) || 6 }) },
  addSession() {
    const n = this.data.newSess
    if (!this.data.editDate) return wx.showToast({ title: '请先选择日期', icon: 'none' })
    if (!n.start || !n.end) return wx.showToast({ title: '请填写起止时间', icon: 'none' })
    const existing = this.data.sessions.map(s => ({ id: s.id, start: s.start, end: s.end, capacity: s.capacity, paused: s.paused, desc: s.desc }))
    call('setDaySessions', {
      projectId: this.data.projectId, date: this.data.editDate,
      sessions: existing.concat([{ start: n.start, end: n.end, capacity: n.capacity }])
    }).then(() => {
      this.loadSessions(this.data.editDate)
      this.setData({ newSess: { start: '', end: '', capacity: 6 } })
      wx.showToast({ title: '已保存', icon: 'success' })
    }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  onSessionOp(e) { this.handleOp(e.detail.action, e.detail.id) },
  handleOp(action, id) {
    const date = this.data.editDate
    if (action === 'changeCap') {
      wx.showModal({
        title: '修改名额', editable: true, placeholderText: '新名额(须≥已约)',
        success: r => {
          if (r.confirm) call('setSession', { projectId: this.data.projectId, date, sessionId: id, action: 'changeCap', capacity: Number(r.content) })
            .then(() => this.loadSessions(date)).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
        }
      })
    } else if (action === 'cancelAll') {
      wx.showModal({
        title: '取消全部预约', content: '将取消该场次所有有效预约并释放名额', confirmText: '确认',
        success: r => {
          if (r.confirm) call('setSession', { projectId: this.data.projectId, date, sessionId: id, action: 'cancelAll' })
            .then(() => this.loadSessions(date)).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
        }
      })
    } else {
      call('setSession', { projectId: this.data.projectId, date, sessionId: id, action })
        .then(() => this.loadSessions(date)).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
    }
  },
  copyDay() {
    wx.showActionSheet({
      itemList: ['复制到当月', '复制到下周', '复制到下月', '复制到未来6个月'],
      success: r => {
        if (!this.data.editDate) return wx.showToast({ title: '请先选择要复制的日期', icon: 'none' })
        const map = ['month', 'nextWeek', 'nextMonth', 'all']
        call('copyDaySessions', { projectId: this.data.projectId, fromDate: this.data.editDate, target: map[r.tapIndex] })
          .then(() => { this.loadProjects(); wx.showToast({ title: '已复制', icon: 'success' }) })
          .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
      }
    })
  }
})
