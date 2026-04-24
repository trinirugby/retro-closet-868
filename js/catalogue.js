/* ============================================================
   CATALOGUE.JS — Fetch products, filter, render cards
   ============================================================ */
import { addItem } from './cart.js';
import { showToast } from './main.js';

let allProducts = [];
let activeFilter = 'all';

const grid = document.getElementById('product-grid');
const filterTabs = document.querySelectorAll('.filter-tab');
const resultCount = document.getElementById('result-count');

// ── Fetch ───────────────────────────────────────────────────
async function fetchProducts() {
  showSkeletons();
  try {
    const res = await fetch('/api/get-products');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { products } = await res.json();
    allProducts = products;
    renderCards(allProducts);
  } catch (err) {
    showError(err.message);
  }
}

// ── Filter ──────────────────────────────────────────────────
filterTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    filterTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeFilter = tab.dataset.filter;
    const filtered = activeFilter === 'all'
      ? allProducts
      : allProducts.filter(p =>
          p.league.toLowerCase() === activeFilter.toLowerCase()
        );
    renderCards(filtered);
  });
});

// ── Render ──────────────────────────────────────────────────
function renderCards(products) {
  if (!grid) return;

  if (resultCount) {
    resultCount.textContent = `${products.length} item${products.length !== 1 ? 's' : ''}`;
  }

  if (products.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <p>No jerseys found in this category — check back soon.</p>
        <button class="btn-outline" onclick="document.querySelector('[data-filter=all]').click()">
          <span>View All</span>
        </button>
      </div>`;
    return;
  }

  grid.innerHTML = products.map(p => buildCard(p)).join('');

  // Bind size pill selection
  grid.querySelectorAll('.size-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const cardPills = pill.closest('.product-card__sizes').querySelectorAll('.size-pill');
      cardPills.forEach(p => p.classList.remove('selected'));
      pill.classList.add('selected');
    });
  });

  // Bind add-to-cart
  grid.querySelectorAll('.product-card__add').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.product-card');
      const productId = card.dataset.id;
      const product = allProducts.find(p => p.id === productId);
      if (!product) return;

      const selectedPill = card.querySelector('.size-pill.selected');
      if (!selectedPill) {
        showToast('Please select a size first');
        return;
      }

      addItem(product, selectedPill.dataset.size);
      btn.textContent = 'Added ✓';
      btn.classList.add('added');
      setTimeout(() => {
        btn.textContent = 'Add to Cart';
        btn.classList.remove('added');
      }, 1800);
    });
  });
}

function buildCard(p) {
  const badgeHtml = p.badge
    ? `<span class="product-card__badge product-card__badge--${p.badge.toLowerCase()}">${p.badge}</span>`
    : '';

  const sizePills = (p.sizes || []).map(s =>
    `<button class="size-pill" data-size="${s}" type="button">${s}</button>`
  ).join('');

  const frontImg = p.imageFront
    ? `<img class="product-card__img" src="${p.imageFront}" alt="${p.name} front" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="product-card__img-placeholder">No Image</div>`;

  const backImg = p.imageBack
    ? `<img class="product-card__img product-card__img--back" src="${p.imageBack}" alt="${p.name} back" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="product-card__img-placeholder" style="transform:rotateY(180deg)">No Image</div>`;

  return `
    <article class="product-card" data-id="${p.id}">
      ${badgeHtml}
      <div class="product-card__flip">
        <div class="product-card__flip-inner">
          ${frontImg}
          ${backImg}
        </div>
      </div>
      <div class="product-card__body">
        <div class="product-card__league">${p.league}</div>
        <h3 class="product-card__name">${p.name}</h3>
        <div class="product-card__price">
          TTD $${p.price.toLocaleString()}
          <span>TTD</span>
        </div>
        <div class="product-card__sizes">${sizePills}</div>
        <button class="product-card__add" type="button">Add to Cart</button>
      </div>
    </article>`;
}

// ── Skeleton loaders ────────────────────────────────────────
function showSkeletons() {
  if (!grid) return;
  grid.innerHTML = Array(8).fill(`
    <div class="skeleton">
      <div class="skeleton__img"></div>
      <div class="skeleton__body">
        <div class="skeleton__line skeleton__line--short"></div>
        <div class="skeleton__line skeleton__line--med"></div>
        <div class="skeleton__line"></div>
      </div>
    </div>`).join('');
}

function showError(msg) {
  if (!grid) return;
  grid.innerHTML = `
    <div class="empty-state">
      <p>Couldn't load products right now.</p>
      <p style="font-size:0.75rem;color:var(--white-dim);font-family:var(--font-ui);margin-bottom:1.5rem">${msg}</p>
      <button class="btn-outline" onclick="location.reload()"><span>Try Again</span></button>
    </div>`;
}

// ── Init ────────────────────────────────────────────────────
fetchProducts();

// Export for home page featured section
export { allProducts, fetchProducts, buildCard };
