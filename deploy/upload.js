/**
 * 小程序前端上传脚本（miniprogram-ci）
 * 用途：把 miniprogram/ 前端代码上传到微信平台，生成「体验版」供测试。
 *
 * 前置：
 *   1. npm i miniprogram-ci（本脚本依赖同目录 node_modules 或全局）
 *   2. 从微信公众平台 → 开发管理 → 开发设置 → 下载「小程序代码上传密钥」(private.key)
 *      放到本目录或任意路径，通过环境变量传路径
 *
 * 用法（managed Node，miniprogram-ci 装在 node/workspace/node_modules）：
 *   MINI_UPLOAD_KEY="D:/WorkBuddy/reservecoffee/deploy/private.key" \
 *   NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" \
 *   "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe" deploy/upload.js
 *
 * 说明：
 *   - 仅上传前端；云函数请用 `tcb fn deploy`（已在本次会话完成 getHomepage）。
 *   - 上传后需在微信公众平台把该版本设为「体验版」，再用店主微信扫码体验测试。
 */
const path = require('path')
const ci = require('miniprogram-ci')

const ROOT = path.resolve(__dirname, '..')
const APPID = 'wxb97578ed89c6e2c7'
const KEY = process.env.MINI_UPLOAD_KEY || path.join(__dirname, 'private.key')
const VERSION = process.env.MINI_VERSION || '6.3.1'
const DESC = process.env.MINI_DESC || 'feat: 首图独立页/项目列表操作/首页banner/保存自动退回'
const ROBOT = Number(process.env.MINI_ROBOT || 1)

async function main() {
  if (!require('fs').existsSync(KEY)) {
    console.error('[upload] 找不到上传私钥，请设置 MINI_UPLOAD_KEY 指向你的 private.key')
    console.error('[upload] 获取位置：微信公众平台 → 开发管理 → 开发设置 → 小程序代码上传密钥')
    process.exit(2)
  }

  const project = new ci.Project({
    appid: APPID,
    type: 'miniProgram',
    projectPath: ROOT,            // 含 project.config.json 的仓库根
    privateKeyPath: KEY,
    ignores: ['node_modules/**/*', 'cloudfunctions/**/*'],
  })

  console.log(`[upload] 开始上传前端 -> appid=${APPID} version=${VERSION}`)
  const result = await ci.upload({
    project,
    version: VERSION,
    desc: DESC,
    robot: ROBOT,
    setting: {
      es6: true,
      minify: true,
      urlCheck: false,
    },
  })
  console.log('[upload] 上传成功:', JSON.stringify(result))
}

main().catch((e) => {
  console.error('[upload] 失败:', e && e.message ? e.message : e)
  process.exit(1)
})
