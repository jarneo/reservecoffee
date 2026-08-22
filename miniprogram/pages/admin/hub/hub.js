const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')
const { requestSubscribe } = require('../../../utils/util')
const { ADMIN_TPLS } = require('../../../utils/subscribe')

Page({
  behaviors: [guard],
  data: { role: 'none', menus: [] },
  onLoad() {
    this.guard(['owner', 'manager']).then(role => {
      if (!role) return
      const owner = [
        { t: '项目管理', u: '/pages/admin/projects/projects' },
        { t: '项目配置', u: '/pages/admin/projectConfig/projectConfig' },
        { t: '首图及介绍', u: '/pages/admin/cover/cover' },
        { t: '场次模版', u: '/pages/admin/templates/templates' },
        { t: '店铺菜单管理', u: '/pages/admin/menuAdmin/menuAdmin' },
        { t: '菜品评价管理', u: '/pages/admin/reviewAdmin/reviewAdmin' },
        { t: '预约管理', u: '/pages/admin/sessions/sessions' },
        { t: '审核', u: '/pages/admin/review/review' },
        { t: '管理员管理', u: '/pages/admin/admins/admins' },
        { t: '全局通知配置', u: '/pages/admin/notifyConfig/notifyConfig' }
      ]
      const manager = [
        { t: '店铺菜单管理', u: '/pages/admin/menuAdmin/menuAdmin' },
        { t: '菜品评价管理', u: '/pages/admin/reviewAdmin/reviewAdmin' },
        { t: '预约管理', u: '/pages/admin/sessions/sessions' },
        { t: '审核', u: '/pages/admin/review/review' }
      ]
      this.setData({ role, menus: role === 'owner' ? owner : manager })
    })
  },
  go(e) { wx.navigateTo({ url: e.currentTarget.dataset.u }) },
  exit() { wx.reLaunch({ url: '/pages/index/index' }) },
  // 管理员订阅授权入口：必须在点击手势内同步调用 requestSubscribe（微信要求），
  // 否则授权弹窗被拦截 → 管理员收不到新预约/取消/待审核推送（43101）。
  // 微信订阅为一次性授权，用掉即失效，故此处可反复点击续订。
  enableAdminNotify() {
    requestSubscribe(ADMIN_TPLS)
    wx.showToast({ title: '已授权管理推送（一次性，过期可再点）', icon: 'none' })
  }
})
