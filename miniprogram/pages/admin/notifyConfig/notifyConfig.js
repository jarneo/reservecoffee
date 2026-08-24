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
    sub: {},
    smsList: [
      { key: 'success', label: '预定成功短信（顾客）' },
      { key: 'approaching', label: '预约临近短信（顾客）' },
      { key: 'expired', label: '预约过期短信（顾客）' }
    ],
    sms: {},
    expiredDelay: 0
  },
  onLoad() {
    this.guard(['owner']).then(role => {
      if (!role) return
      call('getNotifyConfig').then(d => {
        const sub = d.subscribe || {}
        const subKeys = this.data.subList.map(x => x.key)
        const subObj = {}; subKeys.forEach(k => { subObj[k] = sub[k] !== false })
        const sms = d.sms || {}
        const smsKeys = this.data.smsList.map(x => x.key)
        const smsObj = {}; smsKeys.forEach(k => { smsObj[k] = sms[k] !== false })
        this.setData({ sub: subObj, sms: smsObj, expiredDelay: sms.expiredDelay || 0 })
      }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
    })
  },
  toggleSub(e) { this.setData({ [`sub.${e.currentTarget.dataset.k}`]: e.detail.value }) },
  toggleSms(e) { this.setData({ [`sms.${e.currentTarget.dataset.k}`]: e.detail.value }) },
  onExpiredDelay(e) { this.setData({ expiredDelay: Number(e.detail.value) || 0 }) },
  goSms() { wx.navigateTo({ url: '/pages/admin/smsConfig/smsConfig' }) },
  save() {
    const d = this.data
    const sub = {}; d.subList.forEach(it => { sub[it.key] = !!d.sub[it.key] })
    const sms = {}; d.smsList.forEach(it => { sms[it.key] = !!d.sms[it.key] })
    sms.expiredDelay = d.expiredDelay
    wx.showLoading({ title: '保存中' })
    call('saveNotifyConfig', { subscribe: sub, sms }).then(() => {
      wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' })
    }).catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  }
})
