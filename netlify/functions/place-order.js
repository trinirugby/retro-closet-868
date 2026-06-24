/* ============================================================
   PLACE-ORDER.JS — Storefront order handler (Airtable write-through)

   Called by the inline submit handler in `checkout.html`. For each
   cart line, reads the current Airtable record, then PATCHes Airtable
   directly so the per-size and aggregate stock columns decrement. The
   base's `in_stock` checkbox is not maintained; `calculated_stock_quantity`
   is a formula over the per-size columns, so the storefront's
   `{calculated_stock_quantity}>0` filter stays correct on its own.

   History: writes used to go through the sister dashboard
   (`trinirugby/Retro-Closet-Dashboard` on Railway). That service was
   decommissioned (Railway returns 404 "Application not found"), which
   broke checkout, so the storefront now writes straight to Airtable.
   `AIRTABLE_API_KEY` already carries `data.records:write` scope. If the
   dashboard is ever redeployed it reads/writes the same base, so the
   two stay consistent.

   After stock is committed, the order is also recorded as a row in
   the Airtable `Orders` table (customer, items, totals, payment
   method) so the seller has a proper order history, not just logs.
   That write is best-effort: if it fails, stock is still committed
   and the failure is logged for manual reconciliation.

   v1 limitations (documented in README, not fixed here):
   • Read-modify-write race: two simultaneous buyers of the last
     unit can both succeed, leaving units_sold > initial_stock.
     Low-volume retail; seller reconciles in Airtable.
   ============================================================ */

const BASE_ID = 'appOvsTaUDIkXqF17';
const TABLE_ID = 'tblWjg7NqsZvK0otW';
// Orders table — one record per placed order (audit trail for the seller).
const ORDERS_TABLE_ID = 'tbl7mY2r8TUhWBVgE';
// Delivery Locations table — the courier rate card (area → fee). Read here so
// the charged delivery fee is authoritative, never trusted from the client.
const LOCATIONS_TABLE_ID = 'tblBjtLDlEKnPlX4y';

// Per-size stock/sold columns on the Products table. The `sizes` field the
// storefront reads is an Airtable formula derived purely from these stock_<size>
// columns (a size is "listed" only while its column is > 0), so per-size stock —
// not the aggregate stock_quantity — is the authoritative gate for a given size.
const SIZE_COLUMNS = {
  XS:  { stock: 'stock_xs',  sold: 'sold_xs'  },
  S:   { stock: 'stock_s',   sold: 'sold_s'   },
  M:   { stock: 'stock_m',   sold: 'sold_m'   },
  L:   { stock: 'stock_l',   sold: 'sold_l'   },
  XL:  { stock: 'stock_xl',  sold: 'sold_xl'  },
  XXL: { stock: 'stock_xxl', sold: 'sold_xxl' },
};

/** Normalises a client size to the canonical label used as a SIZE_COLUMNS key
 *  (e.g. " m " → "M"). Empty string when no size was supplied. */
function normaliseSize(size) {
  return (size ?? '').toString().trim().toUpperCase();
}

const MAX_LINES = 25;
const PER_LINE_TIMEOUT_MS = 6_000;
const ORDER_WRITE_TIMEOUT_MS = 6_000;
const RATES_TIMEOUT_MS = 6_000;

// Delivery is priced per area from the Delivery Locations table (mirrors
// checkout.html). Areas not on the rate card — including the "Other" option —
// are recorded with no fee (0) for the seller to confirm before dispatch.
const DELIVERY_TBD = 0;

// Maps the checkout page's radio values to the Airtable singleSelect choices.
const PAYMENT_LABELS = {
  cod: 'Pay on Delivery',
  'bank-ig': 'Online Bank Transfer',
};

// Discount codes → flat TTD amount off the subtotal. Reusable, no expiry.
// Server-side is the source of truth: the client can request a code but the
// amount is decided here, so totals can't be tampered with.
const DISCOUNT_CODES = {
  RC868X7: 50,
};

/** Resolves a (possibly missing) client code to an authoritative discount,
 *  capped so it never exceeds the subtotal. Returns { code, amount }. */
