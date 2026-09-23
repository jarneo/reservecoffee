const { call } = require('../../utils/cloud')
const { requestSubscribe } = require('../../utils/util')
const { tmplIdsOfPlan, notifyPlanOf, CUSTOMER_SUBS } = require('../../utils/subscribe')

// 微信同声传译插件（WechatSI）：端侧 ASR，不上云、不出网，规避 CloudBase 出网白名单 412 坑。
// 插件未在本小程序后台启用时 requirePlugin 会抛错 → 降级隐藏麦克风入口，不影响文字预约。
let plugin = null
try { plugin = requirePlugin('WechatSI') } catch (e) { plugin = null }

let _mid = 0
function mkId() { return ++_mid }

// ⭐ 预约必填项校验（2026-09-24 口径）：**称呼与手机号缺一不可**。
//   以前只有「称呼」是云端硬校验、手机号全程可选，导致 AI 答"可以不留"也能提交，
//   但到店通知发不出去。现在前端两处（聊天气泡卡 / 补全层）与云端统一按此判定。
function missingProfile(p) {
  const o = p || {}
  const miss = []
  if (!String(o.name || '').trim()) miss.push('称呼')
  if (!String(o.phone || '').trim()) miss.push('手机号')
  return miss
}

// ⚠️ 内置默认开场白：必须与云端 getAiConfig 的 DEFAULT_GREETING 保持一致。
//   （2026-09-24 抓到一个潜伏很久的 bug：ai.js 里**只用了这个常量却从没定义过** ——
//    onLoad 第一行 setData 就抛 ReferenceError 中断，后面的 loadConfig / initVoice /
//    checkProfile / applyOaCard 全都从未执行过。真机表现就是"开场白只出现一次、快捷短语和
//    资料弹层都不工作"。补上定义后这几条链路才真正跑起来。）
const DEFAULT_GREETING = '我是二曜路8号咖啡清酒的AI预约助理小曜。任何关于店铺预约、菜单、价格等问题都可以直接问我哦。如果您要预约，试着说"明天两点，2位，深烘法兰绒咖啡"；如果您要咨询店铺的其他问题，也可以直接问我哦。'

// 「新的一次进入」判定阈值：距上次交互超过这么久，再进页面就重新开场（发一条新的开场白）
const GREET_IDLE_MS = 5 * 60 * 1000

