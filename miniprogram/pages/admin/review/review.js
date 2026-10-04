const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: { list: [], filterName: '', selRid: '' },
  onLoad(q) {
    this.q = q || {}
    this.guard(['owner', 'manager']).then(r => { if (r) this.load() })
  },
  load() {
    call('listReviews').then(d => {
      const all = (d && d.list) || []
      const pid = this.q.projectId
      // 来自订阅消息「待审核提醒」跳转时带 projectId → 只呈现该项目待审核；其余入口（收件箱等）无参 → 显示全部
      const list = pid ? all.filter(x => x.projectId === pid) : all
      const filterName = pid ? ((all.find(x => x.projectId === pid) || {}).projectName || '') : ''
      this.setData({ list, filterName, selRid: this.q.rid || '' })
    }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  approve(e) { this.act(e.currentTarget.dataset.id, 'approve') },
  reject(e) { this.act(e.currentTarget.dataset.id, 'reject') },
  goCustomer(e) {
    const openid = e.currentTarget.dataset.openid
    if (openid) wx.navigateTo({ url: '/pages/admin/customers/detail?openid=' + openid })
  },
  act(id, decision) {
    wx.showLoading({ title: '处理中' })
    call('reviewReservation', { reservationId: id, decision })
      .then(() => { wx.hideLoading(); this.load(); wx.showToast({ title: '已处理', icon: 'success' }) })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  reviewAll() {
    const n = this.data.list.length
    if (!n) { wx.showToast({ title: '没有待审核', icon: 'none' }); return }
    // 黑名单保护提示：批量通过会自动跳过黑名单用户，提前告知管理员
    const bl = this.data.list.filter(x => x.isBlacklisted).length
    const tip = bl ? `\n其中 ${bl} 条属于黑名单用户，将自动跳过，需你逐条人工确认。` : ''
    wx.showModal({
      title: '全部审核',
      content: `确认将全部 ${n} 条待审核预约审核通过？${tip}`,
      confirmText: '全部通过',
      success: (m) => {
        if (!m.confirm) return
        wx.showLoading({ title: '审核中' })
        call('reviewAllReservations', { decision: 'approve' })
          .then(d => {
            wx.hideLoading()
            this.load()
            const r = d || {}
            const skippedBl = r.blacklisted || 0
            if (skippedBl) {
              wx.showModal({
                title: '批量审核完成',
                content: `已通过 ${r.approved || 0} 条；${skippedBl} 条因顾客在黑名单中被跳过，仍保持待审核。`,
                showCancel: false
              })
            } else {
              wx.showToast({ title: `已通过 ${r.approved || 0} 条`, icon: 'success' })
            }
          })
          .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
      }
    })
  }
})
