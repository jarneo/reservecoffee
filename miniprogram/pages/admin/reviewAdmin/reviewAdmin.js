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
  data: {
    projects: [], projectId: '', projectName: '', products: [], productOptions: [{ _id: '', name: '全部菜品' }], productId: '', productName: '全部菜品',
    reviews: [], tab: 'pending', pendingCount: 0
  },
  onLoad() { this.guard(['owner', 'manager']).then(r => { if (r) this.loadProjects() }) },
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
    this.setData({ projectId: id, projectName: name, productId: '', productName: '全部菜品' })
    call('adminProducts', { projectId: id })
      .then(d => {
        const products = d.products || []
        // 顶部追加「全部菜品」：进入默认展示该项目全部菜品的待审批评价，再按需切换具体菜品筛选
        this.setData({ products, productOptions: [{ _id: '', name: '全部菜品' }].concat(products), productId: '', productName: '全部菜品' })
        this.loadReviews()
      })
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  onProductPick(e) {
    const p = this.data.productOptions[e.detail.value]
    if (!p) return
    this.setData({ productId: p._id, productName: p.name })
    this.loadReviews()
  },
  onTab(e) {
    this.setData({ tab: e.currentTarget.dataset.t })
    this.loadReviews()
  },
  loadReviews() {
    const status = this.data.tab === 'pending' ? 'pending' : ''
    call('adminReviews', { projectId: this.data.projectId, productId: this.data.productId, reviewStatus: status })
      .then(d => {
        const reviews = (d.reviews || []).map(r => {
          const nm = r.name || '微信用户'
          const pending = r.reviewStatus === 'pending'
          const statusText = pending ? '待审核' : (r.reviewStatus === 'rejected' ? '已拒绝' : '已通过')
          return {
            ...r, stars: stars(r.rating), time: timeStr(r.createdAt),
            name: nm, initial: nm.slice(0, 1),
            pending, statusText, imagesUrl: r.imagesUrl || []
          }
        })
        this.setData({ reviews, pendingCount: d.pendingCount || 0 })
        // 解析评价头像 + 图片 fileID → 临时 URL（管理端可见署名头像，便于辨真）
        const ids = [...new Set([
          ...reviews.map(r => r.avatar).filter(Boolean),
          ...reviews.flatMap(r => (r.imagesUrlSrc || r.images || []).filter(Boolean))
        ])]
        if (ids.length) {
          wx.cloud.getTempFileURL({ fileList: ids })
            .then(res => {
              const map = {}
              ;(res.fileList || []).forEach(f => { if (f.fileID) map[f.fileID] = f.tempFileURL })
              const next = this.data.reviews.map(r => ({
                ...r,
                avatarUrl: map[r.avatar] || '',
                imagesUrl: (r.images || []).map(id => map[id] || '')
              }))
              this.setData({ reviews: next })
            })
            .catch(() => {})
        }
      })
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  approve(e) {
    const r = this.data.reviews[e.currentTarget.dataset.i]
    call('setReview', { reviewId: r._id, action: 'approve' })
      .then(() => { wx.showToast({ title: '已通过', icon: 'success' }); this.loadReviews() })
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  reject(e) {
    const r = this.data.reviews[e.currentTarget.dataset.i]
    wx.showModal({
      title: '拒绝评价', content: '拒绝后该评价不会对外展示。', confirmText: '拒绝',
      success: rr => {
        if (!rr.confirm) return
        call('setReview', { reviewId: r._id, action: 'reject' })
          .then(() => { wx.showToast({ title: '已拒绝', icon: 'none' }); this.loadReviews() })
          .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
      }
    })
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