function resolveDiscount(rawCode, subtotal) {
  const code = (rawCode ?? '').toString().trim().toUpperCase();
  const value = DISCOUNT_CODES[code];
  if (value == null) return { code: '', amount: 0 };
  return { code, amount: Math.min(value, Math.max(0, subtotal)) };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Cheap order reference for the seller to grep Netlify logs by. */
function makeOrderRef() {
  return `RC-${Date.now().toString(36).toUpperCase()}`;
}

// ── Validation ──────────────────────────────────────────────
function validateOrder(body) {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object';

  const { customer, cart, totals } = body;

  if (!customer || typeof customer !== 'object') return 'customer is required';
  const cName = (customer.name ?? '').toString().trim();
  const cPhone = (customer.phone ?? '').toString().trim();
  const cAddress = (customer.address ?? '').toString().trim();
  const cTown = (customer.town ?? '').toString().trim();
  const cEmail = (customer.email ?? '').toString().trim();
  if (cName.length < 1 || cName.length > 120) return 'customer.name must be 1–120 chars';
  if (cPhone.length < 5 || cPhone.length > 30) return 'customer.phone must be 5–30 chars';
  if (!/^[\d+\-()\s]+$/.test(cPhone)) return 'customer.phone has invalid characters';
  if (cAddress.length < 1 || cAddress.length > 300) return 'customer.address must be 1–300 chars';
  if (cTown.length < 1 || cTown.length > 80) return 'customer.town must be 1–80 chars';
  // Email is optional for now (confirmation automation not yet live); when
  // provided it's captured on the order, so validate the format only if present.
  if (cEmail) {
    if (cEmail.length < 5 || cEmail.length > 120) return 'customer.email must be 5–120 chars';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cEmail)) return 'customer.email is not a valid email address';
  }

  if (!Array.isArray(cart)) return 'cart must be an array';
  if (cart.length < 1) return 'cart is empty';
  if (cart.length > MAX_LINES) return `cart cannot exceed ${MAX_LINES} lines`;

  for (let i = 0; i < cart.length; i++) {
    const line = cart[i];
    if (!line || typeof line !== 'object') return `cart[${i}] must be an object`;
    if (typeof line.id !== 'string' || !line.id.startsWith('rec')) {
      return `cart[${i}].id must be an Airtable record id (starts with 'rec')`;
    }
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > 99) {
      return `cart[${i}].qty must be an integer 1–99`;
    }
    if (typeof line.name !== 'string') return `cart[${i}].name must be a string`;
    if (typeof line.price !== 'number' || line.price < 0) {
      return `cart[${i}].price must be a non-negative number`;
    }
    // Size is optional (older clients may omit it) but bounded when present.
    if (line.size != null && (typeof line.size !== 'string' || line.size.length > 40)) {
      return `cart[${i}].size must be a string up to 40 chars`;
    }
  }

  if (!totals || typeof totals !== 'object') return 'totals is required';
  for (const k of ['subtotal', 'delivery', 'total']) {
    if (typeof totals[k] !== 'number' || totals[k] < 0) {
      return `totals.${k} must be a non-negative number`;
    }
  }

  // payment is optional for backward compatibility; default applied later.
  if (body.payment != null && !(body.payment in PAYMENT_LABELS)) {
    return `payment must be one of: ${Object.keys(PAYMENT_LABELS).join(', ')}`;
  }

  // discountCode is optional; just bound the type/length. An unknown code is
  // not an error — it simply yields no discount (resolveDiscount handles it).
  if (body.discountCode != null) {
    if (typeof body.discountCode !== 'string' || body.discountCode.length > 40) {
      return 'discountCode must be a string up to 40 chars';
    }
  }

  return null;
}

