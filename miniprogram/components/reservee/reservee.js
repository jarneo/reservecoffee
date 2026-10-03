// components/reservee — 预约人列表 + 详情弹层（管理端预约管理 / 前端选日期场次·管理员视角 共用）
// 属性：
//   list      预约人数组（字段与 listDateReservations / listSessionReservations 返回一致）
//   canCancel 该场次是否可取消（未过期才允许；由父页面按场次 end 时间算好传入）
//   canReview 是否显示「通过 / 不通过」审核按钮（管理端完整管理页传 true）
//   role     当前管理员角色（owner/manager），预留给后续「按角色隐藏操作」扩展
// 事件：
//   cancel   点击某条「取消预约」时抛出，detail={ id }；真正的云函数调用与刷新由父页面处理
//   review   点击「通过 / 不通过」时抛出，detail={ id, decision }；由父页面调用 reviewReservation
// 自带行为：点卡片 → 底部详情层；详情层内「📞 拨打电话」「查看顾客分析」「复制号码/微信号」为组件内自包含动作。
Component({
  properties: {
    list: { type: Array, value: [] },
    canCancel: { type: Boolean, value: true },
    canReview: { type: Boolean, value: false },
    role: { type: String, value: 'manager' }
  },
  data: { detail: null },
  methods: {
    onTap(e) {
      const id = e.currentTarget.dataset.id
      const p = (this.data.list || []).find(x => x._id === id)
      if (p) this.setData({ detail: p })
    },
    closeDetail() { this.setData({ detail: null }) },
    noop() {},
    dial() {
      const p = this.data.detail
      if (p && p.phone) wx.makePhoneCall({ phoneNumber: p.phone })
    },
    viewAnalyze() {
      const p = this.data.detail
      if (!p) return
      if (!p.openid) { wx.showToast({ title: '该顾客无 openid，无法查看', icon: 'none' }); return }
      wx.navigateTo({ url: '/pages/admin/customers/detail?openid=' + p.openid })
    },
    onCancel(e) {
      const id = e.currentTarget.dataset.id
      this.triggerEvent('cancel', { id })
    },
    // 列表内直接拨号（无需先点开详情）
    onDial(e) {
      const id = e.currentTarget.dataset.id
      const p = (this.data.list || []).find(x => x._id === id)
      if (p && p.phone) wx.makePhoneCall({ phoneNumber: p.phone })
      else wx.showToast({ title: '该顾客未留号码', icon: 'none' })
    },
    // 列表内直接跳「查看顾客分析」（无需先点开详情）
    goAnalyze(e) {
      const id = e.currentTarget.dataset.id
      const p = (this.data.list || []).find(x => x._id === id)
      if (!p) return
      if (!p.openid) { wx.showToast({ title: '该顾客无 openid，无法查看', icon: 'none' }); return }
      wx.navigateTo({ url: '/pages/admin/customers/detail?openid=' + p.openid })
    },
    // 审核：把「通过 / 不通过」连同预约 id 抛给父页面（云函数调用与刷新由父页面负责）
    onReview(e) {
      const id = e.currentTarget.dataset.id
      const decision = e.currentTarget.dataset.decision
      if (!id || !decision) return
      this.triggerEvent('review', { id, decision })
    },
    copyPhone() {
      const p = this.data.detail
      if (!p || !p.phone) return
      wx.setClipboardData({ data: p.phone, success: () => wx.showToast({ title: '号码已复制', icon: 'none' }) })
    },
    copyWechat() {
      const p = this.data.detail
      if (!p || !p.wechat) return
      wx.setClipboardData({ data: p.wechat, success: () => wx.showToast({ title: '微信号已复制', icon: 'none' }) })
    }
  }
})
