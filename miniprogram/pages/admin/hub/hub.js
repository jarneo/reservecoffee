const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')
const { requestSubscribe } = require('../../../utils/util')
const { ADMIN_TPLS, ADMIN_SUBS } = require('../../../utils/subscribe')

// 毫秒时间戳 → 「2026-10-02 22:30」；非法/缺省返回空串（WXML 里用 wx:if 挡掉）
function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(Number(ts))
  if (isNaN(d.getTime())) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 把 requestSubscribe 返回的「模板 id 数组」翻译成后端要的 { key: 布尔 }。
// ⚠️ 只上报本次弹窗返回了明确结果的键：微信对未返回结果的模板不表态，
//    若一并上报 false 会把「其实还有额度」的键误标为失效。
// ⚠️ 'ban' = 用户在小程序设置里关掉了订阅消息，同样表示收不到 → 按 false 上报。
function toSubsPatch(r) {
  const patch = {}
  const hit = id => (r.accepted || []).indexOf(id) >= 0
  const miss = id => (r.rejected || []).indexOf(id) >= 0 || (r.failed || []).indexOf(id) >= 0
  ADMIN_SUBS.forEach(s => {
    if (hit(s.tmplId)) patch[s.key] = true
    else if (miss(s.tmplId)) patch[s.key] = false
    // 否则不下报（后端逐键合并，保持原值）
  })
  return patch
}

