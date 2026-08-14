const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

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
    call('listProjects').then(d => this.setData({ list: d.list || [] })).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
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
  }
})
