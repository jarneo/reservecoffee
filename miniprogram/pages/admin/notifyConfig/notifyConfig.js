const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: {
    subList: [
      { key: 'reserveSuccess', label: '预约成功（顾客）' },
      { key: 'reserveCancel', label: '取消（顾客）' },
      { key: 'reminder', label: '开场前提醒（顾客）' },
      { key: 'reminderEnd', label: '结束提醒（顾客）' },
      { key: 'adminNew', label: '新预约（管理员）' },
      { key: 'adminCancel', label: '取消（管理员）' },
      { key: 'adminReview', label: '待审核（管理员）' }
    ],
    sub: {}
  },
  onLoad() {
    this.guard(['owner']).then(role => {
      if (!role) return
      call('getNotifyConfig').then(d => {
        const sub = d.subscribe || {}
        const subKeys = this.data.subList.map(x => x.key)
        const subObj = {}; subKeys.forEach(k => { subObj[k] = sub[k] !== false })
        this.setData({ sub: subObj })
      }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
    })
  },
  toggleSub(e) { this.setData({ [`sub.${e.currentTarget.dataset.k}`]: e.detail.value }) },
  goSms() { wx.navigateTo({ url: '/pages/admin/smsConfig/smsConfig' }) },
  save() {
    const d = this.data
    const sub = {}; d.subList.forEach(it => { sub[it.key] = !!d.sub[it.key] })
    wx.showLoading({ title: '保存中' })
    call('saveNotifyConfig', { subscribe: sub }).then(() => {
      wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' })
    }).catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  }
})
