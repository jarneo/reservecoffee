#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成「直达小程序」的二维码图，并合成到品牌卡片图上。

为什么需要它
------------
公众号被动回复（服务器配置通道）只能发 text / image / news 三类。
其中：
  · image 需要 MediaId，MediaId 只能由「公众号素材接口」上传获得；
  · 而公众号素材接口要服务号 access_token，服务号 token 被 IP 白名单拦死（云函数出口 IP 漂移）。
  ⇒ 「独立的大图片二维码」在免费方案下做不到。
  · news（图文卡片）的 PicUrl 却是**任意公网图片链接**，不需要任何素材接口。
  ⇒ 把小程序码合成进卡片封面，就是免费能拿到的「带二维码的卡片」。

用法
----
    python deploy/wxa-qr.py <小程序AppSecret> [scene] [page]

示例
----
    python deploy/wxa-qr.py e801153f... oa pages/ai/ai

产物
----
    design/wxa-qr.png           纯小程序码（430x430）
    design/card-with-qr.jpg     品牌卡片图 + 右下角小程序码（用于图文卡片 PicUrl）

后续
----
    用 CloudBase MCP 的 manageHosting.upload 上传 design/card-with-qr.jpg 到
    oa/card-qr.jpg，然后把 mpChatHttp 的环境变量 OA_CARD_PIC 指过去即可。
    也可通过公众号私聊命令「#qr」下发该图做长按识别实测。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

APPID = os.environ.get('WXA_APP_ID') or 'wxb97578ed89c6e2c7'   # 小程序 AppID
API = 'https://api.weixin.qq.com'

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_CARD = os.path.join(ROOT, 'design', '520416.jpg')
OUT_QR = os.path.join(ROOT, 'design', 'wxa-qr.png')
OUT_CARD = os.path.join(ROOT, 'design', 'card-with-qr.jpg')

# 错误码判读：这是项目里反复踩坑后固化的判据，务必保留
DIAG = {
    40001: 'AppSecret 不正确，或 access_token 无效（先确认 secret 属于当前 AppID）',
    40013: 'AppID 不正确——注意小程序与公众号 AppID 是两个不同的账号',
    40125: 'AppSecret 无效。⚠️ 若你复制的是【服务号】的密钥，用在小程序上必然是这个错',
    40164: '出口 IP 不在白名单。小程序本不该出现此码；若出现说明用错了 AppID（小程序没有 IP 白名单）',
    41030: 'page 路径不存在，或小程序尚未发布该页面（可把 check_path 设为 false 兜底）',
    45009: '生成数量已达上限（getwxacodeunlimit 无次数限制，此码通常意味着用错了接口）',
    47001: '请求体格式错误',
}


def http_json(url, body=None):
    req = urllib.request.Request(url)
    req.add_header('Content-Type', 'application/json')
    if body is not None:
        req.data = json.dumps(body).encode('utf-8')
        req.method = 'POST'
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))


def http_bytes(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'))
    req.add_header('Content-Type', 'application/json')
    req.method = 'POST'
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read(), r.headers.get('Content-Type', '')


def die(msg, code=None):
    print('\n❌ ' + msg)
    if code in DIAG:
        print('   判读：' + DIAG[code])
    print('\n  可先用这条命令确认密钥归属（把 secret 换成你的）：')
    print('    curl -s "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential'
          '&appid=' + APPID + '&secret=YOUR_SECRET"')
    sys.exit(1)


def main():
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        print(__doc__)
        sys.exit(2)

    secret = sys.argv[1].strip()
    scene = (sys.argv[2] if len(sys.argv) > 2 else 'oa')[:32]      # unlimit 的 scene 上限 32 字符
    page = sys.argv[3] if len(sys.argv) > 3 else 'pages/ai/ai'

    print('① 获取小程序 access_token …')
    qs = urllib.parse.urlencode({
        'grant_type': 'client_credential', 'appid': APPID, 'secret': secret,
    })
    tok = http_json(API + '/cgi-bin/token?' + qs)
    if not tok.get('access_token'):
        die('小程序 access_token 获取失败：' + json.dumps(tok, ensure_ascii=False), tok.get('errcode'))
    token = tok['access_token']
    print('   ✅ 成功（有效期 %ss）' % tok.get('expires_in'))

    print('② 生成小程序码（getwxacodeunlimit，page=%s scene=%s）…' % (page, scene))
    raw, ctype = http_bytes(
        API + '/wxa/getwxacodeunlimit?access_token=' + urllib.parse.quote(token),
        {'scene': scene, 'page': page, 'check_path': False, 'env_version': 'release', 'width': 430},
    )
    if 'image' not in ctype:
        try:
            j = json.loads(raw.decode('utf-8'))
        except Exception:
            j = {'errcode': '?', 'errmsg': raw[:200]}
        die('小程序码生成失败：' + json.dumps(j, ensure_ascii=False), j.get('errcode'))
    with open(OUT_QR, 'wb') as f:
        f.write(raw)
    print('   ✅ 已保存 %s（%d 字节）' % (OUT_QR, len(raw)))

    print('③ 合成到品牌卡片图 …')
    try:
        from PIL import Image
    except ImportError:
        print('   ⚠️ 未安装 Pillow，跳过合成（只输出纯小程序码）')
        return
    if not os.path.exists(BASE_CARD):
        print('   ⚠️ 找不到底图 %s，跳过合成' % BASE_CARD)
        return

    base = Image.open(BASE_CARD).convert('RGB')
    qr = Image.open(OUT_QR).convert('RGB')

    # 二维码贴右下角，留白边；尺寸取卡片高度的 ~30%，保证手机上能长按放大识别
    side = int(base.height * 0.30)
    qr = qr.resize((side, side), Image.LANCZOS)
    pad = max(8, int(base.height * 0.035))
    # 白底衬，避免深色底图上扫码对比度不足
    plate = Image.new('RGB', (side + pad, side + pad), (255, 255, 255))
    plate.paste(qr, (pad // 2, pad // 2))
    base.paste(plate, (base.width - plate.width - pad, base.height - plate.height - pad))
    base.save(OUT_CARD, 'JPEG', quality=92)
    print('   ✅ 已保存 %s（%dx%d）' % (OUT_CARD, base.width, base.height))

    print('\n完成。下一步（在对话里让我做即可）：')
    print('   · 上传 design/card-with-qr.jpg → 静态托管 oa/card-qr.jpg')
    print('   · mpChatHttp 的 OA_CARD_PIC 默认值已指向该图，无需再改环境变量')
    print('   · 公众号私聊发「#qr」实测长按识别')


if __name__ == '__main__':
    main()
