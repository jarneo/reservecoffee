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
    // 评价署名：昵称 / 头像（fileID + 预览 URL）/ 是否改名
    pName: '', pAvatar: '', pAvatarFile: '', pAvatarChanged: false
  },
  onLoad(q) {
    this.setData({ productId: q.productId || '' })
    this.load()
    this.loadMyReviewProfile()
  },
  load() {
    call('getProduct', { productId: this.data.productId })
      .then(d => {
        const p = { ...d.product, stars: stars(d.product.rating), priceText: '¥' + (d.product.price || 0) }
        const reviews = (d.reviews || []).map(r => {
        const nm = r.anonymous ? '微信用户' : (r.name || '微信用户')
        return { ...r, stars: stars(r.rating), time: timeStr(r.createdAt), name: nm, initial: nm.slice(0, 1) }
      })
        this.setData({ product: p, reviews })
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },
  // 预填评价署名：优先取「我的资料」里的昵称/头像（已授权过的直接带出），可改
  loadMyReviewProfile() {
    call('getMyProfile')
      .then(d => {
        if (d && d.profile) {
          const p = d.profile
          this.setData({ pName: (this.data.pName && this.data.pName.trim()) || p.name || '' })
          if (p.avatar) {
            this.setData({ pAvatarFile: p.avatar })
            wx.cloud.getTempFileURL({ fileList: [p.avatar] })
              .then(r => {
                const url = r.fileList && r.fileList[0] && r.fileList[0].tempFileURL
                if (url) this.setData({ pAvatar: url })
              })
              .catch(() => {})
          }
        }
      })
      .catch(() => {})
  },
  setRating(e) { this.setData({ rating: Number(e.currentTarget.dataset.n) }) },
  onText(e) { this.setData({ text: e.detail.value }) },
  onPName(e) { this.setData({ pName: e.detail.value }) },
  onChooseAvatar(e) {
    const url = e.detail.avatarUrl
    if (url) this.setData({ pAvatar: url, pAvatarChanged: true })
  },
  submit() {
    if (this.data.posting) return
    if (!this.data.text.trim()) return wx.showToast({ title: '写点评价吧', icon: 'none' })
    this.setData({ posting: true })

    const doCall = (avatarFile) => {
      call('addReview', {
        productId: this.data.productId,
        rating: this.data.rating,
        text: this.data.text,
        name: this.data.pName,
        avatar: avatarFile
      })
        .then(() => {
          wx.showToast({ title: '已提交', icon: 'success' })
          this.setData({ text: '', pAvatarChanged: false })
          this.load()
        })
        .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
        .finally(() => this.setData({ posting: false }))
    }

    // 若重新选了头像则上传为新 fileID；否则复用资料里的头像 fileID
    if (this.data.pAvatarChanged) {
      const oid = (app.globalData && app.globalData.openid) || Date.now()
      wx.cloud.uploadFile({ cloudPath: `avatars/${oid}_${Date.now()}.png`, filePath: this.data.pAvatar })
        .then(res => doCall(res.fileID))
        .catch(() => doCall(this.data.pAvatarFile))
    } else {
      doCall(this.data.pAvatarFile)
    }
  }
})
