#!/usr/bin/env node
/**
 * 认证服务号「模板消息」连通性实测
 * ------------------------------------------------------------
 * 目的：判定本项目服务号（wx4d8d957ee8af6073）是否仍具备模板消息推送能力。
 * 结论直接影响「管理员接收新预约通知」的方案选型：
 *   可用  → 管理员关注服务号即可，无需逐条授权（根治「反复点」）
 *   48001 → 无权限，只能回到小程序一次性订阅 / 短信 / 企微
 *
 * 用法（凭证只走环境变量，绝不落盘）：
 *   WX_APPID=<服务号AppID> WX_SECRET=<服务号AppSecret> \
 *     node scripts/testMpTemplate.js [templateId] [toOpenid]
 *
 *   templateId 省略 → 自动取「我的模板」第一条
 *   toOpenid   省略 → 自动取关注者列表第一个（并打印全部便于指定）
 *
 * 注意：必须用【服务号】的 AppID/Secret，小程序凭证完全不互通（混用报 40001）。
 */

const APPID = process.env.WX_APPID || '';
const SECRET = process.env.WX_SECRET || '';
const API = 'https://api.weixin.qq.com';

const argTpl = process.argv[2] || '';
const argTo = process.argv[3] || '';

// 常见 errcode 释义，便于一眼定位
const ERR = {
  0: '成功',
  40001: 'access_token 无效 / AppSecret 错误 / 凭证用错（确认用的是服务号而非小程序）',
  40013: 'AppID 无效',
  40037: 'template_id 不正确（模板不属于该公众号或已被删除）',
  43004: '接收人未关注该公众号（必须先关注才能收到模板消息）',
  45009: '接口调用超过限额',
  48001: 'API 功能未授权 —— 无模板消息权限（订阅号 / 未认证 / 未开通）',
  47003: '模板参数不准确（data 的 key 与模板字段不匹配，或内容含违规字符）',
};

function explain(code) {
  return ERR[code] ? ERR[code] : '未收录的错误码，查阅公众号全局返回码说明';
}

function mask(s) {
  if (!s) return '(空)';
  return s.length <= 8 ? '****' : s.slice(0, 4) + '****' + s.slice(-4);
}

async function get(path) {
  const r = await fetch(API + path);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// 从模板 content 里解析字段名：{{first.DATA}} / {{keyword1.DATA}} / {{remark.DATA}}
function parseKeys(content) {
  const out = [];
  const re = /\{\{([A-Za-z0-9_]+)\.DATA\}\}/g;
  let m;
  while ((m = re.exec(content || '')) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

(async () => {
  console.log('=== 服务号模板消息连通性测试 ===\n');

  if (!APPID || !SECRET) {
    console.error('❌ 缺少凭证。请这样运行：');
    console.error('   WX_APPID=<服务号AppID> WX_SECRET=<服务号AppSecret> node scripts/testMpTemplate.js');
    process.exit(1);
  }
  console.log('AppID:', mask(APPID));
  console.log('Secret:', mask(SECRET), '\n');

  // ---------- 1. 取 access_token ----------
  const tk = await get(`/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`);
  if (!tk.access_token) {
    console.error('❌ 取 token 失败：', tk.errcode, tk.errmsg);
    console.error('   →', explain(tk.errcode));
    process.exit(1);
  }
  const TOKEN = tk.access_token;
  console.log('✅ 1/4 access_token 获取成功（有效期 %ss）', tk.expires_in);

  // ---------- 2. 列「我的模板」：验证是否有模板消息权限 ----------
  const tplRes = await get(`/cgi-bin/template/get_all_private_template?access_token=${TOKEN}`);
  if (tplRes.errcode && tplRes.errcode !== 0) {
    console.error('❌ 2/4 拉取模板失败：', tplRes.errcode, tplRes.errmsg);
    console.error('   →', explain(tplRes.errcode));
    process.exit(1);
  }
  const list = tplRes.template_list || [];
  if (!list.length) {
    console.error('❌ 2/4 模板列表为空 —— 请先在公众平台「模板消息 > 模板库 > 类目模板库」添加模板');
    process.exit(1);
  }
  console.log('✅ 2/4 模板消息权限存在，共 %d 个模板：', list.length);
  list.forEach((t, i) => {
    console.log('   [%d] %s', i, t.title);
    console.log('       template_id = %s', t.template_id);
    console.log('       content     = %s', (t.content || '').replace(/\r?\n/g, ' | '));
  });

  // 选模板
  let tpl = argTpl ? list.find((t) => t.template_id === argTpl) : list[0];
  if (!tpl) {
    console.error('❌ 指定的 templateId 不在列表中');
    process.exit(1);
  }
  console.log('\n   → 使用模板：%s (%s)', tpl.title, tpl.template_id);
  const keys = parseKeys(tpl.content);
  console.log('   → 解析到字段：%s', keys.join(', '));

  // ---------- 3. 取关注者 openid ----------
  let toOpenid = argTo;
  if (!toOpenid) {
    const fans = await get(`/cgi-bin/user/get?access_token=${TOKEN}`);
    if (fans.errcode && fans.errcode !== 0) {
      console.error('\n❌ 3/4 拉取关注者失败：', fans.errcode, fans.errmsg);
      console.error('   → 请手动传入你的公众号 openid 作为第 3 个参数');
      process.exit(1);
    }
    const openids = (fans.data && fans.data.openid) || [];
    console.log('\n✅ 3/4 关注者共 %d 人', fans.total);
    console.log('   openid 列表：%s', openids.join(', ') || '(空)');
    if (!openids.length) {
      console.error('❌ 无关注者，无法发送。请先关注该服务号');
      process.exit(1);
    }
    toOpenid = openids[0];
    console.log('   → 默认发给第一个，若要指定请传第 3 个参数');
  } else {
    console.log('\n✅ 3/4 使用指定接收人：%s', toOpenid);
  }

  // ---------- 4. 发送 ----------
  // 新规范：去自定义颜色、去表情、主内容单条 ≤20 字 —— 故只传 value 不传 color
  const data = {};
  keys.forEach((k) => {
    if (k === 'first') data[k] = { value: '模板消息连通性测试' };
    else if (k === 'remark') data[k] = { value: '收到即代表通道可用' };
    else data[k] = { value: '测试数据' };
  });

  const sendRes = await post(`/cgi-bin/message/template/send?access_token=${TOKEN}`, {
    touser: toOpenid,
    template_id: tpl.template_id,
    data,
  });

  console.log('\n=== 4/4 发送结果 ===');
  console.log('errcode:', sendRes.errcode, '| errmsg:', sendRes.errmsg, '| msgid:', sendRes.msgid || '-');
  console.log('释义:', explain(sendRes.errcode));

  if (sendRes.errcode === 0) {
    console.log('\n🎉 通道可用！服务号模板消息能主动推送，无需用户逐条授权。');
    console.log('   → 请查看手机微信里该服务号的会话，应已收到这条测试消息。');
  } else {
    console.log('\n⚠️  通道不可用或需调整，按上面释义处理。');
  }
})().catch((e) => {
  console.error('运行异常：', e.message);
  process.exit(1);
});
