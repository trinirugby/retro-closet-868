/* ============================================================
   PRODUCT.JS — Single product detail page
   ============================================================ */
import { addItem } from './cart.js';
import { showToast } from './main.js';

const root = document.getElementById('product-detail');

function notFound() {
  if (!root) return;
  root.innerHTML = `
    <div class="product-detail__missing">
      <h1 class="product-detail__missing-title">Product not found</h1>
      <p class="product-detail__missing-sub">This jersey may have been removed or the link is incorrect.</p>
      <a href="catalogue.html" class="btn-gold"><span>Browse the Catalogue</span></a>
    </div>`;
}

async function init() {
  if (!root) return;

  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    notFound();
    return;
  }

  let product;
  try {
    const res = await fetch('/api/get-product?id=' + encodeURIComponent(id));
    if (!res.ok) {
      notFound();
      return;
    }
    ({ product } = await res.json());
  } catch {
    notFound();
    return;
  }

  if (!product) {
    notFound();
    return;
  }

  render(product);
}

function render(p) {
  const soldOut = p.inStock === false || p.stockQuantity <= 0;

  // Share-friendly metadata so Instagram/WhatsApp link previews read well.
  document.title = `${p.name} — Retro Closet 868`;
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc && p.description) metaDesc.setAttribute('content', p.description);

  const badgeHtml = p.badge
    ? `<span class="product-card__badge product-card__badge--${p.badge.toLowerCase()}">${p.badge}</span>`
    : '';

  const frontImg = p.imageFront
    ? `<img class="product-card__img" src="${p.imageFront}" alt="${p.name} front" onerror="this.style.display='none'">`
    : `<div class="product-card__img-placeholder">No Image</div>`;

  const backImg = p.imageBack
    ? `<img class="product-card__img product-card__img--back" src="${p.imageBack}" alt="${p.name} back" onerror="this.style.display='none'">`
    : `<div class="product-card__img-placeholder" style="transform:rotateY(180deg)">No Image</div>`;

  const sizePills = ['S', 'M', 'L'].map(s =>
    `<button class="size-pill" data-size="${s}" type="button">${s}</button>`
  ).join('');

  const descHtml = p.description
    ? `<p class="product-detail__desc">${p.description}</p>`
    : '';

  const soldOutBadge = soldOut
    ? `<span class="product-card__badge product-card__badge--sale" style="position:static;display:inline-block;margin-bottom:1rem">Sold Out</span>`
    : '';

  const actionsHtml = soldOut
    ? `<p class="product-detail__soldout">This jersey is currently sold out.</p>`
    : `
      <div class="product-detail__sizes">
        <div class="product-detail__sizes-label">Select Size</div>
        <div class="product-card__sizes">${sizePills}</div>
      </div>
      <div class="product-detail__actions">
        <button class="btn-gold product-detail__buy" type="button"><span>Buy Now</span></button>
        <button class="btn-outline product-detail__add" type="button"><span>Add to Cart</span></button>
      </div>`;

  root.innerHTML = `
    <a href="catalogue.html" class="product-detail__back">← Back to Catalogue</a>
    <div class="product-detail__grid">
      <div class="product-detail__media">
        <div class="product-card__flip">
          <div class="product-card__flip-inner">
            ${frontImg}
            ${backImg}
          </div>
        </div>
      </div>
      <div class="product-detail__info">
        ${badgeHtml ? `<div class="product-detail__badge-row">${badgeHtml}</div>` : ''}
        <div class="product-detail__league">${p.league}</div>
        <h1 class="product-detail__name">${p.name}</h1>
        <div class="product-detail__price">TTD $${p.price.toLocaleString()} <span>TTD</span></div>
        ${soldOutBadge}
        ${descHtml}
        ${actionsHtml}
      </div>
    </div>`;

  if (soldOut) return;

  // Size pill selection
  root.querySelectorAll('.size-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      root.querySelectorAll('.size-pill').forEach(x => x.classList.remove('selected'));
      pill.classList.add('selected');
    });
  });

  function selectedSize() {
    const sel = root.querySelector('.size-pill.selected');
    if (!sel) {
      showToast('Please select a size first');
      return null;
    }
    return sel.dataset.size;
  }

  root.querySelector('.product-detail__add')?.addEventListener('click', () => {
    const size = selectedSize();
    if (!size) return;
    addItem(p, size);
  });

  root.querySelector('.product-detail__buy')?.addEventListener('click', () => {
    const size = selectedSize();
    if (!size) return;
    addItem(p, size);
    location.href = 'checkout.html';
  });
}

init();
