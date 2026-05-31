# Retro Closet 868

Public storefront for **Retro Closet 868** — retro football jerseys from Trinidad & Tobago. Static HTML/CSS/JS plus a small set of Netlify Functions for the Airtable-backed catalogue and checkout.

Live: <https://retrocloset.org> · Instagram: [@retrocloset868](https://instagram.com/retrocloset868)

## Stack

- Vanilla HTML + CSS + ES modules (no build step for the HTML).
- Netlify Functions (Node 20, CommonJS) for serverless endpoints.
- Hosting: Netlify (auto-deploys from `main`).
- Source of truth for product data: **Airtable** base `appcA2sFnpO4O9x7N`, table `tblWjg7NqsZvK0otW` (Products) — the same base the sister dashboard repo reads/writes.

## Layout

```
.
├── index.html / catalogue.html / about.html / cart.html / checkout.html
├── css/styles.css            single-file design system
├── js/
│   ├── main.js               nav, scroll, reveal, toast
│   ├── catalogue.js          fetch + filter + render product grid
│   └── cart.js               cart state + sidebar + localStorage
├── netlify/
│   └── functions/
│       ├── get-products.js   GET /api/get-products  → Airtable read
│       └── place-order.js    POST /api/place-order  → dashboard write-through
├── netlify.toml              redirects /api/* → /.netlify/functions/*
└── images/
```

## Local dev

```bash
npm install -g netlify-cli   # one-time
netlify dev                  # http://localhost:8888
```

`netlify dev` serves the static site and runs the functions locally. Functions read `AIRTABLE_API_KEY` from your `.env` file (gitignored) or from your linked Netlify site's env vars.

```bash
# .env (gitignored)
AIRTABLE_API_KEY=patxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Environment variables

| Key | Used by | Notes |
| --- | --- | --- |
| `AIRTABLE_API_KEY` | both functions | Airtable PAT. Scopes: `data.records:read` (catalogue) + `data.records:write` (place-order, to update its own copy isn't strictly used today but required to read fields the dashboard writes to). |

The storefront does **not** need its own write scope for the dashboard — `place-order.js` calls the dashboard's public PATCH endpoint, which uses the dashboard's own Airtable PAT.

## Sync contract with the dashboard

The dashboard repo `trinirugby/Retro-Closet-Dashboard` (private, deployed to <https://retrocloset-production.up.railway.app/>) owns all writes to Airtable. The storefront:

1. **Reads** Airtable directly via `netlify/functions/get-products.js`. Filter: `{in_stock}=TRUE()`, so anything the dashboard toggles off disappears from the catalogue on the next page load.
2. **Writes** stock decrements via the dashboard's HTTP API:

   ```
   POST  /api/place-order                   (this repo)
     ↓ for each cart line, in parallel
   PATCH https://retrocloset-production.up.railway.app/api/products/<recordId>
         { stock_quantity: before - qty, units_sold: before + qty,
           in_stock: false   ← only when new stock_quantity === 0 }
   ```

   `<recordId>` is the Airtable record id stored on each cart line by `cart.js` (`item.id`). The dashboard's PATCH validation (in `app/api/products/[id]/route.ts` over in the dashboard repo) is the **contract surface** — its validation whitelist and field semantics must stay backward-compatible with what `place-order.js` sends.

### Response shape (`POST /api/place-order`)

```json
{
  "orderRef": "RC-AB12CD",
  "customer": { "name": "...", "phone": "...", "address": "...", "town": "...", "notes": "..." },
  "totals":   { "subtotal": 700, "delivery": 0, "total": 700 },
  "results": [
    { "id": "rec...", "name": "...", "requested": 1,
      "before": { "stock_quantity": 3, "units_sold": 4, "in_stock": true, "name": "..." },
      "after":  { "stock_quantity": 2, "units_sold": 5 },
      "ok": true },
    { "id": "rec...", "name": "...", "requested": 2,
      "before": { "stock_quantity": 1, ... }, "after": null,
      "ok": false, "error": "Only 1 left" }
  ]
}
```

HTTP status: `200` if every line succeeded, `207 Multi-Status` if any failed. The checkout client prunes the local cart to remove succeeded lines on a 207 so a retry doesn't double-decrement.

### Known limitations (v1)

- **Read-modify-write race.** Two buyers placing orders for the last unit at the same time can both succeed (each reads `stock=1` before either writes). `units_sold > initial_stock` is the telltale; reconcile via the dashboard. Low-volume retail, acceptable cost.
- **Orders are recorded in Airtable.** Each placed order writes a row to the Orders table (customer name, email, phone, address, payment method, items, totals). The chosen **size** is recorded twice: in its own filterable `Size` column (comma-separated for multi-item orders) and inline in the `Items` text (e.g. `1× Brazil Fan Edition — Size S @ TTD $350`). The Netlify function logs (`console.log('[place-order]', ...)`) remain a secondary audit trail — search by `orderRef` (e.g. `RC-AB12CD`). If the order-row write fails, stock is still committed; the failure is logged as `ORDER RECORD FAILED` for manual reconciliation. (Orders placed before this fix have no recorded size — the value was never stored or logged and can only be recovered by asking the customer.)
- **Customer email (optional, capture only).** Checkout has an optional email field; when provided it's stored on the order (`Orders.Email`). The automated customer confirmation is **not yet live** — wiring the Airtable "record created → send email" automation is a pending follow-up. The seller still gets their own notification automation.
- **No per-size inventory.** Stock is tracked per product, not per size — the size is recorded on the order but does not decrement a size-specific count.
- **No WhatsApp deep link.** The post-checkout confirmation is shown inline; the seller follows up on WhatsApp manually using the phone from the form.
- **Dashboard cold-start.** Railway free tier can take 5–15s to wake. Each cart line is bounded by a 6s read+patch timeout; long cart + cold start could 207 a few lines. Storefront preserves the unfulfilled lines for retry.

## API

| Path | Method | Body | Returns |
| --- | --- | --- | --- |
| `/api/get-products` | GET | — | `{ products: [{ id, name, league, price, sizes, inStock, imageFront, imageBack, badge, description, stockQuantity }] }` |
| `/api/place-order`  | POST | `{ customer, cart, totals }` (see Sync contract) | `{ orderRef, customer, totals, results }` |

## Checkout payment options

`checkout.html` does **not** process card payments. After `/api/place-order` reserves
stock, the customer picks one of two methods and sees a matching confirmation panel:

| Method | What the customer sees |
| --- | --- |
| **Pay on Delivery** | "Your order is confirmed. Pay cash or card when your order arrives; we'll WhatsApp you to arrange delivery." |
| **Online Bank Transfer** | Bank transfer details + amount + confirmation ref, and a note/button to send the payment receipt to Instagram. |

The bank details and Instagram handle are plain constants at the top of the inline
`<script>` in `checkout.html` (`BANK_DETAILS`, `INSTAGRAM_HANDLE`) — display-only, no
secrets. Update them there if the account or handle changes.

## Deploy

Push to `main` → Netlify auto-deploys. `AIRTABLE_API_KEY` must be set in the Netlify site's **Site settings → Environment variables**.

## Related

- **Dashboard repo:** [`trinirugby/Retro-Closet-Dashboard`](https://github.com/trinirugby/Retro-Closet-Dashboard) (private). The seller-side stock-management UI for the same Airtable base.
- **Airtable base:** `appcA2sFnpO4O9x7N` / table `tblWjg7NqsZvK0otW`.
