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
// 取消短信延迟 → 索引
function cancelDelayIdx(delay) {
  if (delay === 0) return 0
  if (delay === 3) return 1
  if (delay === 5) return 2
  if (delay === 10) return 3
  return 1
}

Page({
  behaviors: [guard],
  data: {
    subList: [
      { key: 'reserveSuccess', label: '预约成功（顾客）' },
      { key: 'reserveCancel', label: '取消（顾客）' },
      { key: 'reminder', label: '开场前提醒（顾客）' },
      { key: 'reminderEnd', label: '结束提醒（顾客）' },
      { key: 'dayBefore', label: '前一天提醒（顾客）' },
      { key: 'adminNew', label: '新预约（管理员）' },
      { key: 'adminCancel', label: '取消（管理员）' },
      { key: 'adminReview', label: '待审核（管理员）' }
    ],
    sub: {},
    smsList: [
      { key: 'success', label: '预定成功短信（顾客）' },
      { key: 'approaching', label: '预约临近短信（顾客）' },
      { key: 'expired', label: '预约过期短信（顾客）' },
      { key: 'dayBefore', label: '前一天提醒短信（顾客）' },
      { key: 'cancel', label: '取消通知短信（顾客）' }
    ],
    // 短信全局配置（含发送时间 + 微信优先降级）
    sms: {
      success: true, successDelay: 0,
      approaching: true, approachingWhen: 'before', approachingOffset: 60,
      expired: true, expiredWhen: 'after', expiredOffset: 5,
      dayBefore: true, dayBeforeAt: '17:30',
      cancel: true, cancelDelay: 3,
      skipSmsIfWxOk: false
    },
    // 选择器展示用选项与索引
    approachingWhenOpts: ['开始前', '开始后'],
    approachingOffsetOpts: ['30分钟', '60分钟', '自定义'],
    expiredWhenOpts: ['结束前', '结束后'],
    expiredOffsetOpts: ['5分钟', '15分钟', '30分钟', '自定义'],
    dayBeforeHourOpts: ['16', '17', '18', '19', '20'],
    dayBeforeMinuteOpts: ['00', '15', '30', '45'],
    cancelDelayOpts: ['立即（下一轮 15 分钟内）', '3 分钟', '5 分钟', '10 分钟'],
    approachingOffsetIdx: 1,
    expiredOffsetIdx: 0,
    dayBeforeHourIdx: 1,
    dayBeforeMinuteIdx: 2,
    cancelDelayIdx: 1
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
          expired: true, expiredWhen: 'after', expiredOffset: 5,
          dayBefore: true, dayBeforeAt: '17:30',
          cancel: true, cancelDelay: 3,
          skipSmsIfWxOk: false
        }, s)
        // 归一化非法值
        if (sms.successDelay !== 10) sms.successDelay = 0
        if (sms.approachingWhen !== 'after') sms.approachingWhen = 'before'
        if (!(sms.approachingOffset > 0)) sms.approachingOffset = 60
        if (sms.expiredWhen !== 'before') sms.expiredWhen = 'after'
        if (!(sms.expiredOffset > 0)) sms.expiredOffset = 5
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sms.dayBeforeAt || '')) sms.dayBeforeAt = '17:30'
        if (!(sms.cancelDelay >= 0)) sms.cancelDelay = 3
        sms.skipSmsIfWxOk = sms.skipSmsIfWxOk === true

        const [bh, bm] = sms.dayBeforeAt.split(':')
        const hIdx = Math.max(0, this.data.dayBeforeHourOpts.indexOf(bh))
        const mIdx = Math.max(0, this.data.dayBeforeMinuteOpts.indexOf(bm))

        this.setData({
          sub: subObj,
          sms,
          approachingOffsetIdx: approachingIdx(sms.approachingOffset),
          expiredOffsetIdx: expiredIdx(sms.expiredOffset),
          dayBeforeHourIdx: hIdx,
          dayBeforeMinuteIdx: mIdx,
          cancelDelayIdx: cancelDelayIdx(sms.cancelDelay)
        })
      }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
    })
  },
  toggleSub(e) { this.setData({ [`sub.${e.currentTarget.dataset.k}`]: e.detail.value }) },
  toggleSms(e) { this.setData({ [`sms.${e.currentTarget.dataset.k}`]: e.detail.value }) },

  // 微信优先降级开关：开启＝微信订阅消息已送达则不发对应短信；关闭＝双通道都发
  toggleSkipSms(e) { this.setData({ 'sms.skipSmsIfWxOk': !!e.detail.value }) },

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

  // 前一天提醒：发送时刻（时:分，北京时间）
  onDayBeforeHour(e) {
    const hIdx = Number(e.detail.value)
    const [_, bm] = this.data.sms.dayBeforeAt.split(':')
    this.setData({ dayBeforeHourIdx: hIdx, 'sms.dayBeforeAt': `${this.data.dayBeforeHourOpts[hIdx]}:${bm}` })
  },
  onDayBeforeMinute(e) {
    const mIdx = Number(e.detail.value)
    const [bh] = this.data.sms.dayBeforeAt.split(':')
    this.setData({ dayBeforeMinuteIdx: mIdx, 'sms.dayBeforeAt': `${bh}:${this.data.dayBeforeMinuteOpts[mIdx]}` })
  },

  // 取消短信延迟（发前会复校预约仍为已取消；定时任务 15 分钟一轮，精度即 15 分钟）
  onCancelDelay(e) {
    const map = [0, 3, 5, 10]
    const idx = Number(e.detail.value)
    this.setData({ cancelDelayIdx: idx, 'sms.cancelDelay': map[idx] })
  },

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
