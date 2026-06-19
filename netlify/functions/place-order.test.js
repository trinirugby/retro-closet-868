/* ============================================================
   PLACE-ORDER.TEST.JS — size-aware stock gating

   Run: `node --test netlify/functions/place-order.test.js`
   (Node 18+; uses built-in node:test + global fetch — no deps).

   These tests pin the behaviour that fixes the reported bug:
   a size must not be orderable unless its own per-size stock
   column (`stock_<size>`) covers the quantity — the aggregate
   `stock_quantity` is NOT a valid gate for a single size.
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');

const { processLine } = require('./place-order.js');

// Stubs global fetch: GET returns the given product fields; PATCH bodies are
// captured so a test can assert exactly what was written back to Airtable.
function mockAirtable(productFields) {
  const patches = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'rec1', fields: productFields }),
        text: async () => '',
      };
    }
    if (method === 'PATCH') {
      patches.push(JSON.parse(opts.body).fields);
      return { ok: true, status: 200, json: async () => ({ id: 'rec1', fields: {} }), text: async () => '' };
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { patches, restore: () => { globalThis.fetch = original; } };
}

// A product with aggregate stock left, but the M size specifically sold out.
// This is the exact shape that triggered the bug: sizes formula drops "M",
// the storefront stops listing it, yet aggregate stock_quantity is still > 0.
const M_SOLD_OUT = {
  Name: 'Test Jersey',
  stock_quantity: 2,
  units_sold: 5,
  in_stock: true,
  stock_xs: 0, stock_s: 2, stock_m: 0, stock_l: 0, stock_xl: 0, stock_xxl: 0,
  sold_xs: 0, sold_s: 3, sold_m: 4, sold_l: 0, sold_xl: 0, sold_xxl: 0,
};

test('rejects a size whose per-size stock is 0 even when aggregate stock remains', async () => {
  const { patches, restore } = mockAirtable(M_SOLD_OUT);
  try {
    const r = await processLine('key', { id: 'rec1', qty: 1, size: 'M', name: 'Test Jersey', price: 100 });
    assert.equal(r.ok, false, 'order for sold-out size M must be rejected');
    assert.match(r.error, /sold out/i);
    assert.equal(patches.length, 0, 'no stock should be written back for a rejected line');
  } finally {
    restore();
  }
});

test('accepts an in-stock size and decrements BOTH the per-size and aggregate columns', async () => {
  const { patches, restore } = mockAirtable(M_SOLD_OUT);
  try {
    const r = await processLine('key', { id: 'rec1', qty: 1, size: 'S', name: 'Test Jersey', price: 100 });
    assert.equal(r.ok, true, 'order for in-stock size S must succeed');
    assert.equal(patches.length, 1);
    const w = patches[0];
    assert.equal(w.stock_s, 1, 'stock_s 2 -> 1');
    assert.equal(w.sold_s, 4, 'sold_s 3 -> 4');
    assert.equal(w.stock_quantity, 1, 'aggregate 2 -> 1');
    assert.equal(w.units_sold, 6, 'units_sold 5 -> 6');
  } finally {
    restore();
  }
});

test('rejects an unknown size label outright', async () => {
  const { patches, restore } = mockAirtable(M_SOLD_OUT);
  try {
    const r = await processLine('key', { id: 'rec1', qty: 1, size: 'XXXL', name: 'Test Jersey', price: 100 });
    assert.equal(r.ok, false, 'unknown size must be rejected');
    assert.equal(patches.length, 0);
  } finally {
    restore();
  }
});

test('flips in_stock to false when the last unit (across all sizes) sells', async () => {
  const lastOne = {
    Name: 'Last One', stock_quantity: 1, units_sold: 9, in_stock: true,
    stock_xs: 0, stock_s: 0, stock_m: 0, stock_l: 1, stock_xl: 0, stock_xxl: 0,
    sold_xs: 0, sold_s: 0, sold_m: 0, sold_l: 0, sold_xl: 0, sold_xxl: 0,
  };
  const { patches, restore } = mockAirtable(lastOne);
  try {
    const r = await processLine('key', { id: 'rec1', qty: 1, size: 'L', name: 'Last One', price: 100 });
    assert.equal(r.ok, true);
    assert.equal(patches[0].in_stock, false, 'in_stock should flip to false at zero aggregate');
    assert.equal(patches[0].stock_l, 0);
  } finally {
    restore();
  }
});

test('backward compatible: a line with no size still gates on aggregate stock', async () => {
  const { patches, restore } = mockAirtable(M_SOLD_OUT);
  try {
    const r = await processLine('key', { id: 'rec1', qty: 1, name: 'Test Jersey', price: 100 });
    assert.equal(r.ok, true, 'sizeless line falls back to aggregate gate');
    assert.equal(patches[0].stock_quantity, 1);
    assert.equal(patches[0].units_sold, 6);
  } finally {
    restore();
  }
});
