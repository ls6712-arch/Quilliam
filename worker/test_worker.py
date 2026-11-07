import json, urllib.request, hmac, hashlib, time, base64
B="http://localhost:8787"
def post(p,b,raw=None,headers=None):
    data=raw if raw is not None else json.dumps(b).encode()
    r=urllib.request.Request(B+p,data=data,headers=headers or {"content-type":"application/json"},method="POST")
    try:
        with urllib.request.urlopen(r) as x: return x.status, json.loads(x.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")
def get(p):
    try:
        with urllib.request.urlopen(B+p) as x: return x.status, x.headers.get("content-type"), x.read()
    except urllib.error.HTTPError as e: return e.code, None, e.read()
ok=lambda c,m: print(("PASS " if c else "FAIL ")+m)
s,a=post("/api/me",{}); tok=a["token"]; ok(s==200 and a["credits"]==1,"new buyer gets 1 free letter")
s,a2=post("/api/me",{"token":tok}); ok(a2["token"]==tok,"returning buyer keeps their account")
png=base64.b64encode(bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000""1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")).decode()
s,r=post("/api/seal",{"token":tok,"image":"data:image/png;base64,"+png,"meta":{"to":"Maya","from":"Raj <b>","certified":True,"layout":"classic","paper":"Evergreen"}})
ok(s==200 and r["account"]["credits"]==0,"sealing spends the free letter"); lid=r["id"]; print("     share url:",r["url"])
s,r2=post("/api/seal",{"token":tok,"image":"data:image/png;base64,"+png,"meta":{}}); ok(s==402 and r2["error"]=="no_credits","out of letters returns 402")
s,ct,body=get("/l/"+lid); ok(s==200 and b"Raj &lt;b&gt; sent you a letter" in body and b"certified" in body,"share page renders, escapes names, shows certified")
s,ct,body=get("/img/"+lid); ok(s==200 and ct=="image/png" and body[:4]==b"\x89PNG","letter image serves")
s,ct,body=get("/l/notarealid12345"); ok(s==404,"unknown letter is 404")
s,r=post("/api/checkout",{"token":tok,"plan":"pack"}); ok(s==503 and r["error"]=="stripe_not_configured","checkout says not configured without Stripe key")
s,r=post("/api/mail-request",{"email":"a@b.co","price":"$7","occasion":"Holiday cards"}); ok(s==200,"mail request saved")
s,r=post("/api/mail-request",{"email":"nope"}); ok(s==400,"bad email rejected")
def wh(event,secret="whsec_localtestonly123",t=None):
    raw=json.dumps(event).encode(); t=t or int(time.time())
    sig=hmac.new(secret.encode(),f"{t}.".encode()+raw,hashlib.sha256).hexdigest()
    return post("/api/stripe-webhook",None,raw,{"stripe-signature":f"t={t},v1={sig}","content-type":"application/json"})
ev=lambda sid,plan:{"type":"checkout.session.completed","data":{"object":{"id":sid,"payment_status":"paid","amount_total":499,"metadata":{"token":tok,"plan":plan},"customer_details":{"email":"buyer@example.com"}}}}
s,r=wh(ev("cs_test_1","pack"),secret="whsec_wrong"); ok(s==400,"webhook with wrong signature rejected")
s,r=wh(ev("cs_test_1","pack"),t=int(time.time())-1000); ok(s==400,"webhook replayed after 5 min rejected")
s,r=wh(ev("cs_test_1","pack")); s2,a=post("/api/me",{"token":tok}); ok(s==200 and a["credits"]==10,"paid Holiday Pack adds 10 letters")
s,r=wh(ev("cs_test_one","one")); s2,a=post("/api/me",{"token":tok}); ok(s==200 and a["credits"]==11,"paid single letter ($1.99) adds exactly 1 letter")
s,r=post("/api/seal",{"token":tok,"image":"data:image/png;base64,"+png,"meta":{}}); ok(s==200 and r["account"]["credits"]==10,"single letter can be spent")
s,r=wh(ev("cs_test_1","pack")); s2,a=post("/api/me",{"token":tok}); ok(a["credits"]==10,"same payment reported twice only counts once")
s,r=wh(ev("cs_test_one","one")); s2,a=post("/api/me",{"token":tok}); ok(a["credits"]==10,"single-letter payment reported twice only counts once")
s,r=wh(ev("cs_test_2","season")); s2,a=post("/api/me",{"token":tok}); ok(a["season"] is True,"Season Pass activates")
s,r=post("/api/seal",{"token":tok,"image":"data:image/png;base64,"+png,"meta":{}}); ok(s==200 and r["account"]["credits"]==10,"Season Pass letters don't spend credits")
s,ct,body=get("/"); ok(s==200 and b"Write it by" in body and b'window.QUILLIAM_API=""' in body,"landing page served at /")
s,ct,body=get("/write"); ok(s==200 and b'id="sealbtn"' in body and b'window.QUILLIAM_API=""' in body,"app served at /write in hosted mode")
s,ct,body=get("/l/"+lid); ok(b'href="/write?to=' in body,"share page Write-back link points to /write")
s,r=post("/api/business-lead",{"name":"Dan","company":"Northbeam","email":"dan@nb.co","size":"100–250"}); ok(s==200,"business lead saved")
s,r=post("/api/business-lead",{"name":"","company":"X","email":"x@y.co"}); ok(s==400,"business lead without name rejected")
