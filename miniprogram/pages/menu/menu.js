const { call } = require('../../utils/cloud')

function stars(n) {
  const r = Math.round(Number(n) || 0)
  const c = Math.max(0, Math.min(5, r))
  return '★'.repeat(c) + '☆'.repeat(5 - c)
}

Page({
  data: { projectId: '', shopName: '', shopTag: '图片菜品 · 真实评价', products: [] },
  onLoad(q) {
    this.setData({ projectId: q.projectId || '' })
    this.load()
  },
  load() {
    if (!this.data.projectId) return wx.showToast({ title: '缺少项目', icon: 'none' })
    // 加载项目名作为菜单品牌头（对齐 menu-design.html 的店铺菜单 hero）
    call('getProject', { projectId: this.data.projectId })
      .then(d => { if (d && d.project && d.project.name) this.setData({ shopName: d.project.name }) })
      .catch(() => {})
    // listProducts 已按 status:'on' 过滤，即「在售菜品」
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
  },

  // 转发给好友 / 分享朋友圈：分享菜品菜单
  onShareAppMessage() {
    const name = this.data.shopName || '二曜路8号咖啡和清酒'
    return { title: name + ' · 菜单', path: '/pages/menu/menu?projectId=' + (this.data.projectId || '') }
  },
  onShareTimeline() {
    const name = this.data.shopName || '二曜路8号咖啡和清酒'
    return { title: name + ' · 菜单', query: 'projectId=' + (this.data.projectId || '') }
  }
})
