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
    nickFromWx: false,  // 昵称是否来自微信实名（bind:nicknamereview）；仅此后才允许确认授权
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
    if (!this.data.pName) return wx.showToast({ title: '请填写微信昵称', icon: 'none' })
    // 昵称必须来自微信真实实名，禁止手填/篡改后提交（合规要求：真实微信昵称、不可修改）
    if (!this.data.nickFromWx) return wx.showToast({ title: '请点击键盘上的「使用微信昵称」获取真实昵称', icon: 'none' })
    this.setData({ showAuth: false, authorized: true })
  },
  onAuthCancel() { this.setData({ showAuth: false, authState: 'denied' }) },
  setRating(e) { this.setData({ rating: Number(e.currentTarget.dataset.n) }) },
  onText(e) { this.setData({ text: e.detail.value }) },
  // 昵称：仅接受微信返回的实名（bind:nicknamereview）；bindinput 仅作解锁按钮的兜底，不视为已授权来源
  onPName(e) {
    const v = ((e.detail && e.detail.value) || '').trim()
    if (v) this.setData({ pName: v })
  },
  onNickNameReview(e) {
    const n = (e.detail && e.detail.nickname) || ''
    if (n) this.setData({ pName: n, nickFromWx: true })
  },
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
      this.setData({ text: '', images: [], pAvatar: '', pName: '', nickFromWx: false })
      this.load()
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' })
    } finally {
      this.setData({ posting: false })
    }
  }
})