// ── Airtable read (single record, by field name) ────────────
async function fetchRecord(apiKey, id, signal) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}/${id}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (res.status === 404) {
    const err = new Error('Product no longer exists');
    err.notFound = true;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Airtable read ${res.status}: ${text.slice(0, 200)}`);
  }
  const rec = await res.json();
  const f = rec.fields || {};
  const num = (v) => (typeof v === 'number' ? v : 0);
  // Read the per-size stock/sold columns alongside the aggregate so a single
  // size can be gated and decremented independently of the total.
  const sizeStock = {};
  const sizeSold = {};
  for (const [label, col] of Object.entries(SIZE_COLUMNS)) {
    sizeStock[label] = num(f[col.stock]);
    sizeSold[label] = num(f[col.sold]);
  }
  return {
    stock_quantity: num(f.stock_quantity),
    units_sold: num(f.units_sold),
    in_stock: f.in_stock === true,
    name: f.Name || '',
    sizeStock,
    sizeSold,
  };
}

// ── Airtable PATCH (direct write) ───────────────────────────
async function patchAirtable(apiKey, id, fields, signal) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}/${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Airtable write ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Airtable POST (create order record) ─────────────────────
async function createOrder(apiKey, fields, signal) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${ORDERS_TABLE_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields, typecast: true }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Airtable order write ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Airtable read (delivery rate card) ──────────────────────
/** Fetches the active delivery areas as a Map of normalised name → fee (TTD).
 *  Names are lowercased+trimmed so client/Airtable spacing/case can't cause a
 *  mismatch. Returns an empty Map on any failure — callers treat a miss as
 *  "fee to be confirmed" rather than failing an already-committed order. */
async function fetchDeliveryRates(apiKey, signal) {
  const rates = new Map();
  let offset = null;
  do {
    const params = new URLSearchParams({
      filterByFormula: '{Active}=TRUE()',
      pageSize: '100',
    });
    ['Location', 'Price'].forEach((f) => params.append('fields[]', f));
    if (offset) params.set('offset', offset);

    const url = `https://api.airtable.com/v0/${BASE_ID}/${LOCATIONS_TABLE_ID}?${params}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Airtable rates read ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    for (const rec of data.records) {
      const f = rec.fields || {};
      const name = (f.Location || '').toString().trim().toLowerCase();
      if (name && typeof f.Price === 'number') rates.set(name, f.Price);
    }
    offset = data.offset || null;
  } while (offset);
  return rates;
}

/** Resolves a (possibly missing) area name to an authoritative delivery fee.
 *  Unknown areas and the "Other" option resolve to DELIVERY_TBD (0). */
function resolveDelivery(rates, town) {
  const key = (town ?? '').toString().trim().toLowerCase();
  if (!key || key === 'other') return DELIVERY_TBD;
  const fee = rates.get(key);
  return typeof fee === 'number' ? fee : DELIVERY_TBD;
}

// One human-readable line per successfully-reserved item.
function summariseItems(results) {
  return results
    .filter((r) => r.ok)
    .map((r) => {
      const sz = r.size ? ` — Size ${r.size}` : '';
      return `${r.requested}× ${r.name || r.id}${sz} @ TTD $${(r.price ?? 0).toLocaleString()}`;
    })
    .join('\n');
}

// ── Per-line worker ────────────────────────────────────────
async function processLine(apiKey, line) {
  // Single AbortController bounds both the read and the patch combined.
  const ctrl = AbortSignal.timeout(PER_LINE_TIMEOUT_MS);

  const before = await fetchRecord(apiKey, line.id, ctrl);

  const size = normaliseSize(line.size);
  const column = size ? SIZE_COLUMNS[size] : null;

  const fail = (error) => ({
    id: line.id,
    name: line.name || before.name,
    size: line.size || '',
    requested: line.qty,
    before,
    after: null,
    ok: false,
    error,
  });

  // A size we don't recognise has no stock column to honour, so it can never
  // be "listed" — reject rather than fall through to the aggregate gate.
  if (size && !column) return fail('That size is unavailable');

  // Authoritative availability: the requested size's own stock when a size was
  // supplied, otherwise the aggregate (older clients may omit size entirely).
  // This is the fix for the oversell bug — a size sold out at the per-size
  // level is rejected even while other sizes keep the aggregate above zero.
  const available = column ? before.sizeStock[size] : before.stock_quantity;
  if (available < line.qty) {
    return fail(available === 0 ? 'Sold out' : `Only ${available} left`);
  }

  // Decrement the per-size column (when known) AND the aggregate in the same
  // write, so the `sizes` formula and calculated_stock_quantity stay truthful
  // after every sale instead of drifting out of sync. We don't touch the
  // `in_stock` checkbox (it isn't maintained here) — calculated_stock_quantity
  // is a formula over the per-size columns, so it (and the catalogue's filter)
  // update on their own.
  const newStock = Math.max(0, before.stock_quantity - line.qty);
  const newSold = before.units_sold + line.qty;
  const fields = { stock_quantity: newStock, units_sold: newSold };
  if (column) {
    fields[column.stock] = Math.max(0, before.sizeStock[size] - line.qty);
    fields[column.sold] = before.sizeSold[size] + line.qty;
  }

  await patchAirtable(apiKey, line.id, fields, ctrl);

  return {
    id: line.id,
    name: line.name || before.name,
    size: line.size || '',
    requested: line.qty,
    price: line.price,
    before,
    after: fields,
    ok: true,
  };
}

// Exposed for unit tests (place-order.test.js). Not used by the handler path.
exports.processLine = processLine;
exports.validateOrder = validateOrder;

