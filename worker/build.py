# Builds worker/worker.js (one paste-able file) from landing.html + app.html + src/worker.template.js
import json, pathlib

root = pathlib.Path(__file__).resolve().parent


def wrap(body, og_title, og_desc):
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            f'<meta property="og:title" content="{og_title}">'
            f'<meta property="og:description" content="{og_desc}">'
            '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
            'body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style>'
            '<script>window.QUILLIAM_API="";</script></head><body>' + body + '</body></html>')


def enc(html):
    return json.dumps(html, ensure_ascii=False).replace("</script", "<\\/script")


app = (root.parent / "app.html").read_text()
landing = (root.parent / "landing.html").read_text()
tpl = (root / "src" / "worker.template.js").read_text()

out = (tpl
       .replace("__APP_HTML__", enc(wrap(app, "Write a letter on Quilliam",
                                         "Write by hand, seal it in wax, send it with a link.")))
       .replace("__LANDING_HTML__", enc(wrap(landing, "Quilliam: handwritten letters, certified human",
                                             "Write a letter by hand on holiday paper, seal it in wax and send it as a link. "
                                             "Quilliam the owl certifies every letter a real person wrote."))))
(root / "worker.js").write_text(out)
print("worker.js", len(out.encode()), "bytes")
