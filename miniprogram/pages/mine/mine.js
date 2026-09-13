const { call } = require('../../utils/cloud')
const { isPhone, requestSubscribe } = require('../../utils/util')
const { TPLS, normalizeSubs } = require('../../utils/subscribe')

const MAP = {
  pending: ['待审核', 'paused'],
  confirmed: ['预约成功', 'ok'],
  completed: ['已完成', 'done'],
  cancelled: ['已取消', 'full'],
  expired: ['已过期', 'expired']
}

Page({
  data: {
    list: [], openid: '', role: 'none',
    name: '', phone: '', avatarUrl: '', pAvatar: '',
    // 统一订阅记录（缺省全部订阅）；用于收敛「取消预约」等点击提醒入口的授权请求
    subs: normalizeSubs({})
  },

  onShow() {
    this.syncMe()
    this.load()
    this.loadProfile()
  },

  // 同步当前用户身份（openid / 角色），供"复制 openid 给店主授权"使用
  syncMe() {
    const app = getApp()
    app.refreshRole().then(() => {
      this.setData({ openid: app.globalData.openid || '', role: app.globalData.role || 'none' })
    }).catch(() => {})
  },

  copyOpenid() {
    if (!this.data.openid) return wx.showToast({ title: 'openid 未加载', icon: 'none' })
    wx.setClipboardData({
      data: this.data.openid,
      success: () => wx.showToast({ title: '已复制 openid', icon: 'success' })
    })
  },

  load() {
    call('listMyReservations')
      .then(d => {
        const list = (d.list || []).map(r => ({
          ...r,
          statusText: (MAP[r.status] || ['', ''])[0],
          statusClass: (MAP[r.status] || ['', ''])[1]
        }))
        this.setData({ list })
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },

  // 加载我的资料（昵称/手机/头像）
  loadProfile() {
    call('getMyProfile')
      .then(d => {
        if (d && d.profile) {
          const p = d.profile
          const patch = { name: p.name || '', phone: p.phone || '' }
          // 统一订阅记录：缺省视为全部订阅（与后端 normalizeSubs 一致）
          patch.subs = normalizeSubs(p.subscriptions)
          this.setData(patch)
          if (p.avatar) {
            wx.cloud.getTempFileURL({ fileList: [p.avatar] })
              .then(r => {
                const url = r.fileList && r.fileList[0] && r.fileList[0].tempFileURL
                if (url) this.setData({ avatarUrl: url })
              })
              .catch(() => {})
          }
        }
      })
      .catch(() => {})
  },

  onName(e) { this.setData({ name: e.detail.value }) },
  onPhone(e) { this.setData({ phone: e.detail.value }) },
  onChooseAvatar(e) { this.setData({ pAvatar: e.detail.avatarUrl }) },

  // 保存我的资料（昵称/手机/头像）
  saveMine() {
    const name = (this.data.name || '').trim()
    if (!name) return wx.showToast({ title: '请填写称呼', icon: 'none' })
    if (this.data.phone && !isPhone(this.data.phone)) return wx.showToast({ title: '手机号格式不正确', icon: 'none' })
    wx.showLoading({ title: '保存中' })
    const data = { name, phone: (this.data.phone || '').trim() }
    const finish = (avatar) => {
      if (avatar) data.avatar = avatar
      call('saveProfile', data)
        .then(() => {
          wx.hideLoading()
          this.setData({ avatarUrl: avatar || this.data.avatarUrl, pAvatar: '' })
          wx.showToast({ title: '已保存', icon: 'success' })
        })
        .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message || '保存失败', icon: 'none' }) })
    }
    if (this.data.pAvatar) {
      const oid = this.data.openid || Date.now()
      const cloudPath = `avatars/${oid}_${Date.now()}.png`
      wx.cloud.uploadFile({ cloudPath, filePath: this.data.pAvatar })
        .then(res => finish(res.fileID))
        .catch(() => finish())
    } else {
      finish()
    }
  },

  cancel(e) {
    const id = e.currentTarget.dataset.id
    // 统一订阅记录收敛：用户未勾选「预约取消」时不再请求授权、后端也不会发送
    // （微信要求手势内同步调用，故放在本处理器最前面，不能置于 await/Promise 之后）
    if (this.data.subs.reserveCancel !== false) requestSubscribe([TPLS.reserveCancel])
    wx.showModal({
      title: '取消预约',
      content: '确定要取消该预约吗？取消后名额将释放。',
      confirmText: '确认取消', cancelText: '再想想',
      success: r => {
        if (!r.confirm) return
        wx.showLoading({ title: '取消中' })
        call('cancelReservation', { reservationId: id })
          .then(() => {
            wx.hideLoading(); wx.showToast({ title: '已取消', icon: 'success' })
            this.load()
          })
          .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message || '取消失败', icon: 'none' }) })
      }
    })
  },

  // 跳转「通知偏好」：顾客侧订阅消息设置（含前一天提醒等全部通知类型）
  goNotifyPref() {
    wx.navigateTo({ url: '/pages/notifyPref/notifyPref' })
  }
})
