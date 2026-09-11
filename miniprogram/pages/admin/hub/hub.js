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
        { t: '数据分析', u: '/pages/admin/stats/stats' },
        { t: '顾客名录', u: '/pages/admin/customers/customers' },
        { t: '黑名单', u: '/pages/admin/blacklist/blacklist' },
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
  // 微信订阅为**一次性**授权：发一条消耗一次，用尽后后端静默失败（43101），管理员完全无感。
  // 因此这里必须把**真实授权结果**告诉管理员（旧实现无条件提示「已授权」，会误导），
  // 并引导勾选「总是保持以上选择，不再询问」以免反复续订。
  enableAdminNotify() {
    requestSubscribe(ADMIN_TPLS).then(r => {
      const okN = r.accepted.length
      const badN = r.rejected.length + r.failed.length
      if (!badN) {
        wx.showToast({ title: `已续订 ${okN}/${r.total} 个管理推送`, icon: 'none' })
        return
      }
      wx.showModal({
        title: '部分推送未授权',
        content: `本次成功 ${okN}/${r.total} 个，未授权的仍收不到推送。\n\n请在弹出的授权框里把模板**全部勾选**；并建议勾选「总是保持以上选择，不再询问」——微信订阅是一次性授权，发一条就消耗一次，勾选后才会长期生效。`,
        showCancel: false,
        confirmText: '我知道了'
      })
    })
  }
})
