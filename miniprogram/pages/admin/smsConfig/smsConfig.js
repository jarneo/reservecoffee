const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: {
    signName: '', templateId: '', smsSdkAppId: '', secretIdMask: '', hasSecret: false, noticeTemplate: '',
    secretId: '', secretKey: ''
  },
  onLoad() {
    this.guard(['owner']).then(role => {
      if (!role) return
      call('getSmsConfig').then(d => {
        const c = d.config || {}
        this.setData({
          signName: c.signName || '', templateId: c.templateId || '',
          smsSdkAppId: c.smsSdkAppId || '', secretIdMask: c.secretIdMask || '',
          hasSecret: !!c.hasSecret, noticeTemplate: c.noticeTemplate || ''
        })
      }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
    })
  },
  onSign(e) { this.setData({ signName: e.detail.value }) },
  onTpl(e) { this.setData({ templateId: e.detail.value }) },
  onApp(e) { this.setData({ smsSdkAppId: e.detail.value }) },
  onId(e) { this.setData({ secretId: e.detail.value }) },
  onKey(e) { this.setData({ secretKey: e.detail.value }) },
  onNote(e) { this.setData({ noticeTemplate: e.detail.value }) },
  save() {
    const d = this.data
    call('saveSmsConfig', {
      signName: d.signName, templateId: d.templateId, smsSdkAppId: d.smsSdkAppId,
      secretId: d.secretId, secretKey: d.secretKey, noticeTemplate: d.noticeTemplate
    }).then(() => wx.showToast({ title: '短信配置已保存', icon: 'success' }))
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  }
})
