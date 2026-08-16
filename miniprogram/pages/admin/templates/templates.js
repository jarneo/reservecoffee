const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: {
    list: [],
    showEditor: false,
    editId: '',
    form: { name: '', slots: [{ start: '10:00', end: '11:30', max: 8 }] }
  },
  onLoad() {
    this.guard(['owner']).then(role => { if (role) this.load() })
  },
  load() {
    call('listTemplates')
      .then(d => this.setData({ list: d.list || [] }))
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  openNew() {
    this.setData({ showEditor: true, editId: '', form: { name: '', slots: [{ start: '10:00', end: '11:30', max: 8 }] } })
  },
  openEdit(e) {
    const t = this.data.list.find(x => x._id === e.currentTarget.dataset.id)
    if (!t) return
    this.setData({
      showEditor: true, editId: t._id,
      form: { name: t.name, slots: (t.slots || []).map(s => ({ start: s.start, end: s.end, max: s.max })) }
    })
  },
  onName(e) { this.setData({ 'form.name': e.detail.value }) },
  onStart(e) { const i = e.currentTarget.dataset.i; this.setData({ ['form.slots[' + i + '].start']: e.detail.value }) },
  onEnd(e) { const i = e.currentTarget.dataset.i; this.setData({ ['form.slots[' + i + '].end']: e.detail.value }) },
  onMax(e) { const i = e.currentTarget.dataset.i; this.setData({ ['form.slots[' + i + '].max']: Number(e.detail.value) || 8 }) },
  addSlot() {
    const slots = this.data.form.slots.concat([{ start: '14:00', end: '15:30', max: 8 }])
    this.setData({ form: Object.assign({}, this.data.form, { slots }) })
  },
  removeSlot(e) {
    const i = e.currentTarget.dataset.i
    if (this.data.form.slots.length <= 1) return
    const slots = this.data.form.slots.slice()
    slots.splice(i, 1)
    this.setData({ ['form.slots']: slots })
  },
  closeEditor() { this.setData({ showEditor: false }) },
  noop() {},
  save() {
    const f = this.data.form
    if (!f.name.trim()) return wx.showToast({ title: '请填写模版名称', icon: 'none' })
    wx.showLoading({ title: '保存中' })
    call('saveTemplate', { _id: this.data.editId || undefined, name: f.name.trim(), slots: f.slots })
      .then(() => { wx.hideLoading(); this.setData({ showEditor: false }); this.load(); wx.showToast({ title: '已保存', icon: 'success' }) })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  del(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除模版', content: '删除后不可恢复', confirmText: '删除',
      success: r => {
        if (!r.confirm) return
        call('deleteTemplate', { _id: id })
          .then(() => { this.load(); wx.showToast({ title: '已删除', icon: 'success' }) })
          .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
      }
    })
  }
})
