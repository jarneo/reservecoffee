const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: {
    cover: '', intro: '', _oldCover: ''
  },

  onLoad() {
    this.guard(['owner']).then(r => {
      if (r) this.load()
    })
  },

  // 首图及介绍是「首页级」配置（单份），不是某个项目的配置，故无项目切换。
  async load() {
    try {
      const d = await call('getHomepage')
      const hp = d.homepage || {}
      this.setData({ cover: hp.heroImage || '', intro: hp.intro || '', _oldCover: '' })
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' })
    }
  },

  async uploadOne(tempPath) {
    const ext = (tempPath.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
    const cloudPath = `homepage/${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`
    const res = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath })
    return res.fileID
  },

  pickCover() {
    const old = this.data.cover
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: async (r) => {
        wx.showLoading({ title: '上传中' })
        try {
          const fileId = await this.uploadOne(r.tempFiles[0].tempFilePath)
          this.setData({ cover: fileId, _oldCover: old || '' })
          wx.showToast({ title: '已选择，记得保存', icon: 'none' })
        } catch (e) {
          wx.showToast({ title: '上传失败', icon: 'none' })
        } finally { wx.hideLoading() }
      }
    })
  },
  clearCover() {
    this.setData({ _oldCover: this.data.cover || '', cover: '' })
  },
  onIntro(e) { this.setData({ intro: e.detail.value }) },
  async saveCoverIntro() {
    const old = this.data._oldCover
    const cover = this.data.cover || ''
    wx.showLoading({ title: '保存中' })
    try {
      await call('updateHomepage', { heroImage: cover, intro: this.data.intro || '' })
      if (old && old !== cover) await call('deleteProjectFile', { fileIds: [old] }).catch(() => {})
      this.setData({ _oldCover: '' })
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' })
    } finally { wx.hideLoading() }
  }
})
