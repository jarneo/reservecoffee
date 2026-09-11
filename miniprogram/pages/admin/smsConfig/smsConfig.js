const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: {
    signName: '', smsSdkAppId: '', secretIdMask: '', hasSecret: false, noticeTemplate: '',
    tplSuccess: '', tplApproaching: '', tplExpired: '', tplCancel: '', tplDayBefore: '',
    secretId: '', secretKey: ''
  },
  onLoad() {
    this.guard(['owner']).then(role => {
      if (!role) return
      call('getSmsConfig').then(d => {
        const c = d.config || {}
        const t = c.templates || {}
        this.setData({
          signName: c.signName || '', smsSdkAppId: c.smsSdkAppId || '',
          secretIdMask: c.secretIdMask || '', hasSecret: !!c.hasSecret,
          noticeTemplate: c.noticeTemplate || '',
          tplSuccess: t.success || '', tplApproaching: t.approaching || '', tplExpired: t.expired || '',
          tplCancel: t.cancel || '', tplDayBefore: t.dayBefore || ''
        })
      }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
    })
  },
  onSign(e) { this.setData({ signName: e.detail.value }) },
  onApp(e) { this.setData({ smsSdkAppId: e.detail.value }) },
  onId(e) { this.setData({ secretId: e.detail.value }) },
  onKey(e) { this.setData({ secretKey: e.detail.value }) },
  onTplSuccess(e) { this.setData({ tplSuccess: e.detail.value }) },
  onTplApproaching(e) { this.setData({ tplApproaching: e.detail.value }) },
  onTplExpired(e) { this.setData({ tplExpired: e.detail.value }) },
  onTplCancel(e) { this.setData({ tplCancel: e.detail.value }) },
  onTplDayBefore(e) { this.setData({ tplDayBefore: e.detail.value }) },
  onNote(e) { this.setData({ noticeTemplate: e.detail.value }) },
  save() {
    const d = this.data
    call('saveSmsConfig', {
      signName: d.signName, smsSdkAppId: d.smsSdkAppId,
      secretId: d.secretId, secretKey: d.secretKey, noticeTemplate: d.noticeTemplate,
      tplSuccess: d.tplSuccess, tplApproaching: d.tplApproaching, tplExpired: d.tplExpired,
      tplCancel: d.tplCancel, tplDayBefore: d.tplDayBefore
    }).then(() => wx.showToast({ title: '短信配置已保存', icon: 'success' }))
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  }
})
