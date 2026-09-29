// utils/jump.js — 跳转到「二曜路8号咖啡与清酒」小程序（店铺菜单）的统一入口 + 失败兜底
//
// 三个关键点（微信官方语义）：
//   1) path **可以留空**：不传 path 或传 '' → 打开对方小程序**首页**。
//      不知道对方页面路径时就用这个，不要瞎猜页面名（猜错会「页面不存在」）。
//   2) envVersion：'release'(默认，线上正式版) | 'trial'(体验版) | 'develop'(开发版)。
//      线上菜单/线上小程序里跳，只可能是 'release'；跳体验版要对方把你加进体验成员。
//   3) extraData：**非必需**，只有对方小程序在 App.onLaunch/onShow 里主动读才有用，
//      传了对方不读也不会报错。不知道要传什么就别传。
//
// ⚠️ 前置条件：目标 AppID 必须写进 app.json 的 navigateToMiniProgramAppIdList（最多 10 个），
//    否则直接 fail：navigateToMiniProgram:fail appid not in navigateToMiniProgramAppIdList。
// ⚠️ 调用时机：必须在**用户点击**的回调里调（如 bindtap），不能放在 onLoad 里自动跳。

const TARGET_APPID = 'wx00914125678e1ad3'

// 兜底短链：跳转失败时给用户一条能点的明文短链（短链只能出现在文本里点击，填不进菜单字段）
const FALLBACK_SHORTLINK = '#小程序://二曜路8号咖啡与清酒/mo87lr2EyqI4n1F'

/**
 * @param {object} [opt]
 *   appId      默认 wx00914125678e1ad3
 *   path       默认 ''（= 对方首页）；知道确切页面再传，如 'pages/index/index'
 *   envVersion 默认 'release'
 *   extraData  可选，对方不读就别传
 *   tip        失败弹窗的补充说明
 */
function jumpMiniProgram(opt) {
  const o = opt || {}
  const appId = o.appId || TARGET_APPID
  const path = o.path || ''
  const envVersion = o.envVersion || 'release'

  wx.navigateToMiniProgram({
    appId,
    path,
    envVersion,
    extraData: o.extraData,   // undefined 时不传该字段
    success(res) {
      if (typeof o.onSuccess === 'function') o.onSuccess(res)
    },
    fail(err) {
      console.warn('[jump] navigateToMiniProgram 失败：', JSON.stringify(err))
      // 兜底：告诉用户没打开，并给一条可复制的短链（他自己粘到聊天里点就能进）
      wx.showModal({
        title: '没能打开小程序',
        content: (o.tip || '跳转失败，可能是对方小程序暂未关联或页面不存在。') +
          '\n你可以复制备用链接，粘到任意聊天里点击即可直达。',
        confirmText: '复制备用链接',
        cancelText: '知道了',
        success(r) {
          if (!r.confirm) return
          wx.setClipboardData({
            data: FALLBACK_SHORTLINK,
            success: () => wx.showToast({ title: '已复制备用链接', icon: 'none' })
          })
        }
      })
      if (typeof o.onFail === 'function') o.onFail(err)
    }
  })
}

module.exports = { jumpMiniProgram, TARGET_APPID, FALLBACK_SHORTLINK }
