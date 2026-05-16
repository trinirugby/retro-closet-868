/* ============================================================
   PLACE-ORDER.JS — Storefront → Dashboard order webhook

   Called by the inline submit handler in `checkout.html`. For each
   cart line, reads the current Airtable record, then PATCHes the
   sister dashboard (`trinirugby/Retro-Closet-Dashboard`) so stock
   decrements and (if stock hits 0) `in_stock` is flipped to false in
   the same atomic write — keeping the storefront's `{in_stock}=TRUE()`
   filter and the dashboard's view of stock in sync without manual
   intervention.

   The dashboard's PATCH validation (`app/api/products/[id]/route.ts`)
   is the contract surface. If that whitelist changes, mirror the
   change here in the same PR.

   v1 limitations (documented in README, not fixed here):
   • Read-modify-write race: two simultaneous buyers of the last
     unit can both succeed, leaving units_sold > initial_stock.
     Low-volume retail; seller reconciles via the dashboard.
   • No orders table — the audit trail is Netlify function logs.
   ============================================================ */

const BASE_ID = 'appcA2sFnpO4O9x7N';
const TABLE_ID = 'tblWjg7NqsZvK0otW';
const DASHBOARD_BASE = 'https://retrocloset-production.up.railway.app';

const MAX_LINES = 25;
const PER_LINE_TIMEOUT_MS = 6_000;

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

// ── Dashboard PATCH ─────────────────────────────────────────
async function patchDashboard(id, payload, signal) {
  const res = await fetch(`${DASHBOARD_BASE}/api/products/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dashboard PATCH ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json(); // { product: ... }
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
  const payload = { stock_quantity: newStock, units_sold: newSold };
  if (newStock === 0) payload.in_stock = false;

  await patchDashboard(line.id, payload, ctrl);

  return {
    id: line.id,
    name: line.name || before.name,
    requested: line.qty,
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

  // Whole-order log (audit trail until we add an Orders table).
  console.log(
    '[place-order]',
    JSON.stringify({ orderRef, customer, totals, results }),
  );

  const anyFail = results.some((r) => !r.ok);
  return json(anyFail ? 207 : 200, {
    orderRef,
    customer,
    totals,
    results,
  });
};
