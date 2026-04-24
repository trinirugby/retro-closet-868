const BASE_ID = 'appcA2sFnpO4O9x7N';
const TABLE_ID = 'tblWjg7NqsZvK0otW';

const FIELDS = [
  'Name',
  'league',
  'price_ttd',
  'sizes',
  'in_stock',
  'image_url_front',
  'image_url_back',
  'badge',
  'description',
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
        filterByFormula: '{in_stock}=TRUE()',
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
          inStock: f['in_stock'] || false,
          imageFront: f['image_url_front'] || '',
          imageBack: f['image_url_back'] || '',
          badge: f['badge'] || '',
          description: f['description'] || '',
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
