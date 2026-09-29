// pages/admin/uiConfig — 界面开关（仅 owner）
// 目前只有一项：页面路径条。owner 登录时在页面末尾显示「当前页完整路径 + 复制」，
// 方便配公众号菜单 pagepath / 生成小程序短链；关掉则所有页面都不再显示。
// 顾客端 / manager 本来就看不到这条，开关只影响 owner 自己。
const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: {
    pathBar: true,
    saving: false
  },

  onLoad() {
    this.guard(['owner']).then(role => {
      if (!role) return
      call('uiConfig', { action: 'get' }).then(d => {
        this.setData({ pathBar: !(d && d.pathBar === false) })
      }).catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
    })
  },

  // 开关即生效：改完立刻写库，并同步全局缓存（其它页面下次 show 就用新值）
  onToggle(e) {
    const v = !!e.detail.value
    const prev = this.data.pathBar
    this.setData({ pathBar: v, saving: true })
    call('uiConfig', { action: 'set', pathBar: v }).then(d => {
      this.setData({ saving: false })
      const app = getApp()
      app.globalData.pathBarEnabled = !(d && d.pathBar === false)
      wx.showToast({ title: v ? '已开启' : '已关闭', icon: 'none' })
    }).catch(err => {
      // 失败回滚开关，避免显示与云端不一致
      const app = getApp()
      app.globalData.pathBarEnabled = prev
      this.setData({ pathBar: prev, saving: false })
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    })
  }
})
