#!/usr/bin/env python3
"""AI 工具额度看板 · 数据核验脚本（独立复算，与 API 对账用）

用法: python3 test/verify-against-sources.py [日期，默认今天]
"""
import json, glob, os, sqlite3, shutil, tempfile, sys, datetime, collections

DAY = sys.argv[1] if len(sys.argv) > 1 else datetime.datetime.now(datetime.timezone.utc).timestamp() and datetime.datetime.fromtimestamp(datetime.datetime.now(datetime.timezone.utc).timestamp()+8*3600, datetime.timezone.utc).strftime('%Y-%m-%d')

def bjday(ts_s_or_ms, ms=True):
    t = ts_s_or_ms / 1000 if ms else ts_s_or_ms
    return datetime.datetime.fromtimestamp(t + 8*3600, datetime.timezone.utc).strftime('%Y-%m-%d')

print(f'核验日期: {DAY}\n')

# --- ZCode ---
tmp = tempfile.mktemp(suffix='.db')
shutil.copy(os.path.expanduser('~/.zcode/cli/db/db.sqlite'), tmp)
for ext in ('-wal', '-shm'):
    src = os.path.expanduser('~/.zcode/cli/db/db.sqlite') + ext
    if os.path.exists(src): shutil.copy(src, tmp + ext)
c = sqlite3.connect(tmp)
zc = c.execute("""select count(*), sum(input_tokens), sum(output_tokens)
  from model_usage where status='completed' and ? like strftime('%Y-%m-%d', started_at/1000+8*3600, 'unixepoch')""", (DAY,)).fetchone()
print(f"ZCode       : {zc[0]} 次  in={zc[1]} out={zc[2]}")
os.remove(tmp)

# --- Codex / Claude Desktop ---
c = sqlite3.connect(os.path.expanduser('~/.cc-switch/cc-switch.db'))
for app in ('codex', 'claude-desktop'):
    r = c.execute("""select count(*), sum(input_tokens), sum(output_tokens), round(sum(total_cost_usd),4)
      from proxy_request_logs
      where date(created_at,'unixepoch','+8 hours')=? and app_type=?""", (DAY, app)).fetchone()
    print(f"{app:12s}: {r[0]} 次  in={r[1]} out={r[2]}  ${r[3]}")

# --- WorkBuddy ---
agg = collections.Counter(); n = 0
for f in glob.glob(os.path.expanduser('~/.workbuddy-ai/projects/**/*.jsonl'), recursive=True):
    seen = set()
    for line in open(f, errors='ignore'):
        if '"usage"' not in line: continue
        try: d = json.loads(line)
        except: continue
        pd = d.get('providerData') or {}
        u = pd.get('usage')
        if not u: continue
        dk = os.path.basename(f) + '|' + str(pd.get('messageId') or d.get('id') or '') + '|' + str(pd.get('model'))
        if dk in seen: continue
        seen.add(dk)
        if bjday(d.get('timestamp')) != DAY: continue
        raw = pd.get('rawUsage') or {}
        hit = raw.get('prompt_cache_hit_tokens')
        det = u.get('inputTokensDetails')
        dv = sum(x.get('cached_tokens', 0) for x in det if x) if isinstance(det, list) else (det.get('cached_tokens', 0) if isinstance(det, dict) else 0)
        agg['cache'] += hit if hit is not None else dv
        agg['in'] += u.get('inputTokens', 0); agg['out'] += u.get('outputTokens', 0)
        n += 1
print(f"workbuddy   : {n} 次  in={agg['in']} out={agg['out']} cache={agg['cache']}")
print('\n与 GET /api/summary?days=N 对应日期的数值对比即可（应逐位一致）')