// 上滑取消阈值（px）：手指超过起点这么高就进取消区，与微信语音输入手感一致
const VOICE_CANCEL_PX = 60

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
    oaFill: false,         // true = 来自公众号（from=oa），确认卡需补填称呼/手机号
    downgraded: false,
    scrollTo: '',
    success: false,
    successInfo: null,
    sending: false,
    subs: {},            // 订阅授权快照（确认时回写，随 createReservation 落库）
    notifyCfg: null,     // 项目通知配置（确认卡出现时预取，供计算授权模板）
    // 语音输入
    voiceMode: false,      // false=键盘态 true=语音态
    recording: false,
    liveText: '',          // 录音过程中的实时识别结果
    voiceCancel: false,    // 录音中上滑到取消区（松开即放弃本次语音）
    voiceSec: 0,           // 录音计时（秒，最多 60s）
    voiceVol: 12,          // 音量条高度（%，由识别回调驱动，见 _bumpVolume 注释）
    voicePending: false,   // 语音识别结果已落回输入框、待用户复查/撤销后再发送
    pluginOk: !!plugin,    // WechatSI 不可用时自动隐藏麦克风图标
    // 隐私授权（录音属隐私接口，须先让用户同意《用户隐私保护指引》）
    showPrivacy: false,
    privacyName: '《用户隐私保护指引》',
    // 快捷短语（输入框上方）：后台「AI 预约 · 快捷短语」可配置，点一下即发送 item.text
    quickReplies: DEFAULT_QUICK.map((x, i) => ({ _i: i, label: x.label, text: x.text })),
    // ===== 资料补全层 =====
    // 进入 AI 页就主动要一次「称呼 + 手机号」；点确认时若仍缺失，再要一次。
    // 为什么必须用「带按钮的层」而不能自动弹：微信的昵称一键填入依赖 input type="nickname" 被聚焦，
    // 手机号依赖 button open-type="getPhoneNumber" 被点击 —— 两者都必须在用户手势内触发，
    // 程序无法代替用户授权。所以只能给一个看得见、点得到的层。
    showFill: false,
    fillFrom: '',      // 'enter' = 进页面时；'confirm' = 点确认时
    fillTip: ''        // 场景化提示语（点确认时说明还差什么）
  },

  onLoad(q) {
    const pid = (q && q.projectId) || ''
    this.projectId = pid
    // 开场白：先用内置默认（与云端 getAiConfig 的 DEFAULT_GREETING 一致），配置加载后若后台有值则替换
    this._greeting = DEFAULT_GREETING
    this._lastActiveAt = Date.now()
    this.setData({ messages: [{ id: mkId(), role: 'assistant', content: this._greeting }] })
    this.loadConfig()
    this.initVoice()
    // 公众号卡片落地现在走常规确认页（pages/confirm/confirm），会带 from=oa；
    // 该分支自带资料表单，不必再弹本层（applyOaCard 内部已预填）。
    if (!q || q.from !== 'oa') this.checkProfile()
    this.applyOaCard(q)
  },

  // ===== 每次进入都默认发一条开场白 =====
  // 为什么不能只写在 onLoad：onLoad 只在「新建页面实例」时跑一次。小程序切后台再回来、
  // 或从别的页面返回时，页面实例还在栈里 ⇒ onLoad 不再执行 ⇒ 开场白只在"第一次进入"出现。
  // onShow 则是每次页面可见都触发，把它放这里才是"每次进入都有一条"。
  onShow() { this.ensureGreeting() },

  ensureGreeting() {
    const now = Date.now()
    // 不能被开场白覆盖的三种状态：公众号带过来的确认卡、已出现确认卡、已下单成功页
    if (this.fromOa || this.data.intent === 'confirm' || this.data.success) {
      this._lastActiveAt = now
      return
    }
    const msgs = this.data.messages || []
    const hasUser = msgs.some(m => m.role === 'user')
    const idle = now - (this._lastActiveAt || 0)
    // 正在聊 / 刚聊过（5 分钟内）：原样保留对话，不打断
    if (hasUser && idle < GREET_IDLE_MS) { this._lastActiveAt = now; return }
    // 新的一次进入：从头开始，默认发一条开场白
    this.setData({
      messages: [{ id: mkId(), role: 'assistant', content: this._greeting || DEFAULT_GREETING }],
      intent: '', confirmation: null, draft: '', voicePending: false, downgraded: false
    }, () => this.scrollBottom())
    this._lastActiveAt = now
  },

  // ===== 资料前置：进页面即要一次昵称与手机号 =====
  // 目的：AI 很快会谈妥并给出确认卡，若等到那一刻才要资料，顾客会卡在「卡片填不了、提交不了」。
  // 提前拿到 → 后续预约全程免填；拿不到也不阻断聊天（有「稍后再说」，点确认时会再要一次）。
  checkProfile() {
    return call('getMyProfile').then(d => {
      const p = (d && d.profile) || {}
      const name = String(p.name || '').trim()
      const phone = String(p.phone || '').trim()
      if (name) this.data.profile.name = name
      if (phone) this.data.profile.phone = phone
      this.setData({ profile: { ...this.data.profile } })
      if (!name || !phone) this.setData({ showFill: true, fillFrom: 'enter', fillTip: '' })
    }).catch(() => {
      // 拉取失败大概率是没建过资料的新顾客：照样要一次
      this.setData({ showFill: true, fillFrom: 'enter', fillTip: '' })
    })
  },

  // 弹层里的「填好了，继续」：校验后关闭；若是从「确认预约」弹出来的，顺手把提交接上，少点一次
  // ⭐ 称呼与手机号都是**必填项**（2026-09-24 口径）：缺任一项都不能关层放行，
  //   并且要用弹窗说清「为什么必须留 + 手机号只用于本次预约通知」，而不是一闪而过的 toast。
  saveFill() {
    const name = String(this.data.profile.name || '').trim()
    const phone = String(this.data.profile.phone || '').trim()
    const miss = []
    if (!name) miss.push('称呼')
    if (!phone) miss.push('手机号')
    if (miss.length) {
      return wx.showModal({
        title: `${miss.join('和')}是必填项`,
        content: '称呼和手机号缺一项就没法提交预约。称呼点输入框可一键填入微信昵称，手机号点「一键获取」即可授权填入，两项也都支持手工填写。手机号只会用于本次预约的通知，您不用担心。',
        showCancel: false,
        confirmText: '去填写'
      })
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' })
    const goConfirm = this.data.fillFrom === 'confirm'
    this.setData({ showFill: false }, () => { if (goConfirm) this.doConfirm() })
  },

  // 稍后再说 / 拒绝授权：明确告诉顾客可以手工填，而不是让入口消失
  // 但必须说清这是**必填项** —— 之前只说「稍后再说」会让顾客以为可以不填，结果提交时才被拦。
  closeFill() {
    const wasConfirm = this.data.fillFrom === 'confirm'
    this.setData({ showFill: false })
    wx.showToast({
      title: wasConfirm ? '称呼与手机号是必填项，可在卡片里手工填写' : '称呼与手机号是必填项，稍后确认预约时需要填写',
      icon: 'none',
      duration: 2600
    })
  },

  // ===== 从公众号小程序卡片进入（from=oa）=====
  // 公众号里 AI 已把项目/日期/场次/人数谈妥，这里直接渲染确认卡，不必重走一遍对话。
  // 卡片 pagepath 还带了 log=aiLogs._id：确认下单时随 aiLogId 回传，
  // 让公众号那轮对话也能被回写 booked=true（否则「公众号 AI → 预约成功」漏斗第三层恒为 0）。
  applyOaCard(q) {
    if (!q || q.from !== 'oa') return
    const dec = (v) => { try { return decodeURIComponent(v || '') } catch (e) { return v || '' } }
    const c = {
      projectId: dec(q.projectId),
      projectName: dec(q.projectName),
      date: dec(q.date),
      sessionId: dec(q.sessionId),
      sessionStart: dec(q.start),
      sessionEnd: dec(q.end),
      partySize: Number(q.partySize) || 1
    }
    if (!c.projectId || !c.date || !c.sessionId) return
    this.fromOa = true
    if (q.log) this._aiLogId = dec(q.log)

    const reply = `已为您查到可约时段：「${c.projectName}」${c.date} ${c.sessionStart}-${c.sessionEnd}，${c.partySize} 人位。请确认预约信息～`
    this.setData({
      messages: [
        { id: mkId(), role: 'assistant', content: '您在公众号里和小曜聊的预约已经带过来啦，确认一下就能完成～' },
        { id: mkId(), role: 'assistant', content: reply }
      ],
      intent: 'confirm',
      confirmation: c,
      profile: { name: '', phone: '' },
      oaFill: true            // 公众号来源：需在本页补填称呼 / 手机号
    })
    // 已有资料则预填（老顾客不用重填）；失败静默，不影响手动填写
    call('getMyProfile').then(d => {
      const p = d && d.profile
      if (p && (p.name || p.phone)) {
        this.setData({ profile: { name: p.name || '', phone: p.phone || '' } })
      }
    }).catch(() => {})
    // 预取通知配置（与常规 AI 确认卡一致）
    if (c.projectId) {
      call('getProject', { projectId: c.projectId }).then(d => {
        if (d && d.notifyCfg) this.setData({ notifyCfg: d.notifyCfg })
      }).catch(() => {})
    }
    this.scrollBottom()
  },

  // 公众号来源需补填称呼 / 手机号（createReservation 要求 name 必填）。
  // 只改数据模型不回写 value：避免中文输入法下光标跳动（与快捷短语同一约定）。
  onName(e) { this.data.profile.name = e.detail.value },
  onPhone(e) { this.data.profile.phone = e.detail.value },

  // 微信手机号快捷获取：用户点按钮授权后，用返回的 code 到服务端换取真实手机号。
  // 走云端 cloud.openapi.phonenumber（内部可信通道），不需要 AppSecret、不出公网。
  // 只改数据模型不回写 value，避免中文输入法光标跳动。
  onGetPhone(e) {
    const d = (e && e.detail) || {}
    if (d.errMsg !== 'getPhoneNumber:ok') {
      // 拒绝授权不能静默返回（顾客会以为按了没反应）——明确告知可手工填写
      const deny = String(d.errMsg || '').indexOf('deny') >= 0
      wx.showToast({
        title: deny ? '已跳过，请在下方手工填写手机号' : '未能获取，请手工填写手机号',
        icon: 'none',
        duration: 2500
      })
      return
    }
    if (!d.code) return wx.showToast({ title: '未能获取授权，请手工填写手机号', icon: 'none' })
    wx.showLoading({ title: '获取中' })
    call('getPhoneNumber', { code: d.code })
      .then(r => {
        if (r && r.phone) {
          this.data.profile.phone = r.phone
          this.setData({ profile: { ...this.data.profile } })
          call('saveProfile', { phone: r.phone }).catch(() => {})
          wx.showToast({ title: '已填入手机号', icon: 'success' })
        } else {
          wx.showToast({ title: '获取失败', icon: 'none' })
        }
      })
      .catch(err => wx.showToast({ title: (err && err.message) || '获取失败', icon: 'none' }))
      .finally(() => wx.hideLoading())
  },

  // 拉取后台配置：快捷短语 + 开场白；失败/未配置时静默沿用内置默认，不打断进入 AI 页
  loadConfig() {
    call('getAiConfig').then(d => {
      const list = (d && d.quickReplies) || []
      if (list.length) this.setData({ quickReplies: list.map((x, i) => ({ _i: i, label: x.label, text: x.text })) })
      // 开场白：后台有配置就记下来（ensureGreeting 每次进入都用它），
      // 并就地替换当前那条欢迎语（仅在还没开始对话时替换，避免覆盖已聊起来的内容）
      const g = d && d.greeting
      if (g) {
        this._greeting = g
        const msgs = this.data.messages || []
        const hasUser = msgs.some(m => m.role === 'user')
        if (!hasUser && msgs.length && msgs[0].role === 'assistant') {
          const next = msgs.slice()
          next[0] = { ...next[0], content: g }
          this.setData({ messages: next })
        }
      }
    }).catch(() => {})
  },

  // ===== 语音输入（WechatSI 端侧识别）=====
  initVoice() {
    if (!plugin) { this.setData({ pluginOk: false }); return }
    try {
      const m = plugin.getRecordRecognitionManager()
      m.onStart = () => { this.setData({ recording: true, liveText: '', voiceSec: 0, voiceVol: 12 }); this.startVoiceMeter() }
      m.onRecognize = (res) => {
        const t = (res && res.result) || ''
        if (t) {
          // 每次回调到更长的新文本 = 这一小段确实识别出了内容 ⇒ 把音量条顶起来（真实事件驱动）
          const delta = Math.max(1, t.length - (this._lastRecognizeLen || 0))
          this._lastRecognizeLen = t.length
          this.bumpVolume(delta)
          this.setData({ liveText: t })
        }
      }
      m.onStop = (res) => {
        const cancelled = !!(this.data.voiceCancel || this._forceCancel)
        const final = (((res && res.result) || '') || this.data.liveText || '').trim()
        this._forceCancel = false
        this.stopVoiceMeter()
        this.setData({ recording: false, liveText: '', voiceCancel: false, voiceSec: 0, voiceVol: 12 })
        if (cancelled) {
          // 上滑进入取消区 / 被系统打断（来电、手势被抢）后松手：丢弃本次语音，回到初始态
          wx.showToast({ title: '已取消发送', icon: 'none' })
          this.setData({ draft: '', voicePending: false })
          return
        }
        if (final) {
          // ⭐ 松手即发（2026-09-24）：识别结果直接发出，不再落回输入框等二次点击
          wx.showToast({ title: '已发送', icon: 'none', duration: 1200 })
          this.setData({ draft: final, voicePending: false }, () => this.send())
        } else {
          wx.showToast({ title: '没听清，请再说一次', icon: 'none' })
        }
      }
      m.onError = (res) => {
        this.stopVoiceMeter()
        this._forceCancel = false
        this.setData({ recording: false, liveText: '', voiceSec: 0, voiceVol: 12 })
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
    wx.showToast({ title: '已跳过，可手工输入', icon: 'none' })
  },

  async toggleMode() {
    if (this.data.recording) return
    const toVoice = !this.data.voiceMode
    // 切入语音态前一次性完成「隐私授权 + 麦克风权限」索取。
    // 关键修复：不要等到按住时才去弹隐私窗/申请权限——按住时弹窗会让手指松开触发 touchend，
    // 导致 onStart 永远不执行（表现即「按住说话按不下去」）。切模式在 tap 手势上下文内完成授权最稳。
    if (toVoice) {
      const agreed = await this.ensurePrivacy()
      if (!agreed) return
      const ok = await this.ensureRecordAuth()
      if (!ok) return
      // 进入语音态时清空上一次识别文本与撤销态，避免与新录音叠加
      this.setData({ voiceMode: true, liveText: '', voiceCancel: false, draft: '', voicePending: false })
    } else {
      this.setData({ voiceMode: false, liveText: '' })
    }
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

  // ===== 录音计时 + 音量反馈 =====
  // 计时：真实经过秒数（上限 60s，与插件 start({duration:60000}) 一致，到点插件会自动回调 onStop ⇒ 自动发送）。
  // 音量：WechatSI 的 getRecordRecognitionManager **不提供实时分贝回调**（只有识别文本），
  //   所以这里用「本次回调新增了多少字」驱动音量条 —— 数据来自真实识别事件，不是随机数；
  //   识别不说话时没有回调 ⇒ 音量条自然回落到底，等价于微信的音量波纹静态态。
  startVoiceMeter() {
    this._lastRecognizeLen = 0
    this._voiceStartAt = Date.now()
    this.stopVoiceMeter()
    this._vSec = setInterval(() => {
      const sec = Math.min(60, Math.round((Date.now() - (this._voiceStartAt || Date.now())) / 1000))
      if (sec !== this.data.voiceSec) this.setData({ voiceSec: sec })
    }, 1000)
    this._vVol = setInterval(() => {
      const cur = this.data.voiceVol || 0
      if (cur > 12) this.setData({ voiceVol: Math.max(12, cur - 14) })
    }, 220)
  },

  stopVoiceMeter() {
    if (this._vSec) { clearInterval(this._vSec); this._vSec = null }
    if (this._vVol) { clearInterval(this._vVol); this._vVol = null }
  },

  bumpVolume(delta) {
    const d = Math.min(3, Math.max(1, Number(delta) || 1))
    this.setData({ voiceVol: Math.max(20, Math.min(100, (this.data.voiceVol || 0) + 26 * d)) })
  },

  // ===== 按住说话：touchstart / touchmove / touchend / touchcancel 完整链路 =====
  onVoiceStart(e) {
    if (this.data.recording) return
    // 记录手指起始 Y，供 onVoiceMove 判断「上滑取消」
    if (e && e.touches && e.touches[0]) this._voiceStartY = e.touches[0].clientY
    this._forceCancel = false
    // 授权已在 toggleMode（切到语音模式时）一次性完成，这里直接 start。
    // 防御：若切模式后插件 manager 意外丢失，尝试重建，避免「按不下去」却无任何提示。
    if (!this._rec) {
      try { this.initVoice() } catch (e) {}
    }
    if (!this._rec) {
      wx.showToast({ title: '语音组件未就绪，请改用文字输入', icon: 'none' })
      return
    }
    try {
      this.setData({ voiceCancel: false, voicePending: false })
      this._rec.start({ lang: 'zh_CN', duration: 60000 })
    } catch (e) {
      const m = String((e && e.errMsg) || (e && e.msg) || '')
      if (m.indexOf('privacy') >= 0 || m.indexOf('ban') >= 0) {
        wx.showModal({
          title: '录音接口被禁用',
          content: '多为 mp 后台《用户隐私保护指引》未声明「访问你的麦克风」或提审时勾选「未采集隐私」所致。请到 mp 后台补充声明并发布后重试。',
          showCancel: false
        })
      } else {
        wx.showToast({ title: '无法开始录音，请重试', icon: 'none' })
      }
    }
  },

  // 录音中手指上滑：超过阈值（60px）即进入「取消区」，松开放弃本次语音（微信语音输入同款）
  onVoiceMove(e) {
    if (!this.data.recording) return
    const ty = e.touches && e.touches[0] && e.touches[0].clientY
    if (typeof ty !== 'number') return
    const cancel = (this._voiceStartY - ty) > VOICE_CANCEL_PX
    if (cancel !== this.data.voiceCancel) this.setData({ voiceCancel: cancel })
  },

  // touchcancel：手指被系统打断（来电、下拉通知、手势被父级抢走等）。
  // 这类事件不会再有 touchend ⇒ 必须自己收尾，否则会卡在「录音中」状态。
  onVoiceCancelTouch() {
    if (!this.data.recording) return
    this._forceCancel = true
    this.onVoiceEnd()
  },

  onVoiceEnd() {
    if (!this.data.recording || !this._rec) return
    // 明确的状态判定在 onStop（拿到识别结果之后）里给出；这里只负责收「是否已踏进取消区」
    try { this._rec.stop() } catch (e) {
      this.stopVoiceMeter()
      this._forceCancel = false
      this.setData({ recording: false, liveText: '', voiceCancel: false, voiceSec: 0, voiceVol: 12 })
    }
  },

  // 撤销本次语音识别结果（清空已落回输入框的文本，可重新按住说话）
  undoVoice() {
    this.setData({ draft: '', voicePending: false })
  },

  onUnload() {
    this.stopVoiceMeter()
    this.onVoiceEnd()
  },

  onDraft(e) { this.setData({ draft: e.detail.value }) },

  scrollBottom() {
    const len = this.data.messages.length
    if (len) this.setData({ scrollTo: 'm' + this.data.messages[len - 1].id })
  },

  async send() {
    const text = (this.data.draft || '').trim()
    if (!text || this.data.sending) return
    this._lastActiveAt = Date.now()   // 有交互就刷新「进入」计时，避免聊到一半被开场白打断
    const userMsg = { id: mkId(), role: 'user', content: text }
    const msgs = this.data.messages.concat(userMsg)
    this.setData({ messages: msgs, draft: '', sending: true, voicePending: false })
    this.scrollBottom()
    try {
      const res = await call('aiReserve', {
        messages: msgs.map(m => ({ role: m.role, content: m.content })),
        projectId: this.projectId,
        nickname: this.data.profile.name
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
    // 记住本轮 AI 对话的日志 id：用户若点了「确认预约」，createReservation 会据此把该轮标记为「预约成功」
    if (res.logId) this._aiLogId = res.logId
    if (res.intent === 'confirm') {
      const assistantMsg = { id: mkId(), role: 'assistant', content: res.reply }
      this.setData({
        messages: this.data.messages.concat(assistantMsg),
        intent: 'confirm',
        confirmation: res.confirmation,
        profile: res.profile || { name: '', phone: '' }
      })
      // 预取项目通知配置，供「确认预约」时同步计算授权模板（异步，不阻塞对话）
      if (res.confirmation && res.confirmation.projectId) {
        call('getProject', { projectId: res.confirmation.projectId }).then(d => {
          if (d && d.notifyCfg) this.setData({ notifyCfg: d.notifyCfg })
        }).catch(() => {})
      }
      this.scrollBottom()
      return
    }
  const reply = res.reply || (res.intent === 'ask' ? '请补充一下信息～' : '好的～')
  const adds = []
  if (res.notice) adds.push({ id: mkId(), role: 'assistant', content: res.notice, notice: true })
  adds.push({ id: mkId(), role: 'assistant', content: reply })
  this.setData({
    messages: this.data.messages.concat(adds),
    intent: ''
  })
  this.scrollBottom()
},

  cancelConfirm() {
    this.setData({ intent: '', confirmation: null })
    this.setData({ messages: this.data.messages.concat([{ id: mkId(), role: 'assistant', content: '好的，已取消本次确认。您还想约什么？' }]) })
    this.scrollBottom()
  },

  // 点「确认预约」：资料缺失时**再弹一次获取层**，而不是只弹个 toast 把人拦住。
  // 场景：卡片已经推过来了、顾客只差资料就能下单 —— 此时给一个能一键获取的入口，
  // 比让他自己去找输入框有效得多；拒绝授权则明确告知可手工填写（closeFill）。
  confirm() {
    const c = this.data.confirmation
    if (!c) return
    const miss = missingProfile(this.data.profile)
    if (miss.length) {
      this.setData({
        showFill: true,
        fillFrom: 'confirm',
        fillTip: `还差${miss.join('和')}——这两项是预约的必填项（手机号只用于本次预约的通知），填好就能确认预约～`
      })
      return
    }
    this.doConfirm()
  },

  async doConfirm() {
    const c = this.data.confirmation
    if (!c) return
    // ⭐ 资料兜底（可能是 saveFill 直接接过来的）：称呼与手机号**都必填**。
    //   缺失时不能只 toast 一闪而过 —— 重新弹回补全层并说明原因，顾客才有路径继续。
    const miss = missingProfile(this.data.profile)
    if (miss.length) {
      this.setData({
        showFill: true,
        fillFrom: 'confirm',
        fillTip: `${miss.join('和')}还没填，这是预约的必填项，补上就能立即提交～`
      })
      return
    }
    const name = (this.data.profile.name || '').trim()
    const phone = (this.data.profile.phone || '').trim()
    if (!/^1[3-9]\d{9}$/.test(phone)) { wx.showToast({ title: '请填写正确的手机号', icon: 'none' }); return }
    wx.showLoading({ title: '提交中' })
    // 1) 同步拉起微信订阅弹窗（必须在 tap 手势上下文内调用，不能放在任何 await 之后，否则微信不弹窗）
    const plan = notifyPlanOf({ date: c.date, sessionStart: c.sessionStart, sessionEnd: c.sessionEnd }, this.data.notifyCfg)
    const ids = tmplIdsOfPlan(plan, null)
    const subs = { ...this.data.subs }
    if (ids.length) {
      try {
        const r = await requestSubscribe(ids)
        // 回写授权结果（与常规预约 confirm 页一致）：接受→true / 拒绝→false，仅限本次申请的模板
        const keyOf = id => { const s = CUSTOMER_SUBS.find(x => x.tmplId === id); return s ? s.key : null }
        ;(r.accepted || []).forEach(id => { const k = keyOf(id); if (k) subs[k] = true })
        ;(r.rejected || []).forEach(id => { const k = keyOf(id); if (k) subs[k] = false })
        this.setData({ subs })
        if (!(r.accepted && r.accepted.length)) {
          // 用户未在弹窗里授权 → 后续走短信兜底（与常规预约一致，给出明确提示）
          wx.showToast({ title: '未开启微信通知，将改用短信通知', icon: 'none', duration: 2200 })
        }
      } catch (e) { /* 订阅失败不阻断 */ }
    }
    // 2) 提交预约（携带订阅快照，云端按二选一规则发通知）
    try {
      // source：'ai' = 小程序端 AI；'oa' = 公众号 AI 导回（卡片 pagepath 带 from=oa）
      // aiLogId 用于闭环回写「预约成功」——尤其是 oa 场景，公众号那轮对话的 openid 与这里不同，
      // 只能靠卡片透传过来的 log id 精确回写，否则漏斗第三层恒为 0。
      const payload = {
        projectId: c.projectId, date: c.date, sessionId: c.sessionId, name, partySize: c.partySize,
        source: this.fromOa ? 'oa' : 'ai', aiLogId: this._aiLogId || ''
      }
      if (phone) payload.phone = phone
      const r = await call('createReservation', { ...payload, subscribed: subs })
      wx.hideLoading()
      const needReview = r && r.review === 'pending'
      this.setData({
        intent: '',
        success: true,
        successInfo: { projectName: c.projectName, date: c.date, sessionStart: c.sessionStart, sessionEnd: c.sessionEnd, partySize: c.partySize, needReview }
      })
      // 持久化顾客资料：下次预约自动带出（失败不阻断主流程，与常规确认页一致）
      const prof = { name }
      if (phone) prof.phone = phone
      call('saveProfile', prof).catch(() => {})
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: e.message || '预约失败', icon: 'none' })
    }
  },

  goMine() { wx.switchTab({ url: '/pages/mine/mine' }) },
  closeSuccess() { wx.reLaunch({ url: '/pages/index/index' }) },
  goBooking() {
    const pid = this.projectId || ''
    // AI 不可用降级时：有项目上下文则跳对应项目预约页；无 projectId（从首页进入）直接回首页，
    // 避免 navigateTo 到 booking 缺 projectId 报「没有项目 id」的错误。
    if (pid) {
      wx.navigateTo({ url: '/pages/booking/booking?projectId=' + pid })
    } else {
      wx.reLaunch({ url: '/pages/index/index' })
    }
  }
})
