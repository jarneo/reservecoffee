const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')
const { requestSubscribe } = require('../../../utils/util')
const { ADMIN_TPLS } = require('../../../utils/subscribe')

// 归一化截止规则为新模型 { mode:'before'|'after', minutes }，兼容旧 {type,hours,time}
function normCutoff(c) {
  if (c && (c.mode === 'before' || c.mode === 'after') && Number(c.minutes) > 0) {
    return { mode: c.mode, minutes: Math.min(1440, Math.max(1, Number(c.minutes))) }
  }
  return { mode: 'before', minutes: 30 }
}

Page({
  behaviors: [guard],
  data: {
    projects: [], projectId: '', project: null, projectName: '', intro: '', introImages: [], openDays: [], allSchedules: [], dayList: [],
    year: 2026, month: 8,
    showAdd: false, addDate: '', addForm: { start: '10:00', end: '11:30', capacity: 8 },
    global: { needReview: false, paused: false, dailyLimit: 1, advanceDays: 7, maxParty: 2, subscribeNotify: true, smsEnabled: false, cutoff: { mode: 'before', minutes: 30 }, fields: ['name', 'phone'] },
    cutoffText: '', fieldsText: '',
    showCutoff: false, cutoffDraft: { mode: 'before', minutes: 30 },
    showFields: false, fieldsDraft: ['name', 'phone'],
    fieldCatalog: [
      { key: 'name', label: '姓名', lock: false, req: false },
      { key: 'phone', label: '手机号', lock: false, req: false },
      { key: 'wechat', label: '微信', lock: false, req: false },
      { key: 'note', label: '备注', lock: false, req: false },
      { key: 'gender', label: '性别', lock: false, req: false },
      { key: 'age', label: '年龄', lock: false, req: false }
    ]
  },

  onLoad(options) { this.guard(['owner']).then(r => { if (r) this.loadProjects(options && options.projectId) }) },

  // projectId 来自项目管理页点卡片跳转（?projectId=），优先选中该项目；缺省才取首个
  loadProjects(projectId) {
    call('listProjects').then(d => {
      const list = d.list || []
      const target = (projectId && list.find(x => x._id === projectId)) ? projectId : (list[0] && list[0]._id)
      const sel = list.find(x => x._id === target)
      // 乐观设置当前项目名（不依赖 getProjectAdmin，云端坏掉也能显示）
      this.setData({ projects: list, projectName: sel ? sel.name : '' })
      if (target) this.selectProject(target)
    })
  },

  onProjectPick(e) {
    const item = this.data.projects[e.detail.value]
    // 切换时立即显示所选项目名称（乐观）
    this.setData({ projectName: item ? item.name : '' })
    this.selectProject(item._id)
  },

  // 项目首页描述（顾客端首页卡片下方文字）：本地即时回显，随 saveAll 提交
  onIntro(e) { this.setData({ intro: e.detail.value }) },

  async selectProject(id) {
    this.setData({ projectId: id })
    // 改用 getProjectAdmin：不限 published，草稿/下架项目也能进配置页
    const d = await call('getProjectAdmin', { projectId: id })
    const p = d.project
    // 防御：云端 getProjectAdmin 异常时（返回非预期结构），不崩溃，仅保留已显示的 projectName
    if (!p) {
      wx.showToast({ title: '项目详情加载失败，请检查云端函数', icon: 'none' })
      return
    }
    const now = new Date()
    this.setData({
      project: p, intro: p.intro || '', introImages: p.introImages || [], openDays: p.openDays || [],
      year: now.getFullYear(), month: now.getMonth() + 1,
      global: {
        needReview: !!p.needReview, paused: !!p.paused, dailyLimit: p.dailyLimit || 1,
        advanceDays: p.advanceDays || 7,
        maxParty: p.maxParty || 2, subscribeNotify: !!p.subscribeNotify,
        smsEnabled: !!p.smsEnabled,
        cutoff: normCutoff(p.cutoff),
        fields: p.fields || ['name', 'phone']
      }
    })
    this.computeCutoffText()
    this.computeFieldsText()
    await this.refreshSchedules()
  },

  // ===== 介绍图片管理（上传 / 替换 / 删除 / 排序 / 说明） =====
  saveIntroImages(list) {
    return call('updateProject', { projectId: this.data.projectId, introImages: list })
      .then(() => { this.setData({ introImages: list }); return true })
      .catch(e => { wx.showToast({ title: e.message, icon: 'none' }); return false })
  },

  async uploadOne(tempPath) {
    const ext = (tempPath.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
    const cloudPath = `projects/${this.data.projectId}/${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`
    const res = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath })
    return res.fileID
  },

  // 添加图片（最多 9 张）
  addImages() {
    const remain = 9 - this.data.introImages.length
    if (remain <= 0) return wx.showToast({ title: '最多 9 张', icon: 'none' })
    wx.chooseMedia({
      count: Math.min(remain, 9), mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: async (r) => {
        wx.showLoading({ title: '上传中' })
        try {
          const list = this.data.introImages.slice()
          for (const f of r.tempFiles) {
            const fileId = await this.uploadOne(f.tempFilePath)
            list.push({ fileId, caption: '', sort: list.length })
          }
          const ok = await this.saveIntroImages(list)
          if (ok) wx.showToast({ title: '已添加', icon: 'success' })
        } catch (e) {
          wx.showToast({ title: '上传失败', icon: 'none' })
        } finally { wx.hideLoading() }
      }
    })
  },

  // 替换某张（先删旧云文件，再上传新图）
  async replaceImage(e) {
    const i = e.currentTarget.dataset.i
    const old = this.data.introImages[i]
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: async (r) => {
        wx.showLoading({ title: '替换中' })
        try {
          const fileId = await this.uploadOne(r.tempFiles[0].tempFilePath)
          const list = this.data.introImages.slice()
          if (old && old.fileId) await call('deleteProjectFile', { fileIds: [old.fileId] }).catch(() => {})
          list[i] = { fileId, caption: old ? old.caption : '', sort: i }
          const ok = await this.saveIntroImages(list)
          if (ok) wx.showToast({ title: '已替换', icon: 'success' })
        } catch (err) {
          wx.showToast({ title: '替换失败', icon: 'none' })
        } finally { wx.hideLoading() }
      }
    })
  },

  // 删除某张（先删云文件，再移除元数据）
  async deleteImage(e) {
    const i = e.currentTarget.dataset.i
    const it = this.data.introImages[i]
    if (!it) return
    wx.showModal({
      title: '删除图片', content: '将从项目介绍中移除，并删除云存储文件。', confirmText: '删除',
      success: async (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '删除中' })
        try {
          if (it.fileId) await call('deleteProjectFile', { fileIds: [it.fileId] }).catch(() => {})
          const list = this.data.introImages.slice()
          list.splice(i, 1)
          const ok = await this.saveIntroImages(list)
          if (ok) wx.showToast({ title: '已删除', icon: 'success' })
        } catch (err) {
          wx.showToast({ title: '删除失败', icon: 'none' })
        } finally { wx.hideLoading() }
      }
    })
  },

  // 上移 / 下移排序
  moveImage(e) {
    const i = e.currentTarget.dataset.i
    const dir = Number(e.currentTarget.dataset.dir)
    const j = i + dir
    const list = this.data.introImages.slice()
    if (j < 0 || j >= list.length) return
    const t = list[i]; list[i] = list[j]; list[j] = t
    list.forEach((x, k) => { x.sort = k })
    this.saveIntroImages(list).then(ok => { if (ok) wx.showToast({ title: '已排序', icon: 'success' }) })
  },

  // 修改说明文字
  onCaption(e) {
    const i = e.currentTarget.dataset.i
    const caption = e.detail.value
    const list = this.data.introImages.slice()
    list[i] = { ...list[i], caption }
    this.setData({ introImages: list }) // 本地即时回显，保存时随整组提交
  },
  saveCaptions() {
    const list = this.data.introImages.map((x, k) => ({ ...x, sort: k }))
    this.saveIntroImages(list).then(ok => { if (ok) wx.showToast({ title: '已保存说明', icon: 'success' }) })
  },

  // 一次性拉取该项目全部日期场次，用于按日展开
  async refreshSchedules() {
    const d = await call('getSchedule', { projectId: this.data.projectId })
    this.setData({ allSchedules: d.schedules || [] })
    this.buildDayList()
  },
  buildDayList() {
    const map = {}
    const closedMap = {}
    ;(this.data.allSchedules || []).forEach(s => { map[s.date] = s.sessions; closedMap[s.date] = !!s.closed })
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    // 去重：openDays 历史上可能因非去重写入而含重复日期，避免同一天重复成块
    // 仅展示「项目时间设置里选中的日期」且为「今天及以后」（如今天 8/17，8/15 不展示）
    const uniqueDays = [...new Set(this.data.openDays || [])]
      .filter(d => typeof d === 'string' && d >= todayStr)
      .sort()
    const dayList = uniqueDays.map(date => ({
      date,
      closed: !!closedMap[date],
      sessions: (map[date] || []).map(x => ({ ...x, remaining: (x.capacity || 0) - (x.booked || 0) }))
    }))
    this.setData({ dayList })
  },

  // ① 时间设置：点击日期直接切换可约/不可约（支持多选，立即持久化）
  onCalSelect(e) {
    const ymd = e.detail.ymd
    const open = this.data.openDays.includes(ymd)
    call('setOpenDays', { projectId: this.data.projectId, action: open ? 'close' : 'open', dates: [ymd] })
      .then(d => {
        this.setData({ openDays: d.open })
        this.buildDayList()
        if (d.protectedDays && d.protectedDays.length) {
          wx.showModal({ title: '无法关闭', content: d.message, showCancel: false })
        } else {
          wx.showToast({ title: open ? '已关闭' : '已开放', icon: 'success' })
        }
      })
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },

  gReview(e) { this.setData({ 'global.needReview': e.detail.value }) },
  gSms(e) { this.setData({ 'global.smsEnabled': e.detail.value }) },
  gDaily(e) { this.setData({ 'global.dailyLimit': Number(e.detail.value) || 1 }) },
  gAdv(e) { this.setData({ 'global.advanceDays': Number(e.detail.value) || 7 }) },
  stepDaily(e) {
    const d = Number(e.currentTarget.dataset.d)
    const v = Math.max(1, Math.min(20, (this.data.global.dailyLimit || 1) + d))
    this.setData({ 'global.dailyLimit': v })
  },
  stepAdv(e) {
    const d = Number(e.currentTarget.dataset.d)
    const v = Math.max(1, Math.min(30, (this.data.global.advanceDays || 7) + d))
    this.setData({ 'global.advanceDays': v })
  },
  stepMax(e) {
    const d = Number(e.currentTarget.dataset.d)
    const v = Math.max(1, Math.min(20, (this.data.global.maxParty || 2) + d))
    this.setData({ 'global.maxParty': v })
  },
  gSub(e) {
    const v = e.detail.value
    this.setData({ 'global.subscribeNotify': v })
    if (v) requestSubscribe(ADMIN_TPLS)
  },
  // 底部统一保存：保存整个项目的配置信息（全局设定区 + 顶部已改动的字段，均随此次提交）
  saveAll() {
    const g = this.data.global
    if (!(g.advanceDays >= 1 && g.advanceDays <= 30)) return wx.showToast({ title: '提前天数须在1–30', icon: 'none' })
    wx.showLoading({ title: '保存中' })
    call('updateProject', {
      projectId: this.data.projectId,
      needReview: g.needReview, paused: g.paused,
      dailyLimit: g.dailyLimit, advanceDays: g.advanceDays,
      maxParty: g.maxParty, subscribeNotify: g.subscribeNotify,
      smsEnabled: g.smsEnabled,
      cutoff: g.cutoff, fields: g.fields,
      intro: this.data.intro
    }).then(() => {
        wx.hideLoading()
        wx.showToast({ title: '已保存', icon: 'success' })
      })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  publish(e) {
    call('publishProject', { projectId: this.data.projectId, published: e.currentTarget.dataset.v })
      .then(() => wx.showToast({ title: e.currentTarget.dataset.v ? '已发布' : '已下架', icon: 'success' }))
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },

  // ===== 预约截止规则（新模型：场次开始前/开始后 N 分钟） =====
  computeCutoffText() {
    const c = normCutoff(this.data.global.cutoff)
    const text = c.mode === 'before'
      ? `场次开始前 ${c.minutes} 分钟`
      : `场次开始后 ${c.minutes} 分钟`
    this.setData({ cutoffText: text })
  },
  openCutoff() {
    const c = normCutoff(this.data.global.cutoff)
    this.setData({ showCutoff: true, cutoffDraft: { mode: c.mode, minutes: c.minutes } })
  },
  closeCutoff() { this.setData({ showCutoff: false }) },
  onCutoffMode(e) { this.setData({ 'cutoffDraft.mode': e.currentTarget.dataset.m }) },
  onCutoffMin(e) { this.setData({ 'cutoffDraft.minutes': Number(e.currentTarget.dataset.m) || 30 }) },
  onCutoffMinutes(e) { this.setData({ 'cutoffDraft.minutes': Number(e.detail.value) || 30 }) },
  saveCutoff() {
    const c = normCutoff(this.data.cutoffDraft)
    wx.showLoading({ title: '保存中' })
    call('updateProject', { projectId: this.data.projectId, cutoff: c })
      .then(() => {
        this.setData({ showCutoff: false, 'global.cutoff': c })
        this.computeCutoffText()
        wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' })
      })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },

  // ===== 提交预约信息设置 =====
  computeFieldsText() {
    const cat = this.data.fieldCatalog
    const fs = this.data.global.fields || []
    const labels = cat.filter(x => fs.indexOf(x.key) >= 0).map(x => x.label)
    this.setData({ fieldsText: labels.length ? labels.join('、') : '未设置' })
  },
  openFields() {
    this.setData({ showFields: true, fieldsDraft: (this.data.global.fields || []).slice() })
  },
  closeFields() { this.setData({ showFields: false }) },
  toggleField(e) {
    const key = e.currentTarget.dataset.k
    const cat = this.data.fieldCatalog.find(x => x.key === key)
    if (cat && cat.lock) return // 姓名/手机号锁定，不可移除
    const fields = this.data.fieldsDraft.slice()
    const i = fields.indexOf(key)
    if (i >= 0) fields.splice(i, 1); else fields.push(key)
    this.setData({ fieldsDraft: fields })
  },
  saveFields() {
    const fields = this.data.fieldsDraft.slice()
    wx.showLoading({ title: '保存中' })
    call('updateProject', { projectId: this.data.projectId, fields })
      .then(() => {
        this.setData({ showFields: false, 'global.fields': fields })
        this.computeFieldsText()
        wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' })
      })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },

  // ② 每日场次：添加（居中弹层）/ 套用模版 / 复制
  openAdd(e) {
    this.setData({ showAdd: true, addDate: e.currentTarget.dataset.d, addForm: { start: '10:00', end: '11:30', capacity: 8 } })
  },
  closeAdd() { this.setData({ showAdd: false }) },
  noop() {},
  onAddStart(e) { this.setData({ 'addForm.start': e.detail.value }) },
  onAddEnd(e) { this.setData({ 'addForm.end': e.detail.value }) },
  onAddCap(e) { this.setData({ 'addForm.capacity': Number(e.detail.value) || 8 }) },
  onAddCapQuick(e) { this.setData({ 'addForm.capacity': Number(e.currentTarget.dataset.c) || 8 }) },
  confirmAdd() {
    const date = this.data.addDate, f = this.data.addForm
    if (!f.start || !f.end) return wx.showToast({ title: '请填起止时间', icon: 'none' })
    const cur = (this.data.allSchedules.find(s => s.date === date) || {}).sessions || []
    const existing = cur.map(x => ({ id: x.id, start: x.start, end: x.end, capacity: x.capacity, paused: x.paused, desc: x.desc }))
    call('setDaySessions', {
      projectId: this.data.projectId, date,
      sessions: existing.concat([{ start: f.start, end: f.end, capacity: Number(f.capacity) || 8 }])
    }).then(() => {
      this.setData({ showAdd: false })
      this.refreshSchedules()
      wx.showToast({ title: '已添加', icon: 'success' })
    }).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  openTpl(e) {
    const date = e.currentTarget.dataset.d
    wx.showLoading({ title: '加载模版' })
    call('listTemplates').then(d => {
      wx.hideLoading()
      const list = d.list || []
      if (!list.length) return wx.showToast({ title: '暂无模版，请先到「场次模版」新建', icon: 'none' })
      wx.showActionSheet({
        itemList: list.map(t => t.name),
        success: r => {
          const tpl = list[r.tapIndex]
          // 先清空当日配置，再倒入模版（不保留旧场次），保证模版即当日最终配置
          const added = (tpl.slots || []).map(s => ({ start: s.start, end: s.end, capacity: Number(s.max) || 8 }))
          call('setDaySessions', { projectId: this.data.projectId, date, sessions: added })
            .then(() => { this.refreshSchedules(); wx.showToast({ title: '已套用「' + tpl.name + '」（已清空当日旧配置）', icon: 'success' }) })
            .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
        }
      })
    }).catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  openCopy(e) {
    const date = e.currentTarget.dataset.d
    wx.showActionSheet({
      itemList: ['复制到本月', '复制到下个月', '复制到全部'],
      success: r => {
        const target = ['month', 'nextMonth', 'all'][r.tapIndex]
        call('copyDaySessions', { projectId: this.data.projectId, fromDate: date, target })
          .then(res => {
            // 合并新增的目标日期到本地 openDays，否则「复制到本月」之外的目标日（如下月/全部里的未开放日）不会立即显示
            const targets = (res && res.targets) || []
            if (targets.length) {
              const set = new Set([...(this.data.openDays || []), ...targets])
              this.setData({ openDays: [...set] })
            }
            this.refreshSchedules()
            wx.showToast({ title: '已复制', icon: 'success' })
          })
          .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
      }
    })
  },

  // 清空当日场次配置（清空后该日不再有场次，需点下方「保存」才对全局设定生效；此处立即清空场次）
  clearDay(e) {
    const date = e.currentTarget.dataset.d
    wx.showModal({
      title: '清空当日场次',
      content: '将清除 ' + date + ' 的全部场次配置，确认？',
      confirmText: '清空',
      success: r => {
        if (!r.confirm) return
        wx.showLoading({ title: '清空中' })
        call('setDaySessions', { projectId: this.data.projectId, date, sessions: [] })
          .then(() => { this.refreshSchedules(); wx.showToast({ title: '已清空', icon: 'success' }) })
          .catch(err => wx.showToast({ title: err.message, icon: 'none' }))
          .finally(() => wx.hideLoading())
      }
    })
  },

  // 按天暂停 / 恢复：开关直接切换当日 closed
  onDayPause(e) {
    const date = e.currentTarget.dataset.d
    const closed = e.detail.value
    wx.showLoading({ title: '操作中' })
    call('setDayStatus', { projectId: this.data.projectId, date, closed })
      .then(() => {
        this.refreshSchedules()
        wx.showToast({ title: closed ? '已暂停该日预约' : '已恢复该日预约', icon: 'success' })
      })
      .catch(err => wx.showToast({ title: err.message, icon: 'none' }))
      .finally(() => wx.hideLoading())
  },

  onSessionOp(e) {
    const date = e.currentTarget.dataset.date
    this.handleOp(e.detail.action, e.detail.id, date)
  },
  handleOp(action, id, date) {
    if (!date) return
    if (action === 'changeCap') {
      wx.showModal({
        title: '修改名额', editable: true, placeholderText: '新名额(须≥已约)',
        success: r => {
          if (r.confirm) call('setSession', { projectId: this.data.projectId, date, sessionId: id, action: 'changeCap', capacity: Number(r.content) })
            .then(() => this.refreshSchedules()).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
        }
      })
    } else if (action === 'cancelAll') {
      wx.showModal({
        title: '取消全部预约', content: '将取消该场次所有有效预约并释放名额', confirmText: '确认',
        success: r => {
          if (r.confirm) call('setSession', { projectId: this.data.projectId, date, sessionId: id, action: 'cancelAll' })
            .then(() => this.refreshSchedules()).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
        }
      })
    } else {
      call('setSession', { projectId: this.data.projectId, date, sessionId: id, action })
        .then(() => this.refreshSchedules()).catch(e => wx.showToast({ title: e.message, icon: 'none' }))
    }
  }
})
