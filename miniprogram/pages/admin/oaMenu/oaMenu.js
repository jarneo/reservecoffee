const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

const DEF_APP = 'wxb97578ed89c6e2c7'
// 「二曜路8号咖啡与清酒」微商城（= utils/jump.js 的 TARGET_APPID）。
// ⚠️ 菜单项跳小程序只认 appid + pagepath 两者**必须同属一个小程序**：
//    yb_wm/index/index 是微商城的页面，填 DEF_APP 会导致微信发布返 40066 invalid url。
const WM_APP = 'wx00914125678e1ad3'
const MAX_TOP = 3
const MAX_SUB = 5

const TYPE_LIST = [
  { v: 'miniprogram', t: '跳转小程序', fields: ['appid', 'pagepath', 'url'] },
  { v: 'view', t: '跳转网页', fields: ['url'] },
  { v: 'click', t: '发送文本', fields: ['key', 'replyText'] },
  { v: 'scancode_waitmsg', t: '扫码', fields: ['key'] },
  { v: 'pic_photo_or_album', t: '拍照或相册', fields: ['key'] },
  { v: 'media_id', t: '发送图片图文', fields: ['media_id'] },
  { v: 'location_select', t: '地理位置', fields: ['key'] }
]

const DEFAULT_MENU = {
  button: [
    {
      name: '预约到店', sub_button: [
        { type: 'miniprogram', name: '法兰绒预约', appid: DEF_APP, pagepath: 'pages/booking/booking?projectId=d5e30a9b6a7f39e5017968b11c813702', url: 'https://mp.weixin.qq.com' },
        { type: 'miniprogram', name: '清酒预约', appid: DEF_APP, pagepath: 'pages/booking/booking?projectId=d5e30a9b6a7f39e5017968b233a0dea9', url: 'https://mp.weixin.qq.com' },
        { type: 'miniprogram', name: 'AI 智能预约', appid: DEF_APP, pagepath: 'pages/ai/ai', url: 'https://mp.weixin.qq.com' }
      ]
    },
    // ⚠️ 一级菜单名 ≤4 字（微信硬限制）。原「联系/关于」为 5 字，永远发布不出去 ⇒ 改为「联系我们」。
    // 「买豆买酒」指向**微商城**（另一小程序）：appid 必须是 WM_APP，与 pagepath 同属微商城。
    // 前置条件：目标小程序须已在公众号后台「小程序管理」关联过，否则发布报 40066。
    { type: 'miniprogram', name: '买豆买酒', appid: WM_APP, pagepath: 'yb_wm/index/index', url: 'https://mp.weixin.qq.com' },
    { type: 'click', name: '联系我们', key: 'contact', replyText: '你可以直接发消息给我。ai 小曜目前接管中，有问题可以直接跟我说。\n如果解决不了，可以直接电话（微信同号）：19292757851' }
  ]
}

function lenOf(s) { return [...(s || '')].length }
function typeT(v) { const t = TYPE_LIST.find(x => x.v === v); return t ? t.t : v }

// ── 一级菜单拖动排序 ───────────────────────────────────────────────
// 小程序没有 DOM，拖拽统一用 movable-view（原生支持拖动 + 边界约束，无需自己算手势）。
// ⚠️ 两个必踩的坑：
//   1) movable-view 的 y 单位是 **px**（不是 rpx），必须按 windowWidth/750 换算，否则拖不动或落点算错。
//   2) movable-view 默认尺寸是 10px×10px，宽高必须在样式里显式给死（见 oaMenu.wxss 的 .sort-item）。
const SORT_ROW_RPX = 88
const SORT_ROW_PX = (function () {
  let w = 375
  try {
    const info = (typeof wx.getWindowInfo === 'function') ? wx.getWindowInfo() : wx.getSystemInfoSync()
    if (info && info.windowWidth) w = info.windowWidth
  } catch (e) { /* 取不到就按 iPhone 6 基准 375 算 */ }
  return SORT_ROW_RPX * (w / 750)
})()

