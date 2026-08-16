const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: { form: {}, sms: {} },
  onLoad() { this.guard(['owner']).then(r => { if (r) this.load() }) },
  load() {
    call('getHomepage').then(d => this.setData({ form: d.homepage || {} })).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
    call('getSmsConfig').then(d => this.setData({ sms: d.config || {} })).catch(() => {})
  },
  on(e) { this.setData({ ['form.' + e.currentTarget.dataset.k]: e.detail.value }) },
  onSms(e) { this.setData({ ['sms.' + e.currentTarget.dataset.k]: e.detail.value }) },
  save() {
    wx.showLoading({ title: '保存中' })
    call('updateHomepage', this.data.form)
      .then(() => { wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' }) })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  saveSms() {
    const s = this.data.sms
    wx.showLoading({ title: '保存中' })
    call('saveSmsConfig', {
      signName: s.signName, templateId: s.templateId, smsSdkAppId: s.smsSdkAppId,
      secretId: s.secretId, secretKey: s.secretKey, noticeTemplate: s.noticeTemplate
    }).then(() => { wx.hideLoading(); wx.showToast({ title: '已保存短信配置', icon: 'success' }) })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  }
})
