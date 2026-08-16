const { call } = require('../../utils/cloud')

function stars(n) {
  const r = Math.round(Number(n) || 0)
  const c = Math.max(0, Math.min(5, r))
  return '★'.repeat(c) + '☆'.repeat(5 - c)
}

Page({
  data: { projectId: '', products: [] },
  onLoad(q) {
    this.setData({ projectId: q.projectId || '' })
    this.load()
  },
  load() {
    if (!this.data.projectId) return wx.showToast({ title: '缺少项目', icon: 'none' })
    call('listProducts', { projectId: this.data.projectId })
      .then(d => {
        const products = (d.products || []).map(p => ({
          ...p, stars: stars(p.rating), priceText: '¥' + (p.price || 0)
        }))
        this.setData({ products })
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },
  goProduct(e) {
    wx.navigateTo({ url: '/pages/product/product?productId=' + e.currentTarget.dataset.id })
  }
})