function fieldMeta(k, it, type) {
  const base = { key: k, value: it[k] || '', multiline: false, note: '' }
  if (k === 'appid') return Object.assign({}, base, { label: '小程序 AppID', placeholder: DEF_APP, note: '须是已在公众号后台「小程序管理」关联过的小程序；菜单不支持填短链（#小程序://…）' })
  if (k === 'pagepath') return Object.assign({}, base, { label: '页面路径 pagepath', placeholder: 'pages/booking/booking?projectId=...', note: '须为已发布小程序的页面，可带 ? 参数直接落到项目' })
  if (k === 'url') return Object.assign({}, base, { label: type === 'miniprogram' ? '备用网页 url（旧客户端兜底）' : '跳转链接 url', placeholder: 'https://...', note: type === 'miniprogram' ? '旧客户端点菜单的兜底链接，填合法 https 即可' : '须在公众号业务域名下，否则点击报错' })
  if (k === 'key') return Object.assign({}, base, { label: '事件 key', placeholder: '如 contact' })
  if (k === 'replyText') return Object.assign({}, base, { label: '回复文本（mpChat 按 key 下发）', multiline: true, note: 'click 事件由 mpChatHttp 被动回复按 key 路由' })
  if (k === 'media_id') return Object.assign({}, base, { label: '素材 media_id', placeholder: '公众号素材库获取', note: '需先在公众号后台素材管理上传图片/图文' })
  return base
}

function cleanItem(it) {
  const o = { name: it.name, type: it.type }
  if (it.type === 'miniprogram') { o.appid = it.appid; o.pagepath = it.pagepath; if (it.url) o.url = it.url }
  else if (it.type === 'view') { o.url = it.url }
  else if (it.type === 'click') { o.key = it.key }
  else if (it.type === 'media_id') { o.media_id = it.media_id }
  else { o.key = it.key }
  return o
}

// 收集 click 类型的 key → 回复文本，供 mpChatHttp 被动回复按 EventKey 路由。
// ⚠️ replyText 不进 menu/create 报文（微信不认，有 40035 风险），故单独存 config.oaMenu.clickReplies。
function collectReplies(menu) {
  const out = {}
  ;(menu.button || []).forEach(b => {
    const items = (b.sub_button && b.sub_button.length) ? b.sub_button : [b]
    items.forEach(it => {
      if (it && it.type === 'click' && it.key && it.replyText) out[it.key] = it.replyText
    })
  })
  return out
}

// 反向：把持久化的 clickReplies 回填成菜单项的 replyText，使编辑器再次打开时能带出文案
function applyReplies(menu, replies) {
  if (!replies) return menu
  ;(menu.button || []).forEach(b => {
    const items = (b.sub_button && b.sub_button.length) ? b.sub_button : [b]
    items.forEach(it => {
      if (it && it.type === 'click' && it.key && replies[it.key]) it.replyText = replies[it.key]
    })
  })
  return menu
}

// 缓存 token 状态提示（IP 白名单只拦「换 token」，所以「有没有缓存 token」决定能否直接发布）
function tokenHintOf(ti) {
  if (!ti) return ''
  if (ti.has) return '缓存 token 有效（约剩 ' + ti.remainMin + ' 分钟），可直接发布。'
  if (ti.remainMin > 0) return '缓存 token 仅剩 ' + ti.remainMin + ' 分钟（不足 5 分钟会被判定过期），建议重新粘贴。'
  return '暂无可用 token：请在本机（IP 已加白名单）取一个 access_token 粘到下方，或直接用下方「复制报文」去官方调试工具发布。'
}

const OA_APPID_TEXT = 'wx4d8d957ee8af6073'

