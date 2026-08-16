const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: {
    projects: [], projectId: '', project: null,
    cover: '', intro: '', _oldCover: ''
  },

  onLoad(options) {
    this.guard(['owner']).then(r => {
      if (r) this.loadProjects(options && options.projectId)
    })
  },

  loadProjects(presetId) {
    call('listProjects').then(d => {
      const list = d.list || []
      this.setData({ projects: list })
      const id = presetId || (list.length ? list[0]._id : '')
      if (id) this.selectProject(id)
    }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },

  onProjectPick(e) {
    const id = this.data.projects[e.detail.value]._id
    this.selectProject(id)
  },

  async selectProject(id) {
    this.setData({ projectId: id })
    const d = await call('getProjectAdmin', { projectId: id })
    const p = d.project
    this.setData({
      project: p,
      cover: p.imageUrl || p.image || '',
      intro: p.intro || '',
      _oldCover: ''
    })
  },

  async uploadOne(tempPath) {
    const ext = (tempPath.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
    const cloudPath = `projects/${this.data.projectId}/${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`
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
      await call('updateProject', { projectId: this.data.projectId, image: cover, intro: this.data.intro || '' })
      if (old && old !== cover) await call('deleteProjectFile', { fileIds: [old] }).catch(() => {})
      this.setData({ _oldCover: '' })
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' })
    } finally { wx.hideLoading() }
  }
})
