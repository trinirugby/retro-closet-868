/* ============================================================
   GET-DELIVERY-LOCATIONS.JS — Courier rate card (read-only)

   Returns the active delivery areas and their fees from the
   Airtable `Delivery Locations` table. The checkout page uses
   this to build the area dropdown and to show the right fee the
   moment a customer picks their area.

   The seller maintains the rate card entirely in Airtable:
   edit `Price` to change a fee, add a row for a new area, or
   uncheck `Active` to hide one. No code change or redeploy.

   place-order.js re-reads the same table server-side, so the
   charged fee is authoritative and can't be tampered with from
   the browser.
   ============================================================ */

const BASE_ID = 'appcA2sFnpO4O9x7N';
// Delivery Locations table — one record per courier area (Location, Price, Active).
const TABLE_ID = 'tblBjtLDlEKnPlX4y';

const FIELDS = ['Location', 'Price', 'Active'];

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
    const locations = [];
    let offset = null;

    do {
      const params = new URLSearchParams({
        filterByFormula: '{Active}=TRUE()',
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
        const location = (f['Location'] || '').toString().trim();
        // Skip rows with no name or no fee — incomplete to charge against.
        if (!location || typeof f['Price'] !== 'number') continue;
        locations.push({ location, price: f['Price'] });
      }
      offset = data.offset || null;
    } while (offset);

    // Cheapest first, then alphabetical — a sensible order for the dropdown.
    locations.sort((a, b) => a.price - b.price || a.location.localeCompare(b.location));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
