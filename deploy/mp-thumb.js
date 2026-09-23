#!/usr/bin/env node
// mp-thumb.js — 一键把本地图片上传为公众号永久素材，拿到「小程序卡片封面」的 media_id
//
// 为什么需要它：客服消息 miniprogrampage 的 thumb_media_id 要求「image 类型的 media_id」，
// 后台素材库界面看不到这个值，必须调 material/add_material 接口拿。
//
// 用法（在本机跑，不需要云函数出网）：
//   node deploy/mp-thumb.js <图片路径> [AppSecret]
//   node deploy/mp-thumb.js ./card.jpg
//   node deploy/mp-thumb.js ./card.jpg 3f9a****************   // 直接传 Secret，方便一次性使用
//   MP_APP_SECRET=xxx node deploy/mp-thumb.js ./card.jpg      // 或用环境变量传
//
// 输出：media_id。把它交给 AI 写入数据库（config 集合 mp 文档 cardThumbMediaId 字段）即可，
// 也可以自己到 CloudBase 控制台 → 数据库 → config 集合 → 新增/编辑 _id=mp 的文档。
//
// ⚠️ 建议图片尺寸 520×416（微信官方建议值），jpg/png 均可，≤10MB。

const fs = require('fs')
const path = require('path')
const https = require('https')

const APPID = process.env.MP_APP_ID || 'wx4d8d957ee8af6073'

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) } catch (e) { resolve({ __raw: buf.slice(0, 400) }) }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function stat(file) {
  try { return fs.statSync(file) } catch (e) { return null }
}

async function main() {
  const file = process.argv[2]
  const secret = process.argv[3] || process.env.MP_APP_SECRET || ''

  if (!file) {
    console.error('\n 用法: node deploy/mp-thumb.js <图片路径> [AppSecret]\n')
    process.exit(1)
  }
  const abs = path.resolve(file)
  const st = stat(abs)
  if (!st || !st.isFile()) {
    console.error(`\n 找不到图片文件：${abs}\n`)
    process.exit(2)
  }
  if (st.size > 10 * 1024 * 1024) {
    console.error(`\n 图片超过 10MB（${(st.size / 1024 / 1024).toFixed(1)}MB），微信素材接口会拒绝。请压缩后再试。\n`)
    process.exit(3)
  }
  if (!secret) {
    console.error('\n 缺少 AppSecret。两种给法：\n')
    console.error('   node deploy/mp-thumb.js <图片> <AppSecret>')
    console.error('   MP_APP_SECRET=<AppSecret> node deploy/mp-thumb.js <图片>\n')
    console.error(' 获取位置：微信公众平台 → 设置与开发 → 基本配置 → 公众号开发信息 → AppSecret\n')
    process.exit(4)
  }

  console.log(`\n① 获取 access_token（AppID: ${APPID}）...`)
  const tk = await request({
    host: 'api.weixin.qq.com',
    path: `/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(APPID)}&secret=${encodeURIComponent(secret)}`,
    method: 'GET'
  })
  if (!tk || !tk.access_token) {
    console.error('\n 取 token 失败：', JSON.stringify(tk))
    if (tk && tk.errcode === 40164) {
      console.error('\n → 40164：你的本机公网 IP 不在公众号「IP 白名单」里。')
      console.error('   解决：公众平台 → 设置与开发 → 基本配置 → IP白名单 → 把上面报错里提示的 IP 加进去。')
    }
    if (tk && tk.errcode === 40013) console.error('\n → 40013：AppID 不对，请检查。')
    if (tk && tk.errcode === 40001) console.error('\n → 40001：AppSecret 不对，或刚重置过。请重新从公众平台复制。')
    process.exit(5)
  }
  console.log('   ✓ token 已获取')

  console.log(`② 上传永久素材：${abs}（${(st.size / 1024).toFixed(0)}KB）...`)
  const buf = fs.readFileSync(abs)
  const ext = (path.extname(abs).slice(1) || 'jpg').toLowerCase()
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp' }[ext] || 'image/jpeg'
  const fieldName = `image.${ext === 'jpeg' ? 'jpg' : ext}`

  const boundary = '----mpThumb' + Date.now().toString(16)
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${fieldName}"\r\nContent-Type: ${mime}\r\n\r\n`
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const bodyData = Buffer.concat([head, buf, tail])

  const up = await request({
    host: 'api.weixin.qq.com',
    path: `/cgi-bin/material/add_material?access_token=${encodeURIComponent(tk.access_token)}&type=image`,
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyData.length }
  }, bodyData)

  if (!up || !up.media_id) {
    console.error('\n 上传失败：', JSON.stringify(up))
    process.exit(6)
  }

  console.log(`   ✓ 已上传到素材库，URL: ${up.url || '(n/a)'}\n`)
  console.log('════════════════════════════════════════════════')
  console.log(` media_id = ${up.media_id}`)
  console.log('════════════════════════════════════════════════')
  console.log('\n下一步，二选一：')
  console.log('  A. 把上面这串 media_id 发给 AI，直接写入云数据库（推荐）')
  console.log('  B. 自己去 CloudBase 控制台 → 数据库 → config 集合 → 新增一条：')
  console.log(`       _id = "mp"`)
  console.log(`       cardThumbMediaId = "${up.media_id}"`)
  console.log('\n没配封面也不影响功能：mpChat 会自动降级为「文本 + 小程序文字链」，同样能跳转。\n')
}

main().catch((e) => { console.error('\n 执行出错：', e && (e.message || e), '\n'); process.exit(9) })
