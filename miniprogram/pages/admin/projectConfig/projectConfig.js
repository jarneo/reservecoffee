const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

Page({
  behaviors: [guard],
  data: {
    projects: [], projectId: '', project: null, introImages: [], openDays: [], allSchedules: [], dayList: [],
    year: 2026, month: 8,
    showAdd: false, addDate: '', addForm: { start: '10:00', end: '11:30', capacity: 8 },
    global: { needReview: false, paused: false, dailyLimit: 1, advanceDays: 7, smsEnabled: false, smsNotice: '', cutoff: { type: '当日', time: '18:00' }, fields: ['name', 'phone'] },
    cutoffText: '', fieldsText: '',
    showCutoff: false, cutoffDraft: { type: '当日', hours: 2, time: '18:00' },
    showFields: false, fieldsDraft: ['name', 'phone'],
    fieldCatalog: [
      { key: 'name', label: '姓名', lock: true, req: true },
      { key: 'phone', label: '手机号', lock: true, req: true },
      { key: 'wechat', label: '微信', lock: false, req: false },
      { key: 'note', label: '备注', lock: false, req: false },
      { key: 'gender', label: '性别', lock: false, req: false },
      { key: 'age', label: '年龄', lock: false, req: false },
      { key: 'companion', label: '同行人数', lock: false, req: false }
    ]
  },

  onLoad(options) { this.guard(['owner']).then(r => { if (r) this.loadProjects(options && options.projectId) }) },

  loadProjects() {
    call('listProjects').then(d => {
      const list = d.list || []
      this.setData({ projects: list })
      if (list.length) this.selectProject(list[0]._id)
    })
  },

  onProjectPick(e) {
    const id = this.data.projects[e.detail.value]._id
    this.selectProject(id)
  },

  async selectProject(id) {
    this.setData({ projectId: id })
    // 改用 getProjectAdmin：不限 published，草稿/下架项目也能进配置页
    const d = await call('getProjectAdmin', { projectId: id })
    const p = d.project
    const now = new Date()
    this.setData({
      project: p, introImages: p.introImages || [], openDays: p.openDays || [],
      year: now.getFullYear(), month: now.getMonth() + 1,
      global: {
        needReview: !!p.needReview, paused: !!p.paused, dailyLimit: p.dailyLimit || 1,
        advanceDays: p.advanceDays || 7,
        smsEnabled: !!p.smsEnabled, smsNotice: p.smsNotice || '',
        cutoff: p.cutoff || { type: '当日', time: '18:00' },
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
    ;(this.data.allSchedules || []).forEach(s => { map[s.date] = s.sessions })
    const dayList = (this.data.openDays || []).slice().sort().map(date => ({
      date,
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
  gPaused(e) { this.setData({ 'global.paused': e.detail.value }) },
  gSms(e) { this.setData({ 'global.smsEnabled': e.detail.value }) },
  onSmsNotice(e) { this.setData({ 'global.smsNotice': e.detail.value }) },
  gDaily(e) { this.setData({ 'global.dailyLimit': Number(e.detail.value) || 1 }) },
  gAdv(e) { this.setData({ 'global.advanceDays': Number(e.detail.value) || 7 }) },
  saveGlobal() {
    const g = this.data.global
    if (!(g.advanceDays >= 1 && g.advanceDays <= 30)) return wx.showToast({ title: '提前天数须在1–30', icon: 'none' })
    call('updateProject', {
      projectId: this.data.projectId, needReview: g.needReview, paused: g.paused,
      dailyLimit: g.dailyLimit, advanceDays: g.advanceDays,
      smsEnabled: g.smsEnabled, smsNotice: g.smsNotice
    }).then(() => {
        wx.showToast({ title: '已保存', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },
  publish(e) {
    call('publishProject', { projectId: this.data.projectId, published: e.currentTarget.dataset.v })
      .then(() => wx.showToast({ title: e.currentTarget.dataset.v ? '已发布' : '已下架', icon: 'success' }))
      .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
  },

  // ===== 预约截止规则 =====
  computeCutoffText() {
    const c = this.data.global.cutoff || { type: '当日', time: '18:00' }
    const text = c.type === '场次前' ? `场次前 ${c.hours || 2} 小时` : `当日 ${c.time || '18:00'} 截止`
    this.setData({ cutoffText: text })
  },
  openCutoff() {
    const c = this.data.global.cutoff || { type: '当日', time: '18:00', hours: 2 }
    this.setData({ showCutoff: true, cutoffDraft: { type: c.type, hours: c.hours || 2, time: c.time || '18:00' } })
  },
  closeCutoff() { this.setData({ showCutoff: false }) },
  onCutoffType(e) { this.setData({ 'cutoffDraft.type': e.currentTarget.dataset.t }) },
  onCutoffHours(e) { this.setData({ 'cutoffDraft.hours': Number(e.detail.value) || 2 }) },
  onCutoffTime(e) { this.setData({ 'cutoffDraft.time': e.detail.value }) },
  saveCutoff() {
    const c = this.data.cutoffDraft
    if (c.type === '场次前' && !(c.hours >= 1)) return wx.showToast({ title: '请填写提前小时数', icon: 'none' })
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
          const cur = (this.data.allSchedules.find(s => s.date === date) || {}).sessions || []
          const existing = cur.map(x => ({ id: x.id, start: x.start, end: x.end, capacity: x.capacity, paused: x.paused, desc: x.desc }))
          const added = (tpl.slots || []).map(s => ({ start: s.start, end: s.end, capacity: Number(s.max) || 8 }))
          call('setDaySessions', { projectId: this.data.projectId, date, sessions: existing.concat(added) })
            .then(() => { this.refreshSchedules(); wx.showToast({ title: '已套用「' + tpl.name + '」', icon: 'success' }) })
            .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
        }
      })
    }).catch(e => { wx.hideLoading(); wx.showToast({ title: e.message, icon: 'none' }) })
  },
  openCopy(e) {
    const date = e.currentTarget.dataset.d
    wx.showActionSheet({
      itemList: ['复制到本月', '复制到未来6个月'],
      success: r => {
        const target = r.tapIndex === 0 ? 'month' : 'all'
        call('copyDaySessions', { projectId: this.data.projectId, fromDate: date, target })
          .then(() => { this.refreshSchedules(); wx.showToast({ title: '已复制', icon: 'success' }) })
          .catch(e => wx.showToast({ title: e.message, icon: 'none' }))
      }
    })
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
