const { call } = require('../../utils/cloud')
const { requestSubscribe, tmplIdsOfPlan, notifyPlanOf, normalizeSubs } = require('../../utils/subscribe')

// 微信同声传译插件（WechatSI）：端侧 ASR，不上云、不出网，规避 CloudBase 出网白名单 412 坑。
// 插件未在本小程序后台启用时 requirePlugin 会抛错 → 降级隐藏麦克风入口，不影响文字预约。
let plugin = null
try { plugin = requirePlugin('WechatSI') } catch (e) { plugin = null }

let _mid = 0
function mkId() { return ++_mid }

// 快捷短语兜底：后台未配置 / 拉取失败时使用（与云端 getAiConfig 的 DEFAULT_QUICK 保持一致）
const DEFAULT_QUICK = [
  { label: '明天·法兰绒', text: '明天两点，两人，法兰绒深烘' },
  { label: '清酒品鉴', text: '清酒品鉴怎么约？' },
  { label: '到店引导', text: '你们家怎么走？营业到几点？' }
]

Page({
  data: {
    messages: [],
    draft: '',
    intent: '',            // '' | 'confirm'
    confirmation: null,
    profile: { name: '', phone: '' },
    downgraded: false,
    scrollTo: '',
    success: false,
    successInfo: null,
    sending: false,
    // 语音输入
    voiceMode: false,      // false=键盘态 true=语音态
    recording: false,
    liveText: '',          // 录音过程中的实时识别结果
    pluginOk: !!plugin,    // WechatSI 不可用时自动隐藏麦克风图标
    // 隐私授权（录音属隐私接口，须先让用户同意《用户隐私保护指引》）
    showPrivacy: false,
    privacyName: '《用户隐私保护指引》',
    // 快捷短语（输入框上方）：后台「AI 预约 · 快捷短语」可配置，点一下即发送 item.text
    quickReplies: DEFAULT_QUICK.map((x, i) => ({ _i: i, label: x.label, text: x.text }))
  },

  onLoad(q) {
    const pid = (q && q.projectId) || ''
    this.projectId = pid
    const welcome = pid
      ? '我是 AI 预约助理，可以帮你完成预约或解答疑问～想约哪个时段直接说就行。'
      : '我是 AI 预约助理，可以帮你预约或解答疑问。试着说「明天两点，两人，法兰绒深烘」？'
    this.setData({ messages: [{ id: mkId(), role: 'assistant', content: welcome }] })
    this.loadQuick()
    this.initVoice()
  },

  // 拉取后台配置的快捷短语；失败/未配置时静默沿用内置默认，不打断进入 AI 页
  loadQuick() {
    call('getAiConfig').then(d => {
      const list = (d && d.quickReplies) || []
      if (!list.length) return
      this.setData({ quickReplies: list.map((x, i) => ({ _i: i, label: x.label, text: x.text })) })
    }).catch(() => {})
  },

  // ===== 语音输入（WechatSI 端侧识别）=====
  initVoice() {
    if (!plugin) { this.setData({ pluginOk: false }); return }
    try {
      const m = plugin.getRecordRecognitionManager()
      m.onStart = () => { this.setData({ recording: true, liveText: '' }) }
      m.onRecognize = (res) => {
        const t = (res && res.result) || ''
        if (t) this.setData({ liveText: t })
      }
      m.onStop = (res) => {
        const final = (((res && res.result) || '') || this.data.liveText || '').trim()
        this.setData({ recording: false, liveText: '' })
        if (final) this.setData({ draft: final }, () => this.send())
        else wx.showToast({ title: '没听清，请再说一次', icon: 'none' })
      }
      m.onError = (res) => {
        this.setData({ recording: false, liveText: '' })
        const errmsg = String(((res && res.msg) || (res && res.errMsg) || ''))
        // 微信侧隐私/授权类报错单独给出可执行指引，避免只看到「没权限」却不知为何
        if (errmsg.indexOf('not declared in the privacy agreement') >= 0) {
          wx.showModal({
            title: '隐私声明尚未生效',
            content: '后台《用户隐私保护指引》需声明「访问你的麦克风」并通过审核（新增声明约 5 分钟后生效）。请稍后重试。',
            showCancel: false
          })
        } else if (errmsg.indexOf('privacy api banned') >= 0 || errmsg.indexOf('api scope is not declared') >= 0) {
          wx.showModal({
            title: '录音接口暂不可用',
            content: '多为后台提审时勾选了「未采集隐私」或未声明隐私协议导致。请到 mp 后台检查《用户隐私保护指引》后重试。',
            showCancel: false
          })
        } else {
          wx.showToast({ title: '没听清，请再说一次', icon: 'none' })
        }
      }
      this._rec = m
    } catch (e) {
      this.setData({ pluginOk: false })
    }

    // 被动监听：微信在调用隐私接口而用户未同步过同意状态时触发（基础库 ≥2.32.3）
    if (wx.onNeedPrivacyAuthorization) {
      wx.onNeedPrivacyAuthorization(resolve => {
        this._privacyResolve = resolve
        this.setData({ showPrivacy: true })
      })
    }
    if (wx.getPrivacySetting) {
      wx.getPrivacySetting({
        success: r => { if (r && r.privacyContractName) this.setData({ privacyName: r.privacyContractName }) },
        fail: () => {}
      })
    }
  },

  // ===== 隐私授权 =====
  // 录音属隐私接口：须先让用户点击同意按钮同步「已阅读隐私协议」，否则接口被微信拦截
  ensurePrivacy() {
    return new Promise(resolve => {
      if (!wx.getPrivacySetting) return resolve(true) // 低基础库无隐私校验，不阻断
      wx.getPrivacySetting({
        success: r => {
          if (!r || !r.needAuthorization) return resolve(true)
          this._privacyWaiter = resolve
          this.setData({ showPrivacy: true })
        },
        fail: () => resolve(true)
      })
    })
  },

  openPrivacyContract() {
    if (wx.openPrivacyContract) wx.openPrivacyContract({})
  },

  onAgreePrivacy() {
    this.setData({ showPrivacy: false })
    if (this._privacyResolve) { const r = this._privacyResolve; this._privacyResolve = null; r({ buttonId: 'agree-btn', event: 'agree' }) }
    if (this._privacyWaiter) { const w = this._privacyWaiter; this._privacyWaiter = null; w(true) }
  },

  onDisagreePrivacy() {
    this.setData({ showPrivacy: false, voiceMode: false })
    if (this._privacyResolve) { const r = this._privacyResolve; this._privacyResolve = null; r({ event: 'disagree' }) }
    if (this._privacyWaiter) { const w = this._privacyWaiter; this._privacyWaiter = null; w(false) }
    wx.showToast({ title: '已切换为文字输入', icon: 'none' })
  },

  async toggleMode() {
    if (this.data.recording) return
    const toVoice = !this.data.voiceMode
    // 切入语音态前先过隐私授权，避免「按住才发现没权限」的挫败感
    if (toVoice) {
      const agreed = await this.ensurePrivacy()
      if (!agreed) return
    }
    this.setData({ voiceMode: toVoice, liveText: '' })
  },

  ensureRecordAuth() {
    return new Promise(resolve => {
      wx.getSetting({
        success: r => {
          const st = r.authSetting && r.authSetting['scope.record']
          if (st === true) return resolve(true)
          if (st === false) {
            wx.showModal({
              title: '需要麦克风权限',
              content: '语音预约需要录音权限，请在设置中开启。',
              confirmText: '去设置',
              success: m => { if (m.confirm) wx.openSetting() }
            })
            return resolve(false)
          }
          wx.authorize({
            scope: 'scope.record',
            success: () => resolve(true),
            fail: (e) => {
              this.reportAuthError(e)
              resolve(false)
            }
          })
        },
        fail: () => resolve(true) // 取不到授权状态时交给微信自身弹窗处理
      })
    })
  },

  // 把微信原始 errMsg 翻译成可执行指引，避免只看到「没权限」
  reportAuthError(e) {
    const m = String((e && e.errMsg) || (e && e.msg) || '')
    if (m.indexOf('not declared in the privacy agreement') >= 0) {
      wx.showModal({
        title: '隐私声明尚未生效',
        content: '后台《用户隐私保护指引》需声明「访问你的麦克风」。补充声明约 5 分钟后生效，请在 mp 后台确认已发布后重试。',
        showCancel: false
      })
    } else if (m.indexOf('privacy api banned') >= 0) {
      wx.showModal({
        title: '录音接口被禁用',
        content: '多为提审时勾选了「未采集隐私」或未声明隐私协议所致。请到 mp 后台重新提交《用户隐私保护指引》。',
        showCancel: false
      })
    } else if (m.indexOf('auth deny') >= 0 || m.indexOf('auth denied') >= 0) {
      wx.showToast({ title: '你拒绝了麦克风授权', icon: 'none' })
    } else {
      wx.showToast({ title: '未获得麦克风权限：' + (m ? m.slice(0, 40) : '未知原因'), icon: 'none' })
    }
  },

  async onVoiceStart() {
    if (this.data.recording || !this._rec) return
    // 顺序很关键：先同步隐私授权，再申请系统录音权限，最后才开始录音
    const agreed = await this.ensurePrivacy()
    if (!agreed) return
    const ok = await this.ensureRecordAuth()
    if (!ok) return
    try {
      this._rec.start({ lang: 'zh_CN', duration: 60000 })
    } catch (e) {
      wx.showToast({ title: '无法开始录音', icon: 'none' })
    }
  },

  onVoiceEnd() {
    if (!this.data.recording || !this._rec) return
    try { this._rec.stop() } catch (e) { this.setData({ recording: false, liveText: '' }) }
  },

  onUnload() { this.onVoiceEnd() },

  onDraft(e) { this.setData({ draft: e.detail.value }) },

  scrollBottom() {
    const len = this.data.messages.length
    if (len) this.setData({ scrollTo: 'm' + this.data.messages[len - 1].id })
  },

  async send() {
    const text = (this.data.draft || '').trim()
    if (!text || this.data.sending) return
    const userMsg = { id: mkId(), role: 'user', content: text }
    const msgs = this.data.messages.concat(userMsg)
    this.setData({ messages: msgs, draft: '', sending: true })
    this.scrollBottom()
    try {
      const res = await call('aiReserve', {
        messages: msgs.map(m => ({ role: m.role, content: m.content })),
        projectId: this.projectId
      })
      this.handleResult(res)
    } catch (e) {
      // 服务可用性降级（spec §5.5）：展示降级提示卡，提供「进入常规预约」，不阻断用户
      const tip = { id: mkId(), role: 'assistant', content: '抱歉，AI 助理暂时连接不上。您可以改用常规预约，不影响操作～' }
      this.setData({ downgraded: true, messages: this.data.messages.concat(tip) })
      this.scrollBottom()
    } finally {
      this.setData({ sending: false })
    }
  },

  quick(e) {
    this.setData({ draft: e.currentTarget.dataset.q }, () => this.send())
  },

  handleResult(res) {
    if (!res) return
    if (res.intent === 'confirm') {
      const assistantMsg = { id: mkId(), role: 'assistant', content: res.reply }
      this.setData({
        messages: this.data.messages.concat(assistantMsg),
        intent: 'confirm',
        confirmation: res.confirmation,
        profile: res.profile || { name: '', phone: '' }
      })
      this.scrollBottom()
      return
    }
    const reply = res.reply || (res.intent === 'ask' ? '请补充一下信息～' : '好的～')
    this.setData({
      messages: this.data.messages.concat([{ id: mkId(), role: 'assistant', content: reply }]),
      intent: ''
    })
    this.scrollBottom()
  },

  cancelConfirm() {
    this.setData({ intent: '', confirmation: null })
    this.setData({ messages: this.data.messages.concat([{ id: mkId(), role: 'assistant', content: '好的，已取消本次确认。您还想约什么？' }]) })
    this.scrollBottom()
  },

  async confirm() {
    const c = this.data.confirmation
    if (!c) return
    wx.showLoading({ title: '提交中' })
    try {
      const d = await call('getProject', { projectId: c.projectId })
      const plan = notifyPlanOf({ date: c.date, sessionStart: c.sessionStart, sessionEnd: c.sessionEnd }, d.notifyCfg)
      const ids = tmplIdsOfPlan(plan, null)
      if (ids.length) { try { await requestSubscribe(ids) } catch (e) { /* 订阅失败不阻断 */ } }
      const payload = { projectId: c.projectId, date: c.date, sessionId: c.sessionId, name: this.data.profile.name, partySize: c.partySize }
      if (this.data.profile.phone) payload.phone = this.data.profile.phone
      const r = await call('createReservation', { ...payload, subscribed: normalizeSubs({}) })
      wx.hideLoading()
      const needReview = r && r.review === 'pending'
      this.setData({
        intent: '',
        success: true,
        successInfo: { projectName: c.projectName, date: c.date, sessionStart: c.sessionStart, sessionEnd: c.sessionEnd, partySize: c.partySize, needReview }
      })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: e.message || '预约失败', icon: 'none' })
    }
  },

  goMine() { wx.switchTab({ url: '/pages/mine/mine' }) },
  closeSuccess() { wx.reLaunch({ url: '/pages/index/index' }) },
  goBooking() {
    const pid = this.projectId || ''
    wx.navigateTo({ url: '/pages/booking/booking' + (pid ? ('?projectId=' + pid) : '') })
  }
})
