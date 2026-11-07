# Copies the code shared by the app and the server into app.html:
#   sealgen.js  (wax seals)          between /*SEALGEN-START*/ and /*SEALGEN-END*/
#   inkcheck.js (handwriting check)  between /*INKCHECK-START*/ and /*INKCHECK-END*/
# If app.html doesn't have a block yet, it is added just before the app's Boot section.
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
app = (root / "app.html").read_text()
for name, src in [("SEALGEN", "sealgen.js"), ("INKCHECK", "inkcheck.js")]:
    a, b = f"/*{name}-START*/", f"/*{name}-END*/"
    text = (root / src).read_text()
    block = text[text.index(a):text.index(b) + len(b)]
    if a in app:
        app = app[:app.index(a)] + block + app[app.index(b) + len(b):]
    else:
        boot = "/* ================= Boot ================= */"
        app = app.replace(boot, block + "\n" + boot, 1)
(root / "app.html").write_text(app)
print("app.html shared code synced")
