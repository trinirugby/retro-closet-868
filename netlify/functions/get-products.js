const BASE_ID = 'appOvsTaUDIkXqF17';
const TABLE_ID = 'tblWjg7NqsZvK0otW';

const FIELDS = [
  'Name',
  'league',
  'price_ttd',
  'sizes',
  'image_url_front',
  'image_url_back',
  'badge',
  'description',
  // Aggregate availability = sum of the per-size stock_<size> columns, kept by
  // an Airtable formula so it can't drift. This is the authoritative "in stock"
  // signal. The base's `in_stock` checkbox is not maintained here (nothing keeps
  // it in sync), so we rely on this formula instead — it auto-updates to 0 the
  // moment the last size sells, so sold-out jerseys drop out of the catalogue
  // with no manual upkeep. Also surfaces "Only N left" hints in one round-trip.
  'calculated_stock_quantity',
];

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

  try {
    const products = [];
    let offset = null;

    do {
      const params = new URLSearchParams({
        filterByFormula: '{calculated_stock_quantity}>0',
        pageSize: '100',
      });
      FIELDS.forEach((f) => params.append('fields[]', f));
      if (offset) params.set('offset', offset);

      const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}?${params}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Airtable error ${res.status}: ${err}`);
      }

      const data = await res.json();
      for (const rec of data.records) {
        const f = rec.fields;
        products.push({
          id: rec.id,
          name: f['Name'] || '',
          league: f['league'] || '',
          price: f['price_ttd'] || 0,
          sizes: f['sizes'] || [],
          imageFront: f['image_url_front'] || '',
          imageBack: f['image_url_back'] || '',
          badge: f['badge'] || '',
          description: f['description'] || '',
          // null → 0. calculated_stock_quantity is the formula aggregate, so
          // inStock and the "Only N left" hint stay truthful per actual size stock.
          stockQuantity:
            typeof f['calculated_stock_quantity'] === 'number' ? f['calculated_stock_quantity'] : 0,
          inStock: (typeof f['calculated_stock_quantity'] === 'number' ? f['calculated_stock_quantity'] : 0) > 0,
        });
      }
      offset = data.offset || null;
    } while (offset);

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ products }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
