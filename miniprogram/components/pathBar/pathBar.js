// components/pathBar/pathBar.js — 管理员（owner）专属：页面**末尾**一行小灰字，显示当前页面完整路径 + 一键复制
//
// 用途：配公众号菜单的 pagepath / 生成短链时，需要**完整路径（含 query，如 ?projectId=xxx）**，
//       owner 打开任意页面滚到底就能看到并复制，不用翻代码。
// 非 owner（含 manager / 普通顾客）完全不渲染。
//
// 身份依据：app.globalData.role（由 app.refreshRole() 写，取值 none | owner | manager），
//          与 adminGuard 门禁用的是同一份数据，不会两套判断打架。
// 路径来源：getCurrentPages() 最后一个实例的 route + options —— 唯一可靠的通用方式。
// ⚠️ 时机坑：组件 attached 有可能早于页面 onLoad 拿到 options（Skyline / glass-easel 下不确定），
//    所以除了 attached，还在 ready 与 pageLifetimes.show 里**重算一次**，保证带 ?query 的完整路径不被吞。
//
// 开关：管理端「界面设置」→ 页面路径条。关掉后 owner 也看不到（配置存 config._id='ui'）。

function pathOf() {
  try {
    const pages = getCurrentPages()
    const cur = pages && pages[pages.length - 1]
    if (!cur) return ''
    // 兼容不同基础库：route / options 可能挂在实例上，也可能挂在 $page 上
    const route = cur.route || (cur.$page && cur.$page.route) || ''
    const onInst = cur.options && Object.keys(cur.options).length ? cur.options : null
    const opt = onInst || (cur.$page && cur.$page.options) || {}
    const qs = Object.keys(opt)
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(opt[k]))
      .join('&')
    return route + (qs ? '?' + qs : '')
  } catch (e) {
    return ''
  }
}

// 开关：管理端「界面设置」里的 pathBar（默认开）。
// 每会话只读一次，结果缓存在 app.globalData.pathBarEnabled；管理端改完会就地更新这份缓存。
function ensureEnabled(app) {
  if (typeof app.globalData.pathBarEnabled === 'boolean') {
    return Promise.resolve(app.globalData.pathBarEnabled)
  }
  if (app._pathBarCfgPromise) return app._pathBarCfgPromise
  const { call } = require('../../utils/cloud')
  app._pathBarCfgPromise = call('uiConfig', { action: 'get' })
    .then(d => {
      const v = !(d && d.pathBar === false)
      app.globalData.pathBarEnabled = v
      return v
    })
    .catch(() => {
      app._pathBarCfgPromise = null   // 失败不缓存，下次重试
      return false                    // 读不到配置就不显示，不打扰
    })
  return app._pathBarCfgPromise
}

Component({
  data: { show: false, path: '' },
  lifetimes: {
    attached() {
      const app = getApp()
      const role = app && app.globalData ? app.globalData.role : 'none'
      if (role === 'owner') this.ownerInit(app)
      else if (role === 'manager') this.setData({ show: false })
      else if (app && typeof app.refreshRole === 'function' && !app._pathBarProbed) {
        // 冷启动头一屏可能还没拿到角色 → 补一次。
        // ⚠️ 只补一次（打 app 上的标记）：否则普通顾客每开一页都会多一次云函数调用。
        app._pathBarProbed = true
        app.refreshRole().then(r => {
          if ((r && r.role) === 'owner') this.ownerInit(app)
        }).catch(() => {})
      }
    },
    // 再兜一道：ready 晚于 attached，此时页面 onLoad 一定跑完了
    ready() {
      if (this.data.show) this.setData({ path: pathOf() })
    }
  },
  pageLifetimes: {
    // 每次页面 show 都重算：此时 onLoad 早已执行完，options 一定有值；
    // 同时复查开关（管理端刚关掉的话，回到其它页面就不再显示）
    show() {
      const app = getApp()
      const isOwner = this.data.show || ((app && app.globalData) || {}).role === 'owner'
      if (!isOwner) return
      ensureEnabled(app).then(on => {
        this.setData({ show: on, path: on ? pathOf() : '' })
      })
    }
  },
  methods: {
    ownerInit(app) {
      ensureEnabled(app).then(on => {
        this.setData({ show: on, path: on ? pathOf() : '' })
      })
    },
    onCopy() {
      const p = this.data.path
      if (!p) return
      wx.setClipboardData({
        data: p,
        success: () => wx.showToast({ title: '路径已复制', icon: 'none' })
      })
    }
  }
})