// 上次发布结果 → 一行人话（WXML 不能调函数，必须先在 JS 里算好）
// 线上菜单（微信侧**实际生效**的，menu/get 读出来）：与草稿对照，可立刻判断发布有没有真的落地。
// 微信客户端自身有菜单缓存（最长 24h / 重新关注才刷新），所以「发布成功但手机上没变」多半是缓存，看这里为准。
function liveTextOf(live) {
  const m = live && (live.menu && live.menu.button ? live.menu : live)
  const bs = m && Array.isArray(m.button) ? m.button : null
  if (!bs) return '读不到线上菜单（无法确认微信侧是否已生效）'
  if (!bs.length) return '线上暂无菜单'
  return bs.map(b => {
    const subs = b.sub_button || []
    return b.name + (subs.length ? '（' + subs.map(s => s.name).join('/') + '）' : '')
  }).join(' · ')
}
function lastTextOf(lp) {
  if (!lp || !lp.ts) return ''
  const d = new Date(lp.ts)
  const when = (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  const viaTxt = lp.via === 'cloud' ? '云调用' : (lp.via === 'https' ? 'HTTPS 直调' : '两条路都失败')
  if (lp.via && lp.via !== 'none' && !lp.errcode) return when + ' ✅ 发布成功（' + viaTxt + '）'
  const bits = [when + ' ❌ 未生效（' + viaTxt + '）']
  if (lp.errcode) bits.push('错误码 ' + lp.errcode + '：' + (lp.errmsg || ''))
  if (lp.hint) bits.push(lp.hint)
  const e = lp.errs || {}
  if (e.cloud) bits.push('云调用：' + e.cloud)
  if (e.https) bits.push('直调：' + e.https)
  return bits.join('｜')
}

// 发布通路诊断（只依据布尔/枚举，不含任何密钥）
function envWarnOf(env) {
  if (!env) return ''
  // 云调用可用 = 免鉴权正路：不需要 access_token，也就没有 IP 白名单问题
  if (env.liveVia === 'cloud') return ''
  const bits = []
  bits.push('云调用未生效：需先在「微信开发者工具 → 云开发 → 更多 → 环境共享」把本环境共享给公众号 ' +
    OA_APPID_TEXT + '（需同主体）。配好后免鉴权、无需 access_token、不受 IP 白名单限制。')
  if (!env.hasMpAppId || !env.hasMpSecret) {
    bits.push('未配置 MP_APP_ID / MP_APP_SECRET，HTTPS 直调不可用（云函数出口 IP 实测 8 轮 8 个不同 IP，加白名单不可行）。可先用下方「粘贴 access_token」或「复制报文」。')
  }
  return bits.join('')
}

Page({
  behaviors: [guard],
  data: {
    menu: { button: [] },
    sel: { top: 0, sub: -1 },
    openPop: -1,
    editor: { mode: 'empty' },
    publishMsg: '',
    lastPublish: null,
    lastText: '',
    liveText: '',
    envWarn: '',
    // 手动 access_token（IP 白名单只拦「换 token」这一步，本机取到后粘进来即可发布）
    tokenInput: '',
    tokenInfo: null,
    tokenHint: '',
    // 发布报文（menu/create 的 body），失败时可直接复制去官方接口调试工具发布
    payloadJson: '',
    // 一级菜单拖动排序（movable-view 列表）
    sortRows: [],
    sortAreaH: 0,
    sortDrag: -1,     // 正在拖动第几行；-1 = 没在拖
    sortTarget: -1,   // 松手会落到第几行（拖动中实时高亮）
    sortTip: '',
    // ⚠️ WXML 只能读 data：MAX_TOP / MAX_SUB 是模块常量，必须挂到 data 上模板才渲染得出来
    MAX_TOP,
    MAX_SUB
  },
  onLoad() {
    this.guard(['owner']).then(role => {
      if (!role) return
      call('getOaMenu').then(d => {
        const draft = (d && d.draft) || {}
        // ⚠️ 这里曾经写的是裸变量 `menu`（从未声明）→ ReferenceError → 被下面 .catch 吃掉
        //    → 每次进页面都退回 DEFAULT_MENU（旧文案）→ 改了发布生效、再进来又被旧值覆盖（实证 9/29）。
        //    正确做法：以服务端最新草稿为准，取不到再看线上，最后才用默认模板。
        const src = (draft.menu && draft.menu.button && draft.menu.button.length)
          ? draft.menu
          : (d && d.live && d.live.menu && d.live.menu.button ? d.live.menu : null)
        const base = src || DEFAULT_MENU
        const menu = JSON.parse(JSON.stringify(base))   // 深拷贝：applyReplies 会改写对象，别污染常量
        applyReplies(menu, draft.clickReplies || {})
        const ti = (d && d.tokenInfo) || { has: false, remainMin: 0 }
        this.setData({
          menu,
          lastPublish: (d && d.draft && d.draft.lastPublish) || null,
          lastText: lastTextOf(d && d.draft && d.draft.lastPublish),
          liveText: liveTextOf(d && d.live),
          envWarn: envWarnOf(d && d.env),
          tokenInfo: ti,
          tokenHint: tokenHintOf(ti)
        }, () => this.syncEditor())
      }).catch(e => {
        console.warn('[oaMenu] 读取菜单失败，回落默认模板：', e && e.message)
        const menu = JSON.parse(JSON.stringify(DEFAULT_MENU))
        this.setData({ menu }, () => this.syncEditor())
      })
    })
  },
  // 由 menu.button 生成「可拖动排序」列表：每行带静止位置 y（px）。
  // k 必须每行唯一且随「行」走，拖动重排后 movable-view 才会跟着内容平滑换位。
  sortPatch() {
    const rows = (this.data.menu.button || []).map((b, i) => {
      const subs = (b.sub_button || []).map(s => s.name).filter(Boolean)
      return {
        k: 'r' + i + '_' + Math.random().toString(36).slice(2, 8),
        id: i + 1,
        name: b.name || '未命名',
        subText: subs.length ? (subs.join(' / ')) : typeT(b.type),
        y: Math.round(i * SORT_ROW_PX)
      }
    })
    return { sortRows: rows, sortAreaH: rows.length * SORT_ROW_RPX }
  },
  syncEditor() {
    const { menu, sel } = this.data
    const sp = this.sortPatch()
    const b = menu.button[sel.top]
    if (!b) { this.setData(Object.assign({ editor: { mode: 'empty' } }, sp)); return }
    const isParent = !!(b.sub_button && b.sub_button.length)
    if (sel.sub < 0 && isParent) {
      const subs = b.sub_button.map((s, idx) => ({ name: s.name, typeT: typeT(s.type), index: idx }))
      this.setData(Object.assign({
        editor: {
          mode: 'parent', title: '一级菜单（分组）：' + b.name, name: b.name, nameLimit: 4,
          nameCount: lenOf(b.name), nameBad: lenOf(b.name) > 4,
          subList: subs, subCount: subs.length, canAddSub: subs.length < MAX_SUB
        }
      }, sp))
    } else {
      const it = sel.sub < 0 ? b : b.sub_button[sel.sub]
      const type = it.type || 'miniprogram'
      const tObj = TYPE_LIST.find(x => x.v === type) || TYPE_LIST[0]
      const fields = tObj.fields.map(k => fieldMeta(k, it, type))
      const title = sel.sub < 0 ? ('一级菜单：' + it.name) : ('子菜单：' + it.name)
      this.setData(Object.assign({
        editor: {
          mode: 'leaf', title, name: it.name, nameLimit: sel.sub < 0 ? 4 : 8,
          nameCount: lenOf(it.name), nameBad: lenOf(it.name) > (sel.sub < 0 ? 4 : 8),
          type, typeOptions: TYPE_LIST.map(x => ({ v: x.v, t: x.t })),
          typeIndex: TYPE_LIST.findIndex(x => x.v === type),
          fields, canAddSub: false
        }
      }, sp))
    }
  },

  // ── 拖动排序：touchstart 记行 → change 算落点 → touchend 落位 ───────
  // ⚠️ 拖动过程中**绝不把 y 回写进 data**：movable-view 会跟手势打架导致抖动。
  //    实时位置只记在实例变量 _sortY 上，落点全靠它换算；换位后由 sortPatch 统一回正。
  onSortStart(e) {
    const i = Number(e.currentTarget.dataset.i)
    this._sortIdx = Number.isFinite(i) ? i : -1
    this._sortY = null
  },
  onSortMove(e) {
    const i = this._sortIdx
    if (!Number.isFinite(i) || i < 0) return
    // 程序 setData 也会触发 change，靠 _sortIdx 判定「这次拖动是不是我们发起的」
    const y = (e && e.detail && typeof e.detail.y === 'number') ? e.detail.y : 0
    this._sortY = y
    const n = this.data.sortRows.length
    let to = Math.round(y / SORT_ROW_PX)
    to = Math.max(0, Math.min(n - 1, to))
    const patch = {}
    if (this.data.sortDrag !== i) patch.sortDrag = i
    if (to !== this.data.sortTarget) {
      patch.sortTarget = to
      patch.sortTip = '松手后置于第 ' + (to + 1) + ' 位'
    }
    if (patch.sortDrag !== undefined || patch.sortTarget !== undefined) this.setData(patch)
  },
  onSortEnd() {
    const i = this._sortIdx
    this._sortIdx = -1
    if (!Number.isFinite(i) || i < 0) return
    const n = this.data.sortRows.length
    const row = this.data.sortRows[i]
    let y = (typeof this._sortY === 'number') ? this._sortY : ((row && row.y) || 0)
    let to = Math.round(y / SORT_ROW_PX)
    to = Math.max(0, Math.min(n - 1, to))
    this._sortY = null
    this.setData({ sortDrag: -1, sortTarget: -1, sortTip: '' })
    if (to !== i) this.moveSort(i, to)
    else this.setData(this.sortPatch())    // 没换位也回正一次，避免停在半路
  },
  // 点一下排序行 = 选中它去编辑（拖动过就不会触发 tap，二者不冲突）
  onSortTap(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (!Number.isFinite(i) || !this.data.menu.button[i]) return
    this.setData({ sel: { top: i, sub: -1 }, openPop: -1 }, () => this.syncEditor())
  },
  // ↑/↓ 兜底：真机上万一拖拽不灵（不同基础库对 movable-view 的表现有差异），也能调顺序
  onMoveStep(e) {
    const d = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const i = Number(d.i)
    const to = i + Number(d.d)
    if (!Number.isFinite(i) || !Number.isFinite(to)) return
    if (to < 0 || to >= this.data.menu.button.length) return
    this.moveSort(i, to)
  },
  // 真正的重排：splice 一份深拷贝，并把 sel 一起挪，避免排序后编辑器跳到别的菜单
  moveSort(from, to) {
    const bs = JSON.parse(JSON.stringify(this.data.menu.button))
    const it = bs.splice(from, 1)[0]
    bs.splice(to, 0, it)
    let top = this.data.sel.top
    if (top === from) top = to
    else if (from < top && to >= top) top--
    else if (from > top && to <= top) top++
    this.setData({ menu: { button: bs }, sel: { top, sub: -1 }, openPop: -1 }, () => {
      this.syncEditor()
      wx.showToast({ title: '顺序已调整', icon: 'none' })
    })
  },
  onTapTop(e) {
    const i = Number(e.currentTarget.dataset.i)
    const openPop = (this.data.menu.button[i].sub_button && this.data.menu.button[i].sub_button.length)
      ? (this.data.openPop === i ? -1 : i) : -1
    this.setData({ sel: { top: i, sub: -1 }, openPop }, () => this.syncEditor())
  },
  onTapSub(e) {
    const d = (e && e.currentTarget && e.currentTarget.dataset) || {}
    // ⚠️ 父级编辑器里的子菜单列表只带 data-j（i 就是当前 sel.top），
    //    这里必须兜底，否则 i=NaN → menu.button[NaN] 不存在 → 编辑器退回 empty，点了没反应。
    const i = (d.i !== undefined && d.i !== null && d.i !== '') ? Number(d.i) : this.data.sel.top
    const j = Number(d.j)
    if (!Number.isFinite(i) || !Number.isFinite(j)) return
    this.setData({ sel: { top: i, sub: j }, openPop: -1 }, () => this.syncEditor())
  },
  // ⚠️ bindinput 传进来的是**事件对象**，必须取 e.detail.value。
  //    曾误把事件对象直接当值：lenOf(事件对象) 会抛 TypeError（对象不可展开），
  //    导致 setData 根本没执行 → 编辑不生效 → 发布时仍按旧名校验并报「超过 4 个字」。
  onName(e) {
    const v = (e && e.detail ? e.detail.value : e) || ''
    const { sel } = this.data
    const path = sel.sub < 0 ? `menu.button[${sel.top}].name` : `menu.button[${sel.top}].sub_button[${sel.sub}].name`
    const lim = sel.sub < 0 ? 4 : 8
    this.setData({ [path]: v, 'editor.name': v, 'editor.nameCount': lenOf(v), 'editor.nameBad': lenOf(v) > lim })
  },
  onType(e) {
    const idx = Number(e.detail.value)
    const v = TYPE_LIST[idx].v
    const { sel } = this.data
    const base = sel.sub < 0 ? `menu.button[${sel.top}]` : `menu.button[${sel.top}].sub_button[${sel.sub}]`
    const patch = { [`${base}.type`]: v }
    if (v === 'miniprogram') {
      patch[`${base}.appid`] = DEF_APP
      patch[`${base}.url`] = 'https://mp.weixin.qq.com'
    }
    this.setData(patch, () => this.syncEditor())
  },
  onField(e) {
    const k = e.currentTarget.dataset.k
    const v = e.detail.value
    const { sel } = this.data
    const path = sel.sub < 0 ? `menu.button[${sel.top}].${k}` : `menu.button[${sel.top}].sub_button[${sel.sub}].${k}`
    this.setData({ [path]: v })
  },
  onAddTop() {
    if (this.data.menu.button.length >= MAX_TOP) return
    const nb = this.data.menu.button.concat([{ type: 'miniprogram', name: '新建菜单', appid: DEF_APP, pagepath: '', url: 'https://mp.weixin.qq.com' }])
    this.setData({ menu: { button: nb }, sel: { top: nb.length - 1, sub: -1 }, openPop: -1 }, () => this.syncEditor())
  },
  onAddSub() {
    const { menu, sel } = this.data
    const b = menu.button[sel.top]
    const isParent = !!(b.sub_button && b.sub_button.length)
    if (isParent && b.sub_button.length >= MAX_SUB) return
    const nb = JSON.parse(JSON.stringify(menu.button))
    const p = nb[sel.top]
    if (!isParent) {
      const leaf = { name: p.name, type: p.type }
      ;['appid', 'pagepath', 'url', 'key', 'replyText', 'media_id'].forEach(k => { if (p[k] !== undefined) leaf[k] = p[k] })
      p.sub_button = [leaf]
      delete p.type; delete p.appid; delete p.pagepath; delete p.url; delete p.key; delete p.replyText; delete p.media_id
    }
    p.sub_button.push({ type: 'miniprogram', name: '子菜单', appid: DEF_APP, pagepath: '', url: 'https://mp.weixin.qq.com' })
    this.setData({ menu: { button: nb }, sel: { top: sel.top, sub: p.sub_button.length - 1 }, openPop: -1 }, () => this.syncEditor())
  },
  onDelSub(e) {
    const j = Number(e.currentTarget.dataset.j)
    const { menu, sel } = this.data
    const nb = JSON.parse(JSON.stringify(menu.button))
    const p = nb[sel.top]
    p.sub_button.splice(j, 1)
    if (!p.sub_button.length) { delete p.sub_button; p.type = 'miniprogram'; p.appid = DEF_APP; p.pagepath = ''; p.url = 'https://mp.weixin.qq.com' }
    const newSub = (p.sub_button && p.sub_button.length) ? Math.min(j, p.sub_button.length - 1) : -1
    this.setData({ menu: { button: nb }, sel: { top: sel.top, sub: newSub }, openPop: -1 }, () => this.syncEditor())
  },
  onDelItem() {
    const { menu, sel } = this.data
    if (sel.sub < 0) {
      if (menu.button.length <= 1) { wx.showToast({ title: '至少保留一个一级菜单', icon: 'none' }); return }
      const nb = menu.button.concat(); nb.splice(sel.top, 1)
      const newTop = Math.max(0, sel.top - 1)
      this.setData({ menu: { button: nb }, sel: { top: newTop, sub: -1 }, openPop: -1 }, () => this.syncEditor())
    } else {
      this.onDelSub({ currentTarget: { dataset: { j: sel.sub } } })
    }
  },
  validate() {
    const bs = this.data.menu.button
    if (bs.length < 1 || bs.length > MAX_TOP) return '一级菜单数量须为 1-' + MAX_TOP
    for (const b of bs) {
      if (!b.name || !b.name.trim()) return '存在未命名的一级菜单'
      // 仅按**实际输入的名称**校验，且提示里说明实际字数与上限
      if (lenOf(b.name) > 4) return '一级菜单「' + b.name + '」共 ' + lenOf(b.name) + ' 字，超过 4 字上限（微信限制：一级菜单名最多 4 个字）'
      if (b.sub_button && b.sub_button.length) {
        if (b.sub_button.length > MAX_SUB) return '子菜单最多 ' + MAX_SUB + ' 个'
        for (const s of b.sub_button) {
          if (!s.name || !s.name.trim()) return '存在未命名子菜单'
          if (lenOf(s.name) > 8) return '子菜单「' + s.name + '」共 ' + lenOf(s.name) + ' 字，超过 8 字上限（微信限制：子菜单名最多 8 个字）'
          if (!s.type) return '子菜单「' + s.name + '」未选类型'
        }
      } else if (!b.type) return '一级菜单「' + b.name + '」未选类型'
    }
    return null
  },
  buildPayload() {
    const out = { button: [] }
    this.data.menu.button.forEach(b => {
      if (b.sub_button && b.sub_button.length) {
        out.button.push({ name: b.name, sub_button: b.sub_button.map(s => cleanItem(s)) })
      } else out.button.push(cleanItem(b))
    })
    return out
  },
  onTokenInput(e) {
    this.setData({ tokenInput: e.detail.value })
  },
  // 复制 menu/create 报文：粘贴到 mp.weixin.qq.com/debug（官方接口调试工具）即可发布，
  // 官方工具从微信侧发起，不受服务号 IP 白名单限制 ⇒ 云函数出口 IP 漂移时的兜底通路。
  onCopyPayload() {
    const j = this.data.payloadJson
    if (!j) { wx.showToast({ title: '请先点一次发布以生成报文', icon: 'none' }); return }
    wx.setClipboardData({ data: j, success: () => wx.showToast({ title: '报文已复制', icon: 'success' }) })
  },
  // 发布后回读一次库里的真实结果（含 errcode / 提示），避免前端只凭返回码判断
  refreshLast() {
    call('getOaMenu').then(d => {
      const lp = (d && d.draft && d.draft.lastPublish) || null
      this.setData({ lastPublish: lp, lastText: lastTextOf(lp), liveText: liveTextOf(d && d.live) })
    }).catch(() => {})
  },
  publish() {
    const err = this.validate()
    if (err) { this.setData({ publishMsg: err }); wx.showToast({ title: err, icon: 'none' }); return }
    const payload = this.buildPayload()
    const clickReplies = collectReplies(this.data.menu)
    const accessToken = String(this.data.tokenInput || '').trim()
    // 无论成败都把报文留在页面上：失败时可直接复制去官方接口调试工具手动发布
    this.setData({ payloadJson: JSON.stringify(payload, null, 2) })
    wx.showLoading({ title: '发布中' })
    call('setOaMenu', { menu: payload, clickReplies, accessToken }).then(d => {
      wx.hideLoading()
      // ⚠️ call() 已经把外层信封剥掉了：resolve 的是 result.data（={ errcode, via }），**没有 code 字段**。
      //    原来写 d.code === 0 恒为 false ⇒ 发布明明成功却一直显示「发布未生效」（实证 9/29）。
      //    成功判据改为看 via：setOaMenu 只在真正发布成功时才带 via('cloud'/'https')。
      const okPub = !!(d && d.via && !d.errcode)
      if (okPub) {
        const viaTxt = (d && d.via) === 'https' ? 'HTTPS 直调' : '云调用'
        this.setData({ publishMsg: '发布成功 ✅（' + viaTxt + '）｜微信客户端菜单有缓存，最长 24h 或取消关注再关注才刷新；以本页「线上菜单」为准' })
        wx.showToast({ title: '已发布', icon: 'success' })
        this.refreshLast()
      } else {
        // 服务端无论成败都落库了草稿 + 回复文案，失败只影响「推给微信」这一步
        this.setData({ publishMsg: '发布未生效：' + ((d && d.message) || '未知错误') + '（草稿与回复文案已保存，可稍后重试）' })
        wx.showToast({ title: '发布未生效', icon: 'none' })
        this.refreshLast()
      }
    }).catch(e => {
      wx.hideLoading()
      this.setData({ publishMsg: '发布异常：' + (e && e.message ? e.message : e) })
      wx.showToast({ title: '发布异常', icon: 'none' })
    })
  }
})
