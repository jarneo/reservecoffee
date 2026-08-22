const { call } = require('../../../utils/cloud')

// 承载 web-view 打开服务号授权页（静态网站）。
// 授权页 snsapi_base 拿到 code 后，直接通过 wx.miniProgram.redirectTo 跳回小程序 mine 页，
// 由 mine 页调用 mpAuth 云函数换服务号 openid 并写入 users.mpOpenid。
// 不再使用 postMessage/跳外部网关域名，避免 OAuth 重定向丢失桥接或被微信拦截。
const AUTH_PAGE = 'https://cloud1-d6g5g3oj234efe932-1472887487.tcloudbaseapp.com/mp-auth.html'

Page({
  data: { src: '' },
  onLoad() {
    call('getMyProfile').then(d => {
      const openid = (d && d.openid) || ''
      this._openid = openid
      this.setData({ src: AUTH_PAGE + (openid ? '?openid=' + encodeURIComponent(openid) : '') })
    }).catch(() => {
      this.setData({ src: AUTH_PAGE })
    })
  },
  onMessage(e) {
    const arr = (e.detail && e.detail.data) || []
    const msg = arr[arr.length - 1] || {}
    if (msg.code) {
      const openid = msg.openid || this._openid || ''
      wx.showLoading({ title: '绑定中' })
      call('mpAuth', { code: msg.code, openid })
        .then(r => {
          wx.hideLoading()
          if (r && r.ok) {
            wx.showToast({ title: '已开启服务号通知', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 600)
          } else {
            wx.showModal({ title: '绑定未完成', content: (r && r.msg) || '请重试', showCancel: false })
          }
        })
        .catch(err => {
          wx.hideLoading()
          wx.showModal({ title: '绑定失败', content: err.message || '网络错误', showCancel: false })
        })
    }
  }
})
