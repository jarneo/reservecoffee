const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

// 偏移选项 → 索引
function approachingIdx(offset) {
  if (offset === 30) return 0
  if (offset === 60) return 1
  return 2 // 自定义
}
function expiredIdx(offset) {
  if (offset === 5) return 0
  if (offset === 15) return 1
  if (offset === 30) return 2
  return 3 // 自定义
}

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
    // 短信全局配置（含发送时间）
    sms: {
      success: true, successDelay: 0,
      approaching: true, approachingWhen: 'before', approachingOffset: 60,
      expired: true, expiredWhen: 'after', expiredOffset: 5
    },
    // 选择器展示用选项与索引
    approachingWhenOpts: ['开始前', '开始后'],
    approachingOffsetOpts: ['30分钟', '60分钟', '自定义'],
    expiredWhenOpts: ['结束前', '结束后'],
    expiredOffsetOpts: ['5分钟', '15分钟', '30分钟', '自定义'],
    approachingOffsetIdx: 1,
    expiredOffsetIdx: 0
  },
  onLoad() {
    this.guard(['owner']).then(role => {
      if (!role) return
      call('getNotifyConfig').then(d => {
        const sub = d.subscribe || {}
        const subKeys = this.data.subList.map(x => x.key)
        const subObj = {}; subKeys.forEach(k => { subObj[k] = sub[k] !== false })

        const s = d.sms || {}
        const sms = Object.assign({
          success: true, successDelay: 0,
          approaching: true, approachingWhen: 'before', approachingOffset: 60,
          expired: true, expiredWhen: 'after', expiredOffset: 5
        }, s)
        // 归一化非法值
        if (sms.successDelay !== 10) sms.successDelay = 0
        if (sms.approachingWhen !== 'after') sms.approachingWhen = 'before'
        if (!(sms.approachingOffset > 0)) sms.approachingOffset = 60
        if (sms.expiredWhen !== 'before') sms.expiredWhen = 'after'
        if (!(sms.expiredOffset > 0)) sms.expiredOffset = 5

        this.setData({
          sub: subObj,
          sms,
          approachingOffsetIdx: approachingIdx(sms.approachingOffset),
          expiredOffsetIdx: expiredIdx(sms.expiredOffset)
        })
      }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
    })
  },
  toggleSub(e) { this.setData({ [`sub.${e.currentTarget.dataset.k}`]: e.detail.value }) },
  toggleSms(e) { this.setData({ [`sms.${e.currentTarget.dataset.k}`]: e.detail.value }) },

  // 成功短信：预定成功后延迟（0 / 10 分钟）
  onSuccessDelay(e) { this.setData({ 'sms.successDelay': Number(e.detail.value) || 0 }) },

  // 临近短信：开始前/后 + 偏移
  onApproachingWhen(e) {
    const v = e.detail.value === 1 ? 'after' : 'before'
    this.setData({ 'sms.approachingWhen': v })
  },
  onApproachingOffset(e) {
    const idx = Number(e.detail.value)
    let offset = this.data.sms.approachingOffset
    if (idx === 0) offset = 30
    else if (idx === 1) offset = 60
    // idx === 2 自定义：保留当前偏移值，等待输入框
    this.setData({ 'sms.approachingOffset': offset, approachingOffsetIdx: idx })
  },
  onApproachingCustom(e) { this.setData({ 'sms.approachingOffset': Number(e.detail.value) || 5 }) },

  // 过期短信：结束前/后 + 偏移
  onExpiredWhen(e) {
    const v = e.detail.value === 1 ? 'after' : 'before'
    this.setData({ 'sms.expiredWhen': v })
  },
  onExpiredOffset(e) {
    const idx = Number(e.detail.value)
    let offset = this.data.sms.expiredOffset
    if (idx === 0) offset = 5
    else if (idx === 1) offset = 15
    else if (idx === 2) offset = 30
    // idx === 3 自定义：保留当前偏移值，等待输入框
    this.setData({ 'sms.expiredOffset': offset, expiredOffsetIdx: idx })
  },
  onExpiredCustom(e) { this.setData({ 'sms.expiredOffset': Number(e.detail.value) || 5 }) },

  goSms() { wx.navigateTo({ url: '/pages/admin/smsConfig/smsConfig' }) },
  save() {
    const d = this.data
    const sub = {}; d.subList.forEach(it => { sub[it.key] = !!d.sub[it.key] })
    const sms = Object.assign({}, d.sms)
    wx.showLoading({ title: '保存中' })
    call('saveNotifyConfig', { subscribe: sub, sms }).then(() => {
      wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' })
    }).catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  }
})
