const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: { role: 'none', menus: [] },
  onLoad() {
    this.guard(['owner', 'manager']).then(role => {
      if (!role) return
      const owner = [
        { t: '首页配置', u: '/pages/admin/homeConfig/homeConfig' },
        { t: '项目管理', u: '/pages/admin/projects/projects' },
        { t: '项目配置（日历+场次）', u: '/pages/admin/projectConfig/projectConfig' },
        { t: '查看预约人', u: '/pages/admin/view/view' },
        { t: '审核', u: '/pages/admin/review/review' },
        { t: '管理员管理', u: '/pages/admin/admins/admins' }
      ]
      const manager = [
        { t: '项目场次（暂停/取消）', u: '/pages/admin/sessions/sessions' },
        { t: '查看预约人', u: '/pages/admin/view/view' }
      ]
      this.setData({ role, menus: role === 'owner' ? owner : manager })
    })
  },
  go(e) { wx.navigateTo({ url: e.currentTarget.dataset.u }) },
  exit() { wx.reLaunch({ url: '/pages/index/index' }) }
})
