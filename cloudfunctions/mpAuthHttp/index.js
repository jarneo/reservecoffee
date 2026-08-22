// cloudfunctions/mpAuthHttp/index.js — HTTP 云函数（Web Server 模式）
// 用途：接收网页授权回调的 code，换取服务号 openid，写入 users.mpOpenid（并按 unionid 兜底关联）。
// 由 mp-auth.html 整页跳转调用（不再依赖 wx.miniProgram.postMessage，规避 web-view 授权回调丢上下文的问题）。
const http = require('http')
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const MP_APPID = process.env.MP_APP_ID || ''
const MP_SECRET = process.env.MP_APP_SECRET || ''

function page(title, msg, ok) {
  const color = ok ? '#2f855a' : '#c53030'
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">` +
    `<title>${title}</title></head><body style="margin:0;font-family:-apple-system,'PingFang SC',sans-serif;` +
    `background:#f6f4ef;color:#2b2b2b;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px">` +
    `<div style="width:100%;max-width:360px;background:#fff;border-radius:16px;padding:28px 22px;` +
    `box-shadow:0 6px 24px rgba(0,0,0,.06);text-align:center">` +
    `<div style="font-size:18px;font-weight:600;margin-bottom:8px;color:${color}">${title}</div>` +
    `<div style="font-size:14px;color:#6b6b6b;line-height:1.6;margin:10px 0 18px">${msg}</div>` +
    `<div style="font-size:13px;color:#999">请点击左上角「返回」回到小程序</div></div></body></html>`
}

function send(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost')
    const pathname = u.pathname
    const code = u.searchParams.get('code') || ''
    const openid = u.searchParams.get('openid') || ''
    // 业务域名校验文件（微信添加业务域名时访问根目录校验）。内容与静态托管根一致。
    if (pathname === '/vwxRfwxPB8.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('f5af24e9687515a1e71b7defbb3271f8')
    }
    if (!code) return send(res, page('参数缺失', '缺少授权 code，请重试', false))
    if (!MP_APPID || !MP_SECRET) return send(res, page('服务未配置', '服务端未配置 AppSecret', false))

    // 用 code 换服务号 openid（微信 sns/oauth2/access_token）
    const r = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?appid=${MP_APPID}&secret=${MP_SECRET}&code=${code}&grant_type=authorization_code`)
    const j = await r.json()
    if (j.errcode) return send(res, page('授权失败', `微信返回 ${j.errcode}:${j.errmsg}`, false))

    const mpOpenid = j.openid
    const unionid = j.unionid || ''

    // 按小程序 openid 主键写入
    if (openid) {
      const data = { mpOpenid }
      if (unionid) data.unionid = unionid
      await db.collection('users').doc(openid).update({ data })
    }
    // unionid 兜底：同 unionid 的其他用户文档也补上 mpOpenid（利用开放平台绑定）
    if (unionid && openid) {
      await db.collection('users').where({ unionid, _id: _.neq(openid) }).update({ data: { mpOpenid } })
    }
    return send(res, page('✅ 已开启服务号通知', '绑定成功，现在可以接收本店的服务号通知了', true))
  } catch (e) {
    return send(res, page('处理失败', e.message || '未知错误', false))
  }
})

const port = process.env.PORT || 9000
server.listen(port, '0.0.0.0', () => console.log('mpAuthHttp listening on', port))
