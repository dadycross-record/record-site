"""Build public/index.html from src/index.src.html (images are served as files, not inlined)."""
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
s = (root / 'src/index.src.html').read_text(encoding='utf-8')
for k, v in {'__HERO__': '/img/hero.jpg', '__COMP__': '/img/comp.jpg', '__C1__': '/img/coach1.jpg', '__C2__': '/img/coach2.jpg', '__C3__': '/img/coach3.jpg'}.items():
    s = s.replace(k, v)
head = '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="theme-color" content="#0E0E0D">\n'
i = s.index('<div id="app">')
out = head + s[:i] + '</head>\n<body>\n' + s[i:] + '\n</body>\n</html>\n'
out = out.replace('<style>', '<style>\nhtml{color-scheme:dark}body{margin:0;background:#070707}img{max-width:100%}[hidden]{display:none!important}\n', 1)
(root / 'public/index.html').write_text(out, encoding='utf-8')
print('public/index.html', len(out))
