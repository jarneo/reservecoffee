const { call } = require('../../utils/cloud')

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
  data: { productId: '', product: {}, reviews: [], rating: 5, text: '', posting: false },
  onLoad(q) {
    this.setData({ productId: q.productId || '' })
    this.load()
  },
  load() {
    call('getProduct', { productId: this.data.productId })
      .then(d => {
        const p = { ...d.product, stars: stars(d.product.rating), priceText: '¥' + (d.product.price || 0) }
        const reviews = (d.reviews || []).map(r => ({ ...r, stars: stars(r.rating), time: timeStr(r.createdAt) }))
        this.setData({ product: p, reviews })
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },
  setRating(e) { this.setData({ rating: Number(e.currentTarget.dataset.n) }) },
  onText(e) { this.setData({ text: e.detail.value }) },
  submit() {
    if (this.data.posting) return
    if (!this.data.text.trim()) return wx.showToast({ title: '写点评价吧', icon: 'none' })
    this.setData({ posting: true })
    call('addReview', { productId: this.data.productId, rating: this.data.rating, text: this.data.text })
      .then(() => { wx.showToast({ title: '已提交', icon: 'success' }); this.setData({ text: '' }); this.load() })
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
      .finally(() => this.setData({ posting: false }))
  }
})
