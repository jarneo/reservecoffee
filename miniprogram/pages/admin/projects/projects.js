const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

// 最晚可约日期 = 今天 + 提前可预约天数(advanceDays)
function bookableUntil(advanceDays) {
  const d = new Date()
  d.setDate(d.getDate() + (Number(advanceDays) || 0))
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

Page({
  behaviors: [guard],
  data: {
    list: [], showForm: false,
    form: { name: '', intro: '', icon: 'coffee', needReview: false, dailyLimit: 1, advanceDays: 7 },
    icons: ['coffee', 'sake', 'study']
  },
  onLoad() {
    this.guard(['owner']).then(role => { if (role) this.load() })
  },
  load() {
    call('listProjects').then(d => {
      const list = (d.list || []).map(p => Object.assign({}, p, { bookableUntil: bookableUntil(p.advanceDays) }))
      this.setData({ list })
    }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  toggleForm() { this.setData({ showForm: !this.data.showForm }) },
  onName(e) { this.setData({ 'form.name': e.detail.value }) },
  onIntro(e) { this.setData({ 'form.intro': e.detail.value }) },
  pickIcon(e) { this.setData({ 'form.icon': e.currentTarget.dataset.i }) },
  toggleReview(e) { this.setData({ 'form.needReview': e.detail.value }) },
  onDaily(e) { this.setData({ 'form.dailyLimit': Number(e.detail.value) || 1 }) },
  onAdv(e) { this.setData({ 'form.advanceDays': Number(e.detail.value) || 7 }) },
  create() {
    const f = this.data.form
    if (!f.name.trim()) return wx.showToast({ title: '请填写项目名称', icon: 'none' })
    if (!(f.advanceDays >= 1 && f.advanceDays <= 30)) return wx.showToast({ title: '提前天数须在1–30', icon: 'none' })
    wx.showLoading({ title: '创建中' })
    call('createProject', f).then(() => {
      wx.hideLoading(); this.setData({ showForm: false, form: { name: '', intro: '', icon: 'coffee', needReview: false, dailyLimit: 1, advanceDays: 7 } })
      this.load(); wx.showToast({ title: '已创建', icon: 'success' })
    }).catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  goConfig(e) {
    wx.navigateTo({ url: '/pages/admin/projectConfig/projectConfig?projectId=' + e.currentTarget.dataset.id })
  },
  togglePublish(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.find(x => x._id === id)
    if (!item) return
    wx.showLoading({ title: '处理中' })
    call('publishProject', { projectId: id, published: !item.published })
      .then(() => { wx.hideLoading(); this.load(); wx.showToast({ title: item.published ? '已下架' : '已发布', icon: 'success' }) })
      .catch(err => { wx.hideLoading(); wx.showToast({ title: err.message, icon: 'none' }) })
  },
  togglePause(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.find(x => x._id === id)
    if (!item) return
    wx.showLoading({ title: '处理中' })
    call('updateProject', { projectId: id, paused: !item.paused })
      .then(() => { wx.hideLoading(); this.load(); wx.showToast({ title: item.paused ? '已开放预约' : '已暂停预约', icon: 'success' }) })
      .catch(err => { wx.hideLoading(); wx.showToast({ title: err.message, icon: 'none' }) })
  },
  deleteProject(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.find(x => x._id === id)
    if (!item) return
    wx.showModal({
      title: '删除项目',
      content: '将标记为「已删除」（可恢复），不影响历史预约记录。',
      confirmText: '删除',
      success: r => {
        if (!r.confirm) return
        wx.showLoading({ title: '处理中' })
        call('updateProject', { projectId: id, deleted: true })
          .then(() => { wx.hideLoading(); this.load(); wx.showToast({ title: '已删除', icon: 'success' }) })
          .catch(err => { wx.hideLoading(); wx.showToast({ title: err.message, icon: 'none' }) })
      }
    })
  },
  restoreProject(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.find(x => x._id === id)
    if (!item) return
    wx.showLoading({ title: '处理中' })
    call('updateProject', { projectId: id, deleted: false })
      .then(() => { wx.hideLoading(); this.load(); wx.showToast({ title: '已恢复', icon: 'success' }) })
      .catch(err => { wx.hideLoading(); wx.showToast({ title: err.message, icon: 'none' }) })
  }
})
