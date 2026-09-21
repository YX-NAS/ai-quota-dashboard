#!/usr/bin/env python3
"""把 ~/.codex/auth.json 的 ChatGPT OAuth token 快照写进看板配置。

codex CLI 会自动刷新 auth.json；若你在设置面板手动配过 accessToken 且已过期，
跑一次本脚本即可恢复（也可以直接清空设置面板里的 token，回退自动读取 auth.json）。
"""
import json
import os

auth_path = os.path.expanduser('~/.codex/auth.json')
plans_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          'config', 'plans.json')

a = json.load(open(auth_path))
tokens = a.get('tokens') or a
plans = json.load(open(plans_path))
plans.setdefault('quotaKeys', {})['chatgpt'] = {
    'accessToken': tokens.get('access_token', ''),
    'note': 'auth.json 快照；codex 刷新 token 后若额度失效，终端跑: python3 scripts/sync-chatgpt-token.py',
}
json.dump(plans, open(plans_path, 'w'), ensure_ascii=False, indent=2)
print('快照已写入, token 长度:', len(tokens.get('access_token', '')))
