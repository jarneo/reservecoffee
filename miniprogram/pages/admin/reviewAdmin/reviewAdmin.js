const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

function stars(n) {
  const r = Math.round(Number(n) || 0)
  const c = Math.max(0, Math.min(5, r))
  return '★'.repeat(c) + '☆'.repeat(5 - c)
}
function timeStr(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

Page({
  behaviors: [guard],
  data: { projects: [], projectId: '', projectName: '', products: [], productId: '', productName: '', reviews: [] },
  onLoad() { this.guard(['owner']).then(r => { if (r) this.loadProjects() }) },
  loadProjects() {
    call('listProjects').then(d => {
      const list = d.list || []
      this.setData({ projects: list })
      if (list.length) this.selectProject(list[0]._id)
    })
  },
  onProjectPick(e) { this.selectProject(this.data.projects[e.detail.value]._id) },
  selectProject(id) {
    const name = (this.data.projects.find(x => x._id === id) || {}).name || ''
    this.setData({ projectId: id, projectName: name })
    call('adminProducts', { projectId: id })
      .then(d => {
        const products = d.products || []
        const first = products[0]
        this.setData({ products, productId: first ? first._id : '', productName: first ? first.name : '' })
        this.loadReviews()
      })
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  onProductPick(e) {
    const p = this.data.products[e.detail.value]
    this.setData({ productId: p._id, productName: p.name })
    this.loadReviews()
  },
  loadReviews() {
    call('adminReviews', { projectId: this.data.projectId, productId: this.data.productId })
      .then(d => {
        const reviews = (d.reviews || []).map(r => ({ ...r, stars: stars(r.rating), time: timeStr(r.createdAt) }))
        this.setData({ reviews })
      })
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  toggleTop(e) {
    const r = this.data.reviews[e.currentTarget.dataset.i]
    call('setReview', { reviewId: r._id, action: 'top', value: !r.top })
      .then(() => this.loadReviews()).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  toggleHide(e) {
    const r = this.data.reviews[e.currentTarget.dataset.i]
    call('setReview', { reviewId: r._id, action: 'hide', value: r.status === 'hidden' ? false : true })
      .then(() => this.loadReviews()).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  del(e) {
    const r = this.data.reviews[e.currentTarget.dataset.i]
    wx.showModal({
      title: '删除评价', content: '删除后不可恢复。', confirmText: '删除',
      success: rr => {
        if (!rr.confirm) return
        call('setReview', { reviewId: r._id, action: 'delete' })
          .then(() => this.loadReviews()).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
      }
    })
  }
})
