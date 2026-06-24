const BASE_ID = 'appOvsTaUDIkXqF17';
const TABLE_ID = 'tblWjg7NqsZvK0otW';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'AIRTABLE_API_KEY not set' }),
    };
  }

  const id = event.queryStringParameters && event.queryStringParameters.id;
  if (!id) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing product id' }),
    };
  }

  try {
    // No in_stock filter — an Instagram permalink must still resolve after a
    // shirt sells out, so the page can render a "Sold Out" state instead of 404.
    // Note: the single-record GET endpoint does NOT accept a `fields[]` param
    // (it 422s); it returns the full record, so we just map the fields we want.
    const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    // A deleted/unknown record id surfaces as 404 (malformed) or 403
    // (well-formed but not found) — either way it's a missing product, not a
    // server fault, so a stale permalink renders the not-found state cleanly.
    if (res.status === 404 || res.status === 403) {
      return {
        statusCode: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Product not found' }),
      };
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Airtable error ${res.status}: ${err}`);
    }

    const rec = await res.json();
    const f = rec.fields;
    const product = {
      id: rec.id,
      name: f['Name'] || '',
      league: f['league'] || '',
      price: f['price_ttd'] || 0,
      sizes: f['sizes'] || [],
      imageFront: f['image_url_front'] || '',
      imageBack: f['image_url_back'] || '',
      badge: f['badge'] || '',
      description: f['description'] || '',
      // null → 0. calculated_stock_quantity is the formula aggregate of the
      // per-size columns (the `in_stock` checkbox isn't maintained here), so
      // inStock and the "Sold Out" state reflect actual size availability.
      stockQuantity:
        typeof f['calculated_stock_quantity'] === 'number' ? f['calculated_stock_quantity'] : 0,
      inStock: (typeof f['calculated_stock_quantity'] === 'number' ? f['calculated_stock_quantity'] : 0) > 0,
    };

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
