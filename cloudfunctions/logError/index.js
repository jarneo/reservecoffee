// logError — 前端全局错误上报落库（errorLogs 集合）
//
// 为什么需要：项目此前**没有任何全局错误日志**——
//   _lib 的 ok()/fail() 只封装返回值不落库、无 errorLogs 集合、无统一 try/catch。
//   线上出问题时只能靠用户口头描述，19:24 那次朋友圈打开报错就是如此：无法定位。
// 有了它，下一次报错至少能查到：哪个页面、什么异常、什么机型、什么微信版本、哪个场景进入。
//
// 🔒 免鉴权：不检查角色。错误可能发生在**任何**环节（包括管理员调用链之外的顾客侧），
//   且单页模式（朋友圈打开，scene 1154）下本就取不到 OPENID —— 鉴权会让上报失效。
//   风险控制靠**只写不读**：本函数不回传入参、不提供查询接口，外部无法读取任意用户数据。
//
// ⚠️ 入参可能被伪造（任何人可调）。故：
//   ① 不落任何业务标识（openid 已在客户端脱敏，且本函数不做鉴权不做关联）；
//   ② 字段长度全部截断，避免超大文本撑爆文档；
//   ③ 写入失败一律静默——上报失败绝不能反过来影响小程序。
const { db, ok, fail } = require('./lib')

const COLLECTION = 'errorLogs'

// 懒建集合：CloudBase 不会因 add() 自动建集合（实测抛 "Db or Table not exist"）。
// 这里沿用项目既有做法（saveSmsConfig / listTemplates 都是这么干的）：先尝试建，已存在则忽略。
let ensured = false
async function ensureCollection() {
  if (ensured) return
  ensured = true
  try {
    if (typeof db.createCollection === 'function') await db.createCollection(COLLECTION)
  } catch (e) { /* 已存在 / 无权限 → 忽略 */ }
}

function clip(v, max) {
  const s = (v === undefined || v === null) ? '' : String(v)
  return s.length > max ? s.slice(0, max) : s
}

exports.main = async (event) => {
  const e = event || {}
  if (!e.errMsg && !e.type) return fail('缺少 errMsg/type')

  try {
    await ensureCollection()
    const doc = {
      ts: Date.now(),                       // 数字时间戳：供「按时间范围」查询（建索引）
      side: 'client',                       // 预留：将来云函数侧异常也走这张表
      type: clip(e.type || 'onError', 32),  // onError | unhandledRejection
      errMsg: clip(e.errMsg, 500),
      stack: clip(e.stack, 2000),
      route: clip(e.route, 200),            // 出错时所在页面路由
      scene: e.scene === undefined ? '' : Number(e.scene) || 0,
      ua: clip(e.ua, 300),                  // model/system/version/SDKVersion 拼接串
      envVersion: clip(e.envVersion, 20)    // 区分 develop/trial/release
      // ⚠️ 刻意不落：pageQuery / enterQuery 的**值**（可能含手机号等敏感信息），
      //    也不落 openid 原文。需要排查时用 route + scene + 时间已足够定位。
    }
    await db.collection(COLLECTION).add({ data: doc })
    return ok({ logged: true })
  } catch (err) {
    // 上报失败绝不抛出：否则错误上报本身会变成新的报错源
    console.warn('[logError] write failed (ignored):', err && (err.message || err))
    return fail('写入失败')
  }
}
