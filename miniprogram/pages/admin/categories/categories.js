// pages/admin/categories — 菜单分类管理（仅 owner）：列表 / 新建 / 编辑 / 删除（含引用拦截）
const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: {
    categories: [],
    showForm: false, editingId: '',
    form: { name: '', sort: 0 }
  },
  onLoad() { this.guard(['owner']).then(r => { if (r) this.load() }) },
  load() {
    call('listCategories').then(d => { this.setData({ categories: d.categories || [] }) })
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  openNew() {
    const maxSort = this.data.categories.reduce((m, c) => Math.max(m, Number(c.sort) || 0), 0)
    this.setData({ showForm: true, editingId: '', form: { name: '', sort: maxSort + 1 } })
  },
  openEdit(e) {
    const c = this.data.categories[e.currentTarget.dataset.i]
    this.setData({ showForm: true, editingId: c._id, form: { name: c.name, sort: c.sort != null ? c.sort : 0 } })
  },
  closeForm() { this.setData({ showForm: false }) },
  noop() {},
  onName(e) { this.setData({ 'form.name': e.detail.value }) },
  onSort(e) { this.setData({ 'form.sort': e.detail.value }) },
  save() {
    const f = this.data.form
    if (!f.name.trim()) return wx.showToast({ title: '请填写类目名称', icon: 'none' })
    wx.showLoading({ title: '保存中' })
    call('saveCategory', { categoryId: this.data.editingId || undefined, name: f.name, sort: Number(f.sort) || 0 })
      .then(() => { wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' }); this.setData({ showForm: false }); this.load() })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  del(e) {
    const c = this.data.categories[e.currentTarget.dataset.i]
    wx.showModal({
      title: '删除类目', content: '确定删除「' + c.name + '」？', confirmText: '删除',
      success: r => {
        if (!r.confirm) return
        wx.showLoading({ title: '删除中' })
        call('deleteCategory', { categoryId: c._id })
          .then(() => { wx.hideLoading(); this.load() })
          .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
      }
    })
  }
})
