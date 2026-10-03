const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

function fmt(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

Page({
  behaviors: [guard],
  data: { list: [], visitors: [], openid: '', role: 'manager', note: '', projects: [], showMatrix: false, matrix: [], matrixTitle: '' },
  onLoad() {
    this.guard(['owner']).then(r => {
      if (r) { this.load(); this.loadVisitors(); this.loadProjects() }
    })
  },
  load() {
    call('listAdmins').then(d => {
      // 预计算时间文本（WXML 禁 JS 调用，如 new Date().toLocaleString）
      const list = (d.list || []).map(a => ({ ...a, roleChangedAtText: fmt(a.roleChangedAt) }))
      this.setData({ list: this._decorate(list) })
    }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  // 给管理员列表附「通知范围」徽标：统计该管理员在几个项目里处于可接收范围
  // （projects.notifyAdmins === 'all' 或数组含其 openid 即算在内）
  _decorate(list) {
    const projects = this.data.projects || []
    return (list || []).map(a => {
      const cnt = projects.filter(p => {
        const na = p.notifyAdmins
        return (na == null || na === 'all' || !Array.isArray(na)) ? true : na.indexOf(a.openid) >= 0
      }).length
      const scopeText = projects.length ? (cnt === projects.length ? '全部项目' : `指定 ${cnt} 项`) : '—'
      return Object.assign({}, a, { scopeText })
    })
  },
  loadVisitors() {
    call('listVisitors')
      .then(d => this.setData({
        visitors: (d.list || []).map(v => ({ ...v, lastSeenText: fmt(v.lastSeen) }))
      }))
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  onOpenid(e) { this.setData({ openid: e.detail.value }) },
  onNote(e) { this.setData({ note: e.detail.value }) },
  pickRole(e) { this.setData({ role: e.currentTarget.dataset.r }) },
  add() {
    const { openid, role, note } = this.data
    if (!openid.trim()) return wx.showToast({ title: '请填写 openid', icon: 'none' })
    this.doAdd(openid.trim(), role, note, () => this.setData({ openid: '', note: '' }))
  },
  addVisitor(e) {
    const { openid, role } = e.currentTarget.dataset
    this.doAdd(openid, role, '', null)
  },
  doAdd(openid, role, note, after) {
    wx.showLoading({ title: '授权中' })
    call('addAdmin', { openid, role, note })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '已授权', icon: 'success' })
        this.load()
        this.loadVisitors()
        if (after) after()
      })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  // 角色切换（manager ⇄ owner）。走 updateAdminRole，保留 nickname/createdAt 等记录。
  // ⚠️ 二次确认必须**列清权限差异**：owner 比 manager 多 14 项高危能力
  //   （管理员管理 / 项目配置 / 顾客名录 / 黑名单 / 数据分析 / 导出 / 发短信 / 公众号菜单 / 界面设置…），
  //   只写「确认提权？」会让店主在不了解后果的情况下点确认。
  async changeRole(e) {
    const { openid, cur, name } = e.currentTarget.dataset
    if (!openid) return
    const isPromote = cur === 'manager'
    const to = isPromote ? 'owner' : 'manager'
    const who = name || '该管理员'

    const content = isPromote
      ? `将「${who}」升为超级管理员？\n\n对方将额外获得：\n· 管理员管理（可再授权他人）\n· 项目配置 / 新建与发布项目\n· 顾客名录（全部顾客手机号）\n· 黑名单 / 数据分析 / 导出数据\n· 短信与公众号菜单配置 / 界面设置\n\n即对方能做的事与你完全相同。`
      : `将「${who}」降为普通管理员？\n\n对方将**立即失去**：\n· 管理员管理 / 项目配置 / 顾客名录\n· 黑名单 / 数据分析 / 导出数据\n· 短信 / 公众号菜单 / 界面设置\n\n仅保留：店铺菜单、菜品评价、预约管理、审核。`

    const confirmed = await new Promise(res => wx.showModal({
      title: isPromote ? '升为超级管理员' : '降为普通管理员',
      content,
      confirmText: isPromote ? '确认升权' : '确认降权',
      confirmColor: isPromote ? '#7A5230' : '#B3261E',
      success: x => res(x.confirm),
      fail: () => res(false)
    }))
    if (!confirmed) return

    wx.showLoading({ title: '保存中' })
    call('updateAdminRole', { openid, role: to })
      .then(d => {
        wx.hideLoading()
        const unchanged = d && d.changed === false
        wx.showToast({
          title: unchanged ? '角色未变化' : (isPromote ? '已升为超级管理员' : '已降为普通管理员'),
          icon: unchanged ? 'none' : 'success'
        })
        this.load()
      })
      .catch(err => { wx.hideLoading(); wx.showToast({ title: err.message, icon: 'none' }) })
  },
  remove(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '移除管理员', content: '确认移除该管理员？', confirmText: '移除',
      success: r => {
        if (r.confirm) call('removeAdmin', { adminId: id }).then(() => this.load()).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
      }
    })
  },
  setNickname(e) {
    const { openid, cur } = e.currentTarget.dataset
    wx.showModal({
      title: '设置昵称',
      editable: true,
      placeholderText: '输入便于识别的昵称',
      content: cur || '',
      success: r => {
        if (!r.confirm) return
        const nickname = (r.content || '').trim()
        if (!nickname) return wx.showToast({ title: '昵称不能为空', icon: 'none' })
        wx.showLoading({ title: '保存中' })
        call('updateAdminNickname', { openid, nickname })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已保存', icon: 'success' })
            this.load()
          })
          .catch(err => { wx.hideLoading(); wx.showToast({ title: err.message, icon: 'none' }) })
      }
    })
  },

  // ===== 管理员通知按项目分配（项目维度：projects.notifyAdmins）=====
  // 入口：每位管理员卡片「通知范围」→ 弹出跨项目分配矩阵（owner 专属，与页面 guard 一致）
  loadProjects() {
    call('listProjects').then(d => {
      const projects = d.list || []
      this.setData({ projects }, () => {
        // 项目加载完成后回写每个管理员的「通知范围」徽标，避免初始空项目显示『—』
        this.setData({ list: this._decorate(this.data.list) })
      })
    }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  openMatrix(e) {
    const focusName = e.currentTarget.dataset.name || ''
    const projects = this.data.projects || []
    const admins = this.data.list || []   // 管理员列表（含 openid + nickname）
    if (!projects.length || !admins.length) {
      return wx.showToast({ title: '暂无可配置的项目或管理员', icon: 'none' })
    }
    // 矩阵：每行一个项目，每列一个管理员；cell.on = 该管理员是否接收该项目通知
    const matrix = projects.map(p => {
      const na = p.notifyAdmins
      const scope = (na == null || na === 'all' || !Array.isArray(na)) ? 'all' : 'list'
      const set = scope === 'all' ? null : new Set(na)
      const cells = admins.map(a => ({
        openid: a.openid,
        name: a.nickname || a.openid,
        on: scope === 'all' ? true : set.has(a.openid),
        changed: false
      }))
      return { pid: p._id, name: p.name, scope, cells }
    })
    this.setData({ showMatrix: true, matrix, matrixTitle: focusName ? `通知分配（${focusName}）` : '通知分配矩阵' })
  },
  toggleCell(e) {
    const { pi, ai } = e.currentTarget.dataset
    const on = this.data.matrix[pi].cells[ai].on
    this.setData({
      [`matrix[${pi}].cells[${ai}].on`]: !on,
      [`matrix[${pi}].cells[${ai}].changed`]: true
    })
  },
  closeMatrix() { this.setData({ showMatrix: false }) },
  noop() {},
  saveMatrix() {
    const admins = this.data.list || []
    const allOpenids = admins.map(a => a.openid)
    const allCount = allOpenids.length
    const dirty = []
    this.data.matrix.forEach(p => {
      if (!p.cells.some(c => c.changed)) return
      // 按当前勾选重建该项目的接收人列表
      const newList = allOpenids.filter((oid, i) => p.cells[i] && p.cells[i].on)
      const value = newList.length === allCount ? 'all' : newList
      dirty.push({ projectId: p.pid, notifyAdmins: value })
    })
    if (!dirty.length) { this.closeMatrix(); return }
    wx.showLoading({ title: '保存中' })
    Promise.all(dirty.map(d => call('updateProject', d)))
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '已保存', icon: 'success' })
        this.closeMatrix()
        this.loadProjects()
      })
      .catch(err => { wx.hideLoading(); wx.showToast({ title: err.message, icon: 'none' }) })
  }
})
