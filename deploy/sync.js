/**
 * 一键同步前端：自动升版本号 + 上传体验版（miniprogram-ci）
 *
 * 这是「改完本地代码 → 让体验版跟上」的唯一前端入口。
 * 云函数同步不走这里（tcb 已废，须由 WorkBuddy 走 CloudBase MCP 部署）。
 *
 * 用法：
 *   bash deploy/sync.sh                  # 自动版本+1 并上传
 *   NODE_PATH=... node deploy/sync.js   # 同上（Windows 用 sync.sh 即可）
 * 可选参数/环境变量：
 *   --set 6.4.5       指定版本（不自动+1）
 *   --no-bump         沿用 version.txt 当前版本，不上浮
 *   --desc "说明"     上传备注（也可用 MINI_DESC）
 *   MINI_UPLOAD_KEY   私钥路径（默认 deploy/private.wxb97578ed89c6e2c7.key）
 *   MINI_ROBOT        机器人编号（默认 1）
 */
const fs = require('fs')
const path = require('path')
const ci = require('miniprogram-ci')

const ROOT = path.resolve(__dirname, '..')
const APPID = 'wxb97578ed89c6e2c7'
const VERSION_FILE = path.join(__dirname, 'version.txt')
const KEY = process.env.MINI_UPLOAD_KEY || path.join(__dirname, 'private.wxb97578ed89c6e2c7.key')

// ---- 解析参数 ----
const args = process.argv.slice(2)
let setVersion = null
let noBump = false
let desc = process.env.MINI_DESC || ''
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--set') setVersion = args[++i]
  else if (args[i] === '--no-bump') noBump = true
  else if (args[i] === '--desc') desc = args[++i]
}

function readVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim()
  } catch {
    return '6.4.2'
  }
}

function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  if (!m) return v + '.1'
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

async function main() {
  if (!fs.existsSync(KEY)) {
    console.error('[sync] 找不到上传私钥，请设置 MINI_UPLOAD_KEY 指向 private.*.key')
    console.error('[sync] 获取位置：微信公众平台 → 开发管理 → 开发设置 → 小程序代码上传密钥')
    process.exit(2)
  }

  let version = process.env.MINI_VERSION || setVersion || readVersion()
  if (!setVersion && !process.env.MINI_VERSION && !noBump) {
    version = bumpPatch(version)
    fs.writeFileSync(VERSION_FILE, version)
    console.log(`[sync] 版本自增 -> ${version}`)
  } else {
    fs.writeFileSync(VERSION_FILE, version)
  }
  const finalDesc = desc || `sync ${version}`

  const project = new ci.Project({
    appid: APPID,
    type: 'miniProgram',
    projectPath: ROOT,
    privateKeyPath: KEY,
    ignores: ['node_modules/**/*', 'cloudfunctions/**/*'],
  })

  console.log(`[sync] 开始上传前端 -> version=${version}`)
  const result = await ci.upload({
    project,
    version,
    desc: finalDesc,
    robot: Number(process.env.MINI_ROBOT || 1),
    setting: { es6: true, minify: true, urlCheck: false },
  })
  console.log(`[sync] ✅ 上传成功（体验版 ${version}）：`, JSON.stringify(result))
}

main().catch((e) => {
  console.error('[sync] ❌ 失败:', e && e.message ? e.message : e)
  process.exit(1)
})
