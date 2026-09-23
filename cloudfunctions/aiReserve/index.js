// aiReserve — AI 智能预约（小程序端入口）
//
// 本函数已「瘦身」为薄封装：NLU / 可用性校验 / 知识库 / 日志统一由共享核心 aiCore.runChat 提供，
// 公众号端 mpChat 复用同一份核心（仅身份与渠道不同），知识库 kb/*.md 改一处两端同时生效。
//
// 返回结构（与 mpChat 共用同一契约）：
//   { intent:'chat',  reply }                                     普通问答
//   { intent:'ask',   reply, notice? }                            信息不全 / 不可约，需继续追问
//   { intent:'confirm', reply, confirmation, profile, logId }     已解析出可约时段，前端据此渲染确认卡
//   { intent:'chat',  reply, limited:true, quota }                命中每日轮次上限（后台可配）
const { ok, fail, wxCtx } = require('./lib')
const { runChat } = require('./aiCore')

exports.main = async (event) => {
  const ctx = wxCtx() || {}
  const OPENID = ctx.OPENID
  if (!OPENID) return fail('无法识别用户身份')

  try {
    const out = await runChat({
      openid: OPENID,
      channel: 'mp',                 // 小程序渠道（与 'oa' 公众号区分，供数据分析占比）
      unionid: ctx.UNIONID || '',    // 开放平台 unionid：与公众号端同一人可关联
      messages: event.messages,
      projectId: event.projectId,
      nickname: event.nickname
    })
    return ok(out)
  } catch (e) {
    return fail('AI 服务暂不可用：' + (e && e.message ? e.message : '未知错误'))
  }
}
