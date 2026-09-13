const { call } = require('../../utils/cloud')
const { requestSubscribe } = require('../../utils/util')
const { CUSTOMER_SUBS, BOOKER_TPLS, normalizeSubs } = require('../../utils/subscribe')

// ⚠️ 开发调试开关：正式发布前改为 false，即可隐藏「测试订阅弹窗」调试按钮
const DEBUG = true

// 顾客侧「通知偏好」：订阅消息设置页
// 统一订阅记录 users.subscriptions 的唯一顾客端入口；含全部 5 类通知（含此前缺失的「前一天提醒」）。
// 打开开关 = 记录置 true + 向微信申请该项授权（一次性授权，每次开启都会重新申请）。
// 关闭开关 = 记录置 false，后端所有触发逻辑统一读取该记录，不再发送该类通知。
Page({
  data: {
    list: [],      // [{key,label,desc,checked}]
    subs: {},      // 勾选结果
    loading: true,
    saving: false,
    debug: DEBUG   // 是否显示「测试订阅弹窗」调试按钮
  },

  onLoad() { this.load() },

  load() {
    this.setData({ loading: true })
    call('getMyProfile')
      .then(d => {
        const subs = normalizeSubs(d && d.profile ? d.profile.subscriptions : {})
        this.setData({ subs, list: this.buildList(subs), loading: false })
      })
      .catch(() => {
        // 读取失败时以「全部订阅」渲染，避免空白页
        const subs = normalizeSubs({})
        this.setData({ subs, list: this.buildList(subs), loading: false })
      })
  },

  buildList(subs) {
    return CUSTOMER_SUBS.map(s => ({
      key: s.key,
      tmplId: s.tmplId,
      label: s.label,
      desc: s.desc,
      checked: !!(subs && subs[s.key] !== false)
    }))
  },

  // 切换某一项：开启时同步向微信申请该项授权（须在 tap 手势内同步调用）
  toggle(e) {
    const key = e.currentTarget.dataset.key
    const item = CUSTOMER_SUBS.find(s => s.key === key)
    if (!item) return
    const next = !(this.data.subs[key] !== false)
    const subs = { ...this.data.subs, [key]: next }
    // ⚠️ 必须在 tap 处理器内同步发起，不能放在 await 之后
    if (next) requestSubscribe([item.tmplId]).catch(() => {})
    this.setData({ subs, list: this.buildList(subs) })
    this.save(subs)
  },

  save(subs) {
    if (this.data.saving) return
    this.setData({ saving: true })
    call('saveProfile', { subscriptions: subs })
      .then(() => wx.showToast({ title: '已保存', icon: 'success' }))
      .catch(e => wx.showToast({ title: e.message || '保存失败', icon: 'none' }))
      .finally(() => this.setData({ saving: false }))
  },

  // 一键开启全部（逐项申请授权；微信一次弹窗最多 3 个模板，util.requestSubscribe 会自动分片）
  enableAll() {
    const subs = {}
    CUSTOMER_SUBS.forEach(s => { subs[s.key] = true })
    requestSubscribe(CUSTOMER_SUBS.map(s => s.tmplId)).catch(() => {})
    this.setData({ subs, list: this.buildList(subs) })
    this.save(subs)
  },

  disableAll() {
    const subs = {}
    CUSTOMER_SUBS.forEach(s => { subs[s.key] = false })
    this.setData({ subs, list: this.buildList(subs) })
    this.save(subs)
  },

  // 开发调试：直接申请全部 5 个顾客模板（绕过时间轴裁剪），用于反复验证原生订阅弹窗能否弹出。
  // ⚠️ 微信「总是保持以上选择」一旦勾过且为拒绝态，弹窗永不再出现，结果会落在 rejected；
  //    此时必须用微信开发者工具「清缓存(授权数据)→重编译」后本按钮才会再次弹出。
  testPopup() {
    const nameOf = id => { const s = CUSTOMER_SUBS.find(x => x.tmplId === id); return s ? s.label : id.slice(0, 12) }
    requestSubscribe(BOOKER_TPLS).then(r => {
      const accepted = (r && r.accepted) || []
      const rejected = (r && r.rejected) || []
      const failed = (r && r.failed) || []
      const code = r && r.errCode
      console.info('[notifyPref] testPopup', JSON.stringify({ total: r && r.total, accepted, rejected, failed, errCode: code }))
      const lines = []
      if (accepted.length) lines.push('允许 ' + accepted.length + '：' + accepted.map(id => nameOf(id)).join('、'))
      if (rejected.length) lines.push('拒绝 ' + rejected.length + '：' + rejected.map(id => nameOf(id)).join('、'))
      if (failed.length) {
        const detail = failed.map(id => nameOf(id) + '\n' + id).join('\n---\n')
        lines.push('请求失败' + (code ? '（errCode=' + code + '）' : '') + '：' + failed.length + ' 个模板 ID 非法或未在 MP 后台「我的模板」选用。请逐个核对以下模板是否在「小程序 → 订阅消息 → 我的模板」里已添加并「选用」：\n---\n' + detail)
      }
      if (!lines.length) lines.push('未返回任何结果：微信未弹窗（可能无权限或保持状态已生效）。')
      wx.showModal({ title: '弹窗测试结果', content: lines.join('\n\n'), showCancel: false })
    }).catch(err => {
      console.error('[notifyPref] testPopup catch', err)
      wx.showModal({ title: '弹窗测试', content: '调用异常：' + (err && err.errMsg ? err.errMsg : '请查看 console'), showCancel: false })
    })
  }
})
