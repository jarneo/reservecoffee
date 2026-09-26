// components/adminGuard/adminGuard.js — 角色门禁 behavior（页面混入）
// 用法：behaviors:[require('../../components/adminGuard/adminGuard.js')]，在 onLoad 调 this.guard(['owner'])
module.exports = Behavior({
  methods: {
    async guard(roles) {
      const app = getApp()
      // force=true：门禁判断权限必须拿最新结果，不能吃 30s TTL 缓存
      // （管理员可能刚被授权/撤权，管理端是低频操作，多一次请求无所谓）
      const r = await app.refreshRole(true)
      const role = (r && r.role) || 'none'
      if (!roles.includes(role)) {
        wx.showModal({
          title: '无权限', content: '该页面需要管理员权限', showCancel: false, confirmText: '返回首页',
          success: () => wx.reLaunch({ url: '/pages/index/index' })
        })
        return false
      }
      this.setData({ _role: role })
      return role
    }
  }
})
