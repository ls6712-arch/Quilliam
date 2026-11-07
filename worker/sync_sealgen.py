# Copies the wax-seal generator from sealgen.js into app.html (between the SEALGEN markers).
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src = (root / "sealgen.js").read_text()
a, b = "/*SEALGEN-START*/", "/*SEALGEN-END*/"
block = src[src.index(a):src.index(b) + len(b)]
app = (root / "app.html").read_text()
app = app[:app.index(a)] + block + app[app.index(b) + len(b):]
(root / "app.html").write_text(app)
print("app.html seal generator synced")