Page({
  behaviors: [guard],
  data: {
    role: 'none', menus: [],
    // 管理推送订阅状态（来自 admins.subscriptions，后端 listAdmins / saveAdminSubs）
    mySubs: null,          // { adminNew, adminCancel, adminReview } 布尔
    mySubInvalid: false,   // 任一推送已失效 → 卡片变警示态
    mySubscribedAt: '',    // 已格式化的「上次续订」时间；空串则不显示
    mySubTotal: ADMIN_SUBS.length,  // 管理员推送类型总数（adminNew/adminCancel/adminReview）
    mySubRemain: null,     // 仍有效（未失效）的推送类型数；null=本人查不到（如 manager）
    unread: 0              // 提醒未读数（0 也照常显示，只是数字转灰）
  },
  onLoad() {
    this.guard(['owner', 'manager']).then(role => {
      if (!role) return
      const owner = [
        { t: '项目管理', u: '/pages/admin/projects/projects' },
        { t: '项目配置', u: '/pages/admin/projectConfig/projectConfig' },
        { t: '首图及介绍', u: '/pages/admin/cover/cover' },
        { t: '场次模版', u: '/pages/admin/templates/templates' },
        { t: '店铺菜单管理', u: '/pages/admin/menuAdmin/menuAdmin' },
        { t: '菜单分类管理', u: '/pages/admin/categories/categories' },
        { t: '菜品评价管理', u: '/pages/admin/reviewAdmin/reviewAdmin' },
        { t: '预约管理', u: '/pages/admin/sessions/sessions' },
        { t: '审核', u: '/pages/admin/review/review' },
        { t: '数据分析', u: '/pages/admin/stats/stats' },
        { t: '顾客名录', u: '/pages/admin/customers/customers' },
        { t: '黑名单', u: '/pages/admin/blacklist/blacklist' },
        { t: '管理员管理', u: '/pages/admin/admins/admins' },
        { t: '全局通知配置', u: '/pages/admin/notifyConfig/notifyConfig' },
        { t: 'AI 智能预约设置', u: '/pages/admin/aiConfig/aiConfig' },
        { t: 'AI 对话记录', u: '/pages/admin/aiLogs/aiLogs' },
        { t: '公众号菜单配置', u: '/pages/admin/oaMenu/oaMenu' },
        { t: '界面设置', u: '/pages/admin/uiConfig/uiConfig' }
      ]
      const manager = [
        { t: '店铺菜单管理', u: '/pages/admin/menuAdmin/menuAdmin' },
        { t: '菜品评价管理', u: '/pages/admin/reviewAdmin/reviewAdmin' },
        { t: '预约管理', u: '/pages/admin/sessions/sessions' },
        { t: '审核', u: '/pages/admin/review/review' }
      ]
      this.setData({ role, menus: role === 'owner' ? owner : manager })
    })
    this.loadMySubs()
    this.loadUnread()
  },
  // 从提醒返回时刷新未读数（在里面点了「全部已读」/ 打开了详情，数字必须同步掉）
  onShow() { if (this._loaded) this.loadUnread(); this._loaded = true },
  // 提醒未读数：owner / manager 都能查。失败静默保持 0 —— 徽标是锦上添花，不该弹错打断管理台
  loadUnread() {
    call('getInbox', { page: 1 }).then(d => {
      this.setData({ unread: (d && d.unread) || 0 })
    }).catch(() => {})
  },
  goInbox() { wx.navigateTo({ url: '/pages/admin/inbox/inbox' }) },
  // 拉自己的订阅状态：owner 走 listAdmins（只有 owner 能查），manager 查不到则静默保持「未失效」。
  // ⚠️ 用 openid 精确定位本人，**不能按 role 匹配**（owner+manager 可能多人同角色）。
  // ⚠️ listAdmins 是 owner 独有；manager 查不到时静默保持「未失效」，
  //    即回到改造前的表现（不误报失效），而非误报。
  loadMySubs() {
    call('listAdmins').then(d => {
      const list = (d && d.list) || []
      const myOpenid = (getApp().globalData || {}).openid || ''
      const me = myOpenid ? list.find(a => a.openid === myOpenid) : null
      if (!me || !me.subscriptions) return
      this.applySubs(me.subscriptions, me.subscribedAt, me.pushQuota)
    }).catch(() => {})
  },
  applySubs(subs, subscribedAt, pushQuota) {
    const keys = ADMIN_SUBS.map(s => s.key)
    const invalid = keys.some(k => subs[k] === false)
    // 「剩余可用推送」改为自维护额度计数器：点击续订 +1 / 真正发出 -1，可超过 3、归零后重新累加
    const remain = (typeof pushQuota === 'number') ? pushQuota : 0
    this.setData({
      mySubs: subs,
      mySubInvalid: invalid,
      mySubRemain: remain,
      mySubscribedAt: fmtTime(subscribedAt)
    })
  },
  go(e) { wx.navigateTo({ url: e.currentTarget.dataset.u }) },
  exit() { wx.reLaunch({ url: '/pages/index/index' }) },
  // 管理员订阅授权入口：必须在点击手势内同步调用 requestSubscribe（微信要求），
  // 否则授权弹窗被拦截 → 管理员收不到新预约/取消/待审核推送（43101）。
  // 微信订阅为**一次性**授权：发一条消耗一次，用尽后后端静默失败（43101）。
  // 本次把真实授权结果**落库**（saveAdminSubs），配合后端 notifyAdmins 的 43101 回写，
  // 让「额度耗尽」在管理台变成可见的警示态，而不是只能靠人肉发现。
  enableAdminNotify() {
    requestSubscribe(ADMIN_TPLS).then(r => {
      const okN = r.accepted.length
      const badN = r.rejected.length + r.failed.length
      const patch = toSubsPatch(r)
      // 落库失败不阻断提示：授权已在微信侧生效，只是本地状态没记上
      call('saveAdminSubs', { subs: patch })
        .then(d => { if (d && d.subscriptions) this.applySubs(d.subscriptions, d.subscribedAt, d.pushQuota) })
        .catch(() => {})
      if (!badN) {
        wx.showToast({ title: `已续订 ${okN}/${r.total} 个管理推送`, icon: 'none' })
        return
      }
      wx.showModal({
        title: '部分推送未授权',
        content: `本次成功 ${okN}/${r.total} 个，未授权的仍收不到推送。\n\n请在弹出的授权框里把模板全部勾选；并建议勾选「总是保持以上选择，不再询问」——微信订阅是一次性授权，发一条就消耗一次，勾选后才会长期生效。`,
        showCancel: false,
        confirmText: '我知道了'
      })
    })
  }
})
