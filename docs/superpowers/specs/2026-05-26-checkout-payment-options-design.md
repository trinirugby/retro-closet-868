# Checkout Payment Options — Design

**Date:** 2026-05-26
**Status:** Implemented. **Revised down to 2 options** at the owner's request — *Pay on
Delivery* and *Online Bank Transfer → Instagram* only. The WhatsApp and in-site upload
(Netlify Forms) options below were dropped, so no Netlify Forms setup is needed. Bank
details are now hardcoded (Republic Bank / Jesse Hospedales / Checking / 340061150001),
not placeholders. The sections below describe the original 4-option design for history.

## Goal

The current `checkout.html` reserves stock via `/api/place-order` and shows a single
generic "Pay on WhatsApp" confirmation. Replace the disabled "WiPay coming soon"
placeholder with **four customer-selectable payment-instruction options**. No card
processing, no Shopify, no new backend — payment is arranged out-of-band; the site only
tells the customer what to do after the order (and its stock reservation) succeeds.

Out of scope (explicitly deferred): order tracker / order-status lookup (would require an
orders table the project does not yet have).

## The four options (radio buttons on the form)

| value         | Label                          | Post-order confirmation shows |
| ------------- | ------------------------------ | ----------------------------- |
| `cod`         | Pay on Delivery                | "Pay cash or card on delivery; we'll WhatsApp to arrange." |
| `bank-ig`     | Bank Transfer → Instagram      | Bank details + "DM your screenshot to @retrocloset868." |
| `bank-wa`     | Bank Transfer → WhatsApp       | Bank details + "Send proof on WhatsApp" button (`wa.me` pre-filled with order ref + total; customer attaches screenshot themselves). |
| `bank-upload` | Bank Transfer → Upload Proof   | Bank details + in-site file upload → **Netlify Forms** delivers screenshot + order details to the owner's email for authorization. |

## Flow

1. Customer fills contact/delivery form + picks a payment method.
2. Submit → existing `/api/place-order` runs unchanged (validates, decrements Airtable
   stock via the dashboard, returns `orderRef`). Partial-failure (207) handling unchanged.
3. On full success → hide the form, render a **method-specific confirmation panel** keyed
   off the selected radio, carrying `orderRef`, customer name/phone, and total.

## Architecture decisions

- **All changes live in `checkout.html`** (markup + inline `<script>`) plus a CSS block in
  `css/styles.css`. `place-order.js` and `get-products.js` are untouched.
- **Option 4 delivery = Netlify Forms** (native to the existing Netlify host): a real
  `<form data-netlify="true" enctype="multipart/form-data">` is present in the static HTML
  (hidden until needed) so Netlify's build-time scanner registers it. Submitted via `fetch`
  as `FormData`. Hidden fields (`orderRef`, `name`, `phone`, `total`) are populated by JS
  before submit. The owner's notification email is configured in the Netlify dashboard
  (Forms → Notifications), NOT in code — no secret added to the repo.
- **"Direct to WhatsApp" is not possible** for an uploaded image without Meta's paid
  WhatsApp Business API. Option 3 therefore opens `wa.me` pre-filled and the customer
  attaches the screenshot; option 4 routes the uploaded file to the owner via email.

## Placeholders (owner fills in later)

- `BANK_DETAILS` — bank name, account name, account number, account type/branch.
- `OWNER_WHATSAPP` — international format, digits only (e.g. `1868XXXXXXX`).
- `INSTAGRAM_HANDLE` — already `retrocloset868`.
- Netlify form notification recipient — set in Netlify dashboard, not code.

## Testing

- `netlify dev` locally; walk each of the 4 options through to its confirmation panel.
- Verify empty-cart redirect, validation, and 207 partial-failure paths still behave.
- Option 4 upload submission verified against the Netlify Forms endpoint (or a local stub).

## Known limitations (carried from v1)

- Read-modify-write stock race, no orders table, dashboard cold-start — all unchanged and
  documented in README. This feature adds none of its own backend state.
