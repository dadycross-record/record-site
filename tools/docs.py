"""Build public/docs/*.html from the legal drafts (docs/legal.md, exported from the Claude doc)."""
import html, pathlib, re

root = pathlib.Path(__file__).resolve().parent.parent
md = (root / 'docs/legal.md').read_text(encoding='utf-8')
VERSION = 'черновик от 17 октября 2026'


def sections(text, level):
    """split by headings of the given level -> {title: body}"""
    out, cur, buf = {}, None, []
    for line in text.splitlines():
        m = re.match('#' * level + r' (.+)$', line)
        if m:
            if cur: out[cur] = '\n'.join(buf)
            cur, buf = m.group(1).strip(), []
        elif cur:
            buf.append(line)
    if cur: out[cur] = '\n'.join(buf)
    return out


def inline(s):
    s = s.replace('\\[', '\x01').replace('\\]', '\x02')
    s = html.escape(s, quote=False)
    s = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', s)
    s = re.sub(r'\[([^\]]+)\]\((https?://[^)\s]+|/[^)\s]*)\)', r'<a href="\2">\1</a>', s)
    return s.replace('\x01', '<span class="ph">[').replace('\x02', ']</span>')


def render(text, shift=0):
    out, lines, i = [], text.strip().splitlines(), 0
    while i < len(lines):
        l = lines[i]
        if not l.strip(): i += 1; continue
        m = re.match(r'(#{2,6}) (.+)$', l)
        if m:
            lv = min(6, len(m.group(1)) - shift)
            out.append(f'<h{lv}>{inline(m.group(2))}</h{lv}>'); i += 1; continue
        if l.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-{3,}:?', c) for c in cells): rows.append(cells)
                i += 1
            head, body = rows[0], rows[1:]
            out.append('<div class="tw"><table><thead><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in head) + '</tr></thead><tbody>'
                       + ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in body) + '</tbody></table></div>')
            continue
        if re.match(r'(- |\d+\. )', l):
            tag = 'ol' if re.match(r'\d+\. ', l) else 'ul'
            items = []
            while i < len(lines) and re.match(r'(- |\d+\. )', lines[i]):
                items.append(re.sub(r'^(- |\d+\. )', '', lines[i])); i += 1
            out.append(f'<{tag}>' + ''.join(f'<li>{inline(x)}</li>' for x in items) + f'</{tag}>')
            continue
        para = []
        while i < len(lines) and lines[i].strip() and not re.match(r'(#{2,6} |\||- |\d+\. )', lines[i]):
            para.append(lines[i]); i += 1
        out.append('<p>' + inline(' '.join(para)) + '</p>')
    return '\n'.join(out)


top = sections(md, 2)
pick = lambda prefix: next(v for k, v in top.items() if k.startswith(prefix))
sub = lambda body, title: sections(body, 3)[title]

PAGES = {
    'privacy': ('Политика обработки персональных данных', render(pick('1.'), 1)),
    'consent': ('Согласие на обработку персональных данных', render(sub(pick('2.'), 'Текст согласия'))),
    'publish': ('Согласие на распространение персональных данных', render(sub(pick('3.'), 'Текст согласия'))),
    'offer': ('Публичная оферта: абонементы и разовые тренировки', render(pick('5.'), 1)),
    'rules': ('Условия участия в соревнованиях', render(pick('6.'), 1)),
}

CSS = '''@font-face{font-family:"Golos Text";src:url(/fonts/golos.woff) format("woff");font-weight:400 900;font-display:swap}
@font-face{font-family:"Unbounded";src:url(/fonts/unbounded.woff) format("woff");font-weight:200 900;font-display:swap}
:root{color-scheme:dark;--bg:#0E0E0D;--fg:#F2F0EA;--muted:#A3A09A;--line:#2A2926;--accent:#F7B100}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 "Golos Text",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}a{color:var(--accent)}
.top{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:28px;font-size:14px}
.top a{text-decoration:none}h1{font-family:Unbounded,sans-serif;font-weight:600;font-size:clamp(22px,5vw,30px);line-height:1.2;margin:0 0 8px}
h2{font-size:19px;margin:28px 0 8px}h3{font-size:17px;margin:22px 0 6px}.ver{color:var(--muted);font-size:14px;margin:0 0 24px}
.note{border:1px solid var(--line);border-radius:12px;padding:12px 14px;color:var(--muted);font-size:14px;margin-bottom:24px}
.ph{color:var(--muted)}.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0}
th,td{border-bottom:1px solid var(--line);padding:8px 10px 8px 0;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
li{margin:4px 0}nav.docs{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:40px;padding-top:16px;border-top:1px solid var(--line);font-size:14px}'''


def page(slug, title, body):
    nav = ''.join(f'<a href="/docs/{s}">{t}</a>' for s, (t, _) in PAGES.items() if s != slug)
    return f'''<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — центр спорта «Рекорд»</title><link rel="icon" href="/img/favicon.svg" type="image/svg+xml"><style>{CSS}</style></head>
<body><main><div class="top"><a href="/">← recordirk.ru</a><span class="ph">ООО «Центр спорта «Рекорд»</span></div>
<h1>{title}</h1><p class="ver">Редакция: {VERSION}</p>
<div class="note">Документ проходит проверку юриста. Пункты в [квадратных скобках] будут заполнены до запуска сайта.</div>
{body}
<nav class="docs">{nav}</nav></main></body></html>
'''


out = root / 'public/docs'
out.mkdir(parents=True, exist_ok=True)
for slug, (title, body) in PAGES.items():
    (out / f'{slug}.html').write_text(page(slug, title, body), encoding='utf-8')
index = '<ul>' + ''.join(f'<li><a href="/docs/{s}">{t}</a></li>' for s, (t, _) in PAGES.items()) + '</ul>'
(out / 'index.html').write_text(page('', 'Документы', index).replace('<nav class="docs">', '<nav class="docs" hidden>'), encoding='utf-8')
print('docs:', ', '.join(PAGES))
