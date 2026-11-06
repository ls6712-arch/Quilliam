# Quilliam

Handwritten letters, certified human. Write a letter by hand on holiday paper, press a wax seal and send it as a link. Quilliam the owl stamps every letter a real person wrote.

## What's here

| Path | What it is |
| --- | --- |
| `landing.html` | The marketing website, served at `/` |
| `app.html` | The letter-writing app, served at `/write` |
| `worker/src/worker.template.js` | Cloudflare Worker: pages, Stripe checkout and webhook, letter credits, share links, waitlist and business leads |
| `worker/build.py` | Builds `worker/worker.js` by inlining both HTML pages into the template |
| `worker/worker.js` | The built Worker. Paste this into the Cloudflare editor, or deploy it with Wrangler |
| `worker/wrangler.toml` | Wrangler config with the D1 and KV bindings |
| `worker/schema.sql` | Database tables |
| `worker/test_worker.py` | End-to-end tests against a local Worker |

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | Website |
| `GET /write` | Writing app (`?to=Name` prefills the recipient, `?plans=1` opens pricing) |
| `GET /l/:id` | Shared letter page with a "Write one back" button |
| `GET /img/:id` | Sealed letter image |
| `GET /api/health` | Shows which bindings and secrets are connected |
| `POST /api/me` | Creates or loads a buyer and their letter balance |
| `POST /api/checkout` | Opens Stripe Checkout for `pack` ($4.99, 10 letters) or `season` ($9.99, unlimited until Jan 1) |
| `POST /api/confirm` | Confirms a paid Checkout Session after redirect |
| `POST /api/stripe-webhook` | Stripe webhook (signature verified, each payment counted once) |
| `POST /api/seal` | Spends a letter, stores the image, returns the share link |
| `POST /api/mail-request` | Mailed-letter waitlist |
| `POST /api/business-lead` | Business quote requests |

## Deploy

Bindings: D1 database `quilliam` as `DB`, KV namespace `quilliam-letters` as `LETTERS`.
Secrets: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (set in Cloudflare, never committed).

```sh
cd worker
python3 build.py                                  # rebuild after editing either HTML page
npx wrangler d1 execute quilliam --remote --file schema.sql   # first time only
npx wrangler deploy
```

Without Wrangler: create a Worker named `quilliam` in the Cloudflare dashboard, paste `worker/worker.js` into its editor, deploy, then add the two bindings under **Bindings**.

## Test locally

```sh
cd worker
printf 'STRIPE_WEBHOOK_SECRET="whsec_localtestonly123"\n' > .dev.vars
npx wrangler d1 execute quilliam --local --file schema.sql
npx wrangler dev --local --port 8787 &
python3 test_worker.py
```

The tests reuse fixed payment IDs, so clear the local tables before rerunning them.
