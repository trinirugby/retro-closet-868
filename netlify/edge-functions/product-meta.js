// ============================================================
//  PRODUCT-META — server-side Open Graph / product metadata
// ============================================================
// Social crawlers (facebookexternalhit, used by Instagram & Facebook) do NOT
// run JavaScript — they read only the raw HTML. product.html ships generic
// <head> tags and hydrates the real name/price/image client-side, so a crawler
// sees no shoppable product and Instagram says "No matches found".
//
// This edge function runs on requests to /product.html, fetches the product
// from Airtable (same record as get-product.js), and injects Open Graph
// product tags + a schema.org Product JSON-LD block into the <head> before the
// page is sent. Real visitors still get the JS-hydrated page unchanged.

const BASE_ID = 'appOvsTaUDIkXqF17';
const TABLE_ID = 'tblWjg7NqsZvK0otW';

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export default async (request, context) => {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  // Always fetch the static product.html from origin first; we only enrich it.
  const response = await context.next();

  if (!id) return response;

  const apiKey = Netlify.env.get('AIRTABLE_API_KEY');
  if (!apiKey) return response;

  let product;
  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}/${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    // Unknown / deleted id (404 or 403) → leave the generic page untouched.
    if (!res.ok) return response;
    const rec = await res.json();
    const f = rec.fields;
    product = {
      name: f['Name'] || '',
      price: f['price_ttd'] || 0,
      inStock: f['in_stock'] || false,
      imageFront: f['image_url_front'] || '',
      description: f['description'] || '',
      stockQuantity:
        typeof f['stock_quantity'] === 'number' ? f['stock_quantity'] : 0,
    };
  } catch {
    return response;
  }

  const soldOut = product.inStock === false || product.stockQuantity <= 0;
  const title = `${product.name} — Retro Closet 868`;
  const desc =
    product.description ||
    `${product.name} — premium football jersey from Retro Closet 868.`;
  const pageUrl = `${url.origin}/product.html?id=${encodeURIComponent(id)}`;
  const availability = soldOut ? 'out of stock' : 'in stock';

  const jsonLd = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: product.name,
    image: product.imageFront ? [product.imageFront] : [],
    description: desc,
    brand: { '@type': 'Brand', name: 'Retro Closet 868' },
    offers: {
      '@type': 'Offer',
      url: pageUrl,
      priceCurrency: 'TTD',
      price: product.price,
      availability: soldOut
        ? 'https://schema.org/OutOfStock'
        : 'https://schema.org/InStock',
    },
  };

  const imageTag = product.imageFront
    ? `<meta property="og:image" content="${esc(product.imageFront)}">
    <meta name="twitter:image" content="${esc(product.imageFront)}">`
    : '';

  const headTags = `
    <meta property="og:type" content="product">
    <meta property="og:site_name" content="Retro Closet 868">
    <meta property="og:title" content="${esc(product.name)}">
    <meta property="og:description" content="${esc(desc)}">
    <meta property="og:url" content="${esc(pageUrl)}">
    ${imageTag}
    <meta property="product:price:amount" content="${esc(product.price)}">
    <meta property="product:price:currency" content="TTD">
    <meta property="product:availability" content="${availability}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(product.name)}">
    <meta name="twitter:description" content="${esc(desc)}">
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  `;

  // The edge runtime doesn't expose HTMLRewriter, so rewrite the HTML as text:
  // swap the generic <title>/description and inject the product tags before
  // </head>. text() decodes any origin compression, so we drop the stale
  // content-encoding/content-length headers before re-sending.
  const html = await response.text();
  const enriched = html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(
      /<meta name="description"[^>]*>/,
      `<meta name="description" content="${esc(desc)}">`
    )
    .replace('</head>', `${headTags}</head>`);

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');

  return new Response(enriched, { status: response.status, headers });
};

export const config = { path: '/product.html' };
