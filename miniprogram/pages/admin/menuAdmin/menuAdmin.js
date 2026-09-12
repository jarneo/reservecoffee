const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: {
    projects: [], projectId: '', projectName: '', products: [],
    showForm: false, editingId: '',
    form: { name: '', price: '', desc: '', status: true, image: '', imageUrl: '', sort: 0 }
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
  // 关闭菜品新建/编辑弹出层（点遮罩 / ✕ 触发）
  closeForm() { this.setData({ showForm: false }) },
  noop() {},
  selectProject(id) {
    const name = (this.data.projects.find(x => x._id === id) || {}).name || ''
    this.setData({ projectId: id, projectName: name, showForm: false })
    this.loadProducts()
  },
  loadProducts() {
    call('adminProducts', { projectId: this.data.projectId })
      .then(d => {
        const products = (d.products || []).map(p => ({ ...p, priceText: '¥' + (p.price || 0) }))
        this.setData({ products })
      })
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  openNew() {
    const maxSort = this.data.products.reduce((m, p) => Math.max(m, Number(p.sort) || 0), 0)
    this.setData({ showForm: true, editingId: '', form: { name: '', price: '', desc: '', status: true, image: '', imageUrl: '', sort: maxSort + 1 } })
  },
  openEdit(e) {
    const p = this.data.products[e.currentTarget.dataset.i]
    this.setData({
      showForm: true, editingId: p._id,
      form: { name: p.name, price: String(p.price), desc: p.desc || '', status: p.status !== 'off', image: p.image || '', imageUrl: p.imageUrl || '', sort: (p.sort != null ? p.sort : 0) }
    })
  },
  onName(e) { this.setData({ 'form.name': e.detail.value }) },
  onPrice(e) { this.setData({ 'form.price': e.detail.value }) },
  onDesc(e) { this.setData({ 'form.desc': e.detail.value }) },
  onSort(e) { this.setData({ 'form.sort': e.detail.value }) },
  onStatus(e) { this.setData({ 'form.status': e.detail.value }) },
  pickImage() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: async (r) => {
        wx.showLoading({ title: '上传中' })
        try {
          const tp = r.tempFiles[0].tempFilePath
          const ext = (tp.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
          const cloudPath = `products/${this.data.projectId}/${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`
          const res = await wx.cloud.uploadFile({ cloudPath, filePath: tp })
          this.setData({ 'form.image': res.fileID })
          const urlRes = await wx.cloud.getTempFileURL({ fileList: [res.fileID] })
          const u = (urlRes.fileList || [])[0]
          this.setData({ 'form.imageUrl': (u && u.tempFileURL) ? u.tempFileURL : '' })
        } catch (err) {
          wx.showToast({ title: '上传失败', icon: 'none' })
        } finally { wx.hideLoading() }
      }
    })
  },
  save() {
    const f = this.data.form
    if (!f.name.trim()) return wx.showToast({ title: '请填写名称', icon: 'none' })
    if (!(Number(f.price) >= 0)) return wx.showToast({ title: '价格无效', icon: 'none' })
    if (!f.image) return wx.showToast({ title: '请上传图片', icon: 'none' })
    wx.showLoading({ title: '保存中' })
    call('saveProduct', {
      projectId: this.data.projectId, productId: this.data.editingId || undefined,
      name: f.name, price: Number(f.price), desc: f.desc, status: f.status ? 'on' : 'off', image: f.image,
      sort: (f.sort === '' || f.sort == null) ? 0 : Number(f.sort)
    })
      .then(() => { wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' }); this.setData({ showForm: false }); this.loadProducts() })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  toggleStatus(e) {
    const p = this.data.products[e.currentTarget.dataset.i]
    wx.showLoading({ title: '更新中' })
    call('saveProduct', { projectId: this.data.projectId, productId: p._id, status: p.status === 'off' ? 'on' : 'off' })
      .then(() => { wx.hideLoading(); this.loadProducts() })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  del(e) {
    const p = this.data.products[e.currentTarget.dataset.i]
    wx.showModal({
      title: '删除菜品', content: '将删除菜品及其评价、云存储图片。', confirmText: '删除',
      success: r => {
        if (!r.confirm) return
        wx.showLoading({ title: '删除中' })
        call('deleteProduct', { productId: p._id })
          .then(() => { wx.hideLoading(); this.loadProducts() })
          .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
      }
    })
  }
})