// ── Handler ────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) return json(500, { error: 'AIRTABLE_API_KEY not set' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Body must be JSON' });
  }

  const validationError = validateOrder(body);
  if (validationError) return json(400, { error: validationError });

  const { customer, cart } = body;
  const orderRef = makeOrderRef();

  // Parallel per-line: Promise.allSettled so one slow/failed line doesn't
  // poison the others. Per-line timeout bounds total wall time even on
  // Netlify's free-tier 10s function cap (worst case ≈ PER_LINE_TIMEOUT_MS).
  const settled = await Promise.allSettled(cart.map((line) => processLine(apiKey, line)));
  const results = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const line = cart[i];
    return {
      id: line.id,
      name: line.name || '',
      size: line.size || '',
      requested: line.qty,
      before: null,
      after: null,
      ok: false,
      error:
        s.reason?.name === 'TimeoutError'
          ? 'Timed out reserving stock — please retry'
          : s.reason?.message || 'Unknown error',
    };
  });

  const anyOk = results.some((r) => r.ok);

  // Record the order in Airtable (best-effort). Only when at least one line
  // was reserved — a fully-failed attempt sold nothing. A write failure here
  // must NOT fail the response: stock is already committed, so we log and move
  // on rather than telling the customer their paid-for order failed.
  //
  // Money is recomputed server-side from the lines that ACTUALLY reserved
  // (r.ok), never from the client's `totals`. On a partial failure the client
  // subtotal still counts the lines that sold out, which would record a total
  // for items the customer isn't getting (always an overcharge). Pricing the
  // order off the reserved lines keeps Total in lockstep with the Items list.
  // Discount and delivery are both resolved server-side: discount from the
  // code, delivery from the courier rate card keyed on the customer's area.
  const reservedSubtotal = results
    .filter((r) => r.ok)
    .reduce((s, r) => s + (r.price ?? 0) * r.requested, 0);
  const discount = resolveDiscount(body.discountCode, reservedSubtotal);

  // Best-effort rate-card read. Stock is already committed by this point, so a
  // failure here must not fail the order — fall back to "fee to be confirmed"
  // (0) and log loudly for the seller, matching the order-write philosophy.
  let rates = new Map();
  try {
    rates = await fetchDeliveryRates(apiKey, AbortSignal.timeout(RATES_TIMEOUT_MS));
  } catch (err) {
    console.error('[place-order] DELIVERY RATES READ FAILED', orderRef, err?.message || err);
  }
  const reservedDelivery = resolveDelivery(rates, customer.town);
  const recordedTotal = reservedSubtotal - discount.amount + reservedDelivery;
  // Authoritative totals (reserved lines only) — used for the record, log,
  // and response so all three agree with the Items list.
  const recordedTotals = {
    subtotal: reservedSubtotal,
    delivery: reservedDelivery,
    total: recordedTotal,
  };

  if (anyOk) {
    const paymentLabel = PAYMENT_LABELS[body.payment] || PAYMENT_LABELS.cod;
    try {
      const order = await createOrder(
        apiKey,
        {
          'Order Ref': orderRef,
          'Placed At': new Date().toISOString(),
          'Customer Name': customer.name,
          Email: customer.email || '',
          Phone: customer.phone,
          Address: customer.address,
          Town: customer.town,
          Notes: customer.notes || '',
          'Payment Method': paymentLabel,
          Items: summariseItems(results),
          // Dedicated, filterable column mirroring the sizes embedded in Items
          // (comma-separated, in line order, for multi-item orders).
          Size: results.filter((r) => r.ok && r.size).map((r) => r.size).join(', '),
          Subtotal: reservedSubtotal,
          'Discount Code': discount.code,
          Discount: discount.amount,
          Delivery: reservedDelivery,
          Total: recordedTotal,
          Status: 'New',
        },
        AbortSignal.timeout(ORDER_WRITE_TIMEOUT_MS),
      );
      console.log('[place-order] order recorded', orderRef, order?.id || '');
    } catch (err) {
      // Surface loudly in logs so the seller can reconcile manually.
      console.error('[place-order] ORDER RECORD FAILED', orderRef, err?.message || err);
    }
  }

  // Whole-order log (full audit trail, including failed lines).
  console.log(
    '[place-order]',
    JSON.stringify({
      orderRef,
      customer,
      payment: body.payment || 'cod',
      discount,
      totals: recordedTotals,
      results,
    }),
  );

  const anyFail = results.some((r) => !r.ok);
  return json(anyFail ? 207 : 200, {
    orderRef,
    customer,
    discount,
    totals: recordedTotals,
    results,
  });
};
