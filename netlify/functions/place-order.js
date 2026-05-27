/* ============================================================
   PLACE-ORDER.JS — Storefront order handler (Airtable write-through)

   Called by the inline submit handler in `checkout.html`. For each
   cart line, reads the current Airtable record, then PATCHes Airtable
   directly so stock decrements and (if stock hits 0) `in_stock` is
   flipped to false in the same write — keeping the storefront's
   `{in_stock}=TRUE()` filter in sync without manual intervention.

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

const BASE_ID = 'appcA2sFnpO4O9x7N';
const TABLE_ID = 'tblWjg7NqsZvK0otW';
// Orders table — one record per placed order (audit trail for the seller).
const ORDERS_TABLE_ID = 'tbl7mY2r8TUhWBVgE';

const MAX_LINES = 25;
const PER_LINE_TIMEOUT_MS = 6_000;
const ORDER_WRITE_TIMEOUT_MS = 6_000;

// Maps the checkout page's radio values to the Airtable singleSelect choices.
const PAYMENT_LABELS = {
  cod: 'Pay on Delivery',
  'bank-ig': 'Online Bank Transfer',
};

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
  if (cName.length < 1 || cName.length > 120) return 'customer.name must be 1–120 chars';
  if (cPhone.length < 5 || cPhone.length > 30) return 'customer.phone must be 5–30 chars';
  if (!/^[\d+\-()\s]+$/.test(cPhone)) return 'customer.phone has invalid characters';
  if (cAddress.length < 1 || cAddress.length > 300) return 'customer.address must be 1–300 chars';
  if (cTown.length < 1 || cTown.length > 80) return 'customer.town must be 1–80 chars';

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
  return {
    stock_quantity: typeof f.stock_quantity === 'number' ? f.stock_quantity : 0,
    units_sold: typeof f.units_sold === 'number' ? f.units_sold : 0,
    in_stock: f.in_stock === true,
    name: f.Name || '',
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

// One human-readable line per successfully-reserved item.
function summariseItems(results) {
  return results
    .filter((r) => r.ok)
    .map((r) => `${r.requested}× ${r.name || r.id} @ TTD $${(r.price ?? 0).toLocaleString()}`)
    .join('\n');
}

// ── Per-line worker ────────────────────────────────────────
async function processLine(apiKey, line) {
  // Single AbortController bounds both the read and the patch combined.
  const ctrl = AbortSignal.timeout(PER_LINE_TIMEOUT_MS);

  const before = await fetchRecord(apiKey, line.id, ctrl);

  if (before.stock_quantity < line.qty) {
    return {
      id: line.id,
      name: line.name || before.name,
      requested: line.qty,
      before,
      after: null,
      ok: false,
      error:
        before.stock_quantity === 0
          ? 'Sold out'
          : `Only ${before.stock_quantity} left`,
    };
  }

  const newStock = before.stock_quantity - line.qty;
  const newSold = before.units_sold + line.qty;
  const fields = { stock_quantity: newStock, units_sold: newSold };
  if (newStock === 0) fields.in_stock = false;

  await patchAirtable(apiKey, line.id, fields, ctrl);

  return {
    id: line.id,
    name: line.name || before.name,
    requested: line.qty,
    price: line.price,
    before,
    after: { stock_quantity: newStock, units_sold: newSold },
    ok: true,
  };
}

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

  const { customer, cart, totals } = body;
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
  if (anyOk) {
    const paymentLabel = PAYMENT_LABELS[body.payment] || PAYMENT_LABELS.cod;
    try {
      const order = await createOrder(
        apiKey,
        {
          'Order Ref': orderRef,
          'Placed At': new Date().toISOString(),
          'Customer Name': customer.name,
          Phone: customer.phone,
          Address: customer.address,
          Town: customer.town,
          Notes: customer.notes || '',
          'Payment Method': paymentLabel,
          Items: summariseItems(results),
          Subtotal: totals.subtotal,
          Delivery: totals.delivery,
          Total: totals.total,
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
    JSON.stringify({ orderRef, customer, payment: body.payment || 'cod', totals, results }),
  );

  const anyFail = results.some((r) => !r.ok);
  return json(anyFail ? 207 : 200, {
    orderRef,
    customer,
    totals,
    results,
  });
};
