const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

const MAX = 6

Page({
  behaviors: [guard],
  data: { enabled: true, saving: false, quick: [] },

  onLoad() {
    this.guard(['owner']).then(role => {
      if (!role) return
      call('getAiConfig').then(d => {
        this.setData({
          enabled: d.enabled !== false,
          quick: (d.quickReplies || []).map((x, i) => ({ _i: i, label: x.label || '', text: x.text || '' }))
        })
      }).catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
    })
  },

  toggle(e) { this.setData({ enabled: !!e.detail.value }) },

  onLabel(e) {
    const i = +e.currentTarget.dataset.i
    this.setData({ ['quick[' + i + '].label']: e.detail.value })
  },
  onText(e) {
    const i = +e.currentTarget.dataset.i
    this.setData({ ['quick[' + i + '].text']: e.detail.value })
  },

  addQuick() {
    const q = this.data.quick.slice()
    if (q.length >= MAX) return
    q.push({ _i: q.length, label: '', text: '' })
    this.setData({ quick: this.reindex(q) })
  },
  rmQuick(e) {
    const q = this.data.quick.slice()
    q.splice(+e.currentTarget.dataset.i, 1)
    this.setData({ quick: this.reindex(q) })
  },
  moveUp(e) {
    const i = +e.currentTarget.dataset.i
    if (i <= 0) return
    const q = this.data.quick.slice()
    const t = q[i]; q[i] = q[i - 1]; q[i - 1] = t
    this.setData({ quick: this.reindex(q) })
  },
  moveDown(e) {
    const i = +e.currentTarget.dataset.i
    const q = this.data.quick.slice()
    if (i >= q.length - 1) return
    const t = q[i]; q[i] = q[i + 1]; q[i + 1] = t
    this.setData({ quick: this.reindex(q) })
  },
  // 增删/换位后重排 _i（wx:key 依赖它，避免列表复用错位）
  reindex(list) { return list.map((x, i) => ({ _i: i, label: x.label || '', text: x.text || '' })) },

  save() {
    if (this.data.saving) return
    const q = this.data.quick
    for (let i = 0; i < q.length; i++) {
      const label = (q[i].label || '').trim()
      const text = (q[i].text || '').trim()
      if (!label || !text) {
        wx.showToast({ title: '第 ' + (i + 1) + ' 条未填写完整', icon: 'none' })
        return
      }
    }
    this.data.saving = true
    wx.showLoading({ title: '保存中' })
    call('saveAiConfig', {
      enabled: this.data.enabled,
      quickReplies: q.map(x => ({ label: (x.label || '').trim(), text: (x.text || '').trim() }))
    })
      .then(() => { wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' }); this.data.saving = false })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message || '保存失败', icon: 'none' }); this.data.saving = false })
  }
})
