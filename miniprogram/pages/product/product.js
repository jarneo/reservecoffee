const { call } = require('../../utils/cloud')
const app = getApp()

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
  data: {
    productId: '', product: {}, reviews: [],
    rating: 5, text: '', posting: false,
    // 授权与真实署名（要求 1/3）：写评价前必须弹窗授权；拒绝则禁用提交入口
    authState: 'none',   // none | denied
    showAuth: false,
    authorized: false,
    pName: '', pAvatar: '',
    nickFromWx: false,  // 昵称是否来自微信实名（bind:nicknamereview）
    nameLocked: false,  // 昵称是否已锁定（取微信实名或失焦后锁定，不可再改）
    images: [],          // 临时路径
    imageFiles: []       // 已上传 fileID（上传后回填）
  },
  onLoad(q) {
    this.setData({ productId: q.productId || '' })
    this.load()
  },
  load() {
    call('getProduct', { productId: this.data.productId })
      .then(d => {
        const p = { ...d.product, stars: stars(d.product.rating), priceText: '¥' + (d.product.price || 0) }
        const reviews = (d.reviews || []).map(r => {
          const nm = r.name || '微信用户'
          return { ...r, stars: stars(r.rating), time: timeStr(r.createdAt), name: nm, initial: nm.slice(0, 1), imagesUrl: r.imagesUrl || [] }
        })
        this.setData({ product: p, reviews })
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },
  // 写评价入口：未授权先弹窗；已拒绝则提示无入口
  onWrite() {
    if (this.data.authState === 'denied') return wx.showToast({ title: '你已拒绝授权，无法发表评价', icon: 'none' })
    if (!this.data.authorized) return this.setData({ showAuth: true })
  },
  onAuthConfirm() {
    if (!this.data.pAvatar) return wx.showToast({ title: '请获取微信头像', icon: 'none' })
    // 不再依赖 bind:nicknamereview 是否触发：只要昵称有值（无论是微信实名还是手动输入）即可确认；锁定由 nameLocked 控制
    if (!this.data.pName) return wx.showToast({ title: '请填写或选择微信昵称', icon: 'none' })
    this.setData({ showAuth: false, authorized: true, nameLocked: true })
  },
  onAuthCancel() { this.setData({ showAuth: false, authState: 'denied' }) },
  setRating(e) { this.setData({ rating: Number(e.currentTarget.dataset.n) }) },
  onText(e) { this.setData({ text: e.detail.value }) },
  // 昵称：bindinput 填值（微信实名或手动）；bind:nicknamereview 取到微信真实实名则立即锁定；bindblur 失焦后也锁定（防反复修改）
  onPName(e) {
    const v = ((e.detail && e.detail.value) || '').trim()
    if (v) this.setData({ pName: v })
  },
  onNameBlur() {
    if (this.data.pName) this.setData({ nameLocked: true })
  },
  onNickNameReview(e) {
    const n = (e.detail && (e.detail.nickname || e.detail.nickName)) || ''
    if (n) this.setData({ pName: n, nickFromWx: true, nameLocked: true })
  },
  // 重新选择：清空昵称，重新从微信获取（非手填修改）
  resetName() { this.setData({ pName: '', nickFromWx: false, nameLocked: false }) },
  onChooseAvatar(e) {
    const url = e.detail.avatarUrl
    if (url) this.setData({ pAvatar: url })
  },
  chooseImage() {
    wx.chooseMedia({
      count: 9 - this.data.images.length,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: res => {
        const temp = (res.tempFiles || []).map(f => f.tempFilePath)
        this.setData({ images: this.data.images.concat(temp) })
      }
    })
  },
  removeImage(e) {
    const i = e.currentTarget.dataset.i
    const images = this.data.images.slice()
    images.splice(i, 1)
    this.setData({ images })
  },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }) },
  async submit() {
    if (this.data.posting) return
    if (!this.data.authorized) return this.setData({ showAuth: true })
    if (!this.data.pName.trim()) return wx.showToast({ title: '请填写微信昵称', icon: 'none' })
    if (!this.data.pAvatar) return wx.showToast({ title: '请选择微信头像', icon: 'none' })
    if (!this.data.text.trim()) return wx.showToast({ title: '写点评价吧', icon: 'none' })

    this.setData({ posting: true })
    const oid = (app.globalData && app.globalData.openid) || Date.now()
    try {
      // 上传微信头像（chooseAvatar 得到临时路径）
      const avUp = await wx.cloud.uploadFile({ cloudPath: `avatars/${oid}_${Date.now()}.png`, filePath: this.data.pAvatar })
      const avatarFile = avUp.fileID
      // 上传评价图片
      const imageFiles = []
      for (const path of this.data.images) {
        const up = await wx.cloud.uploadFile({ cloudPath: `reviews/${oid}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`, filePath: path })
        imageFiles.push(up.fileID)
      }
      const res = await call('addReview', {
        productId: this.data.productId,
        rating: this.data.rating,
        text: this.data.text,
        name: this.data.pName,
        avatar: avatarFile,
        images: imageFiles
      })
      wx.showToast({ title: (res && res.message) || '已提交，审核通过后展示', icon: 'none' })
      // 保留已授权的微信头像/昵称与授权状态，仅清空本次评价内容，便于继续写评价
      this.setData({ text: '', images: [] })
      this.load()
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' })
    } finally {
      this.setData({ posting: false })
    }
  },

  // 转发给好友 / 分享朋友圈：分享菜品评价页
  onShareAppMessage() {
    const p = this.data.product || {}
    return {
      title: (p.name ? p.name + ' · ' : '') + '二曜路8号咖啡和清酒 · 菜品评价',
      path: '/pages/product/product?productId=' + (this.data.productId || '')
    }
  },
  onShareTimeline() {
    const p = this.data.product || {}
    return {
      title: (p.name ? p.name + ' · ' : '') + '二曜路8号咖啡和清酒 · 菜品评价',
      query: 'productId=' + (this.data.productId || '')
    }
  }
})
