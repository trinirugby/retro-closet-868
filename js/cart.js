/* ============================================================
   CART.JS — Cart state, sidebar, localStorage
   ============================================================ */

const STORAGE_KEY = 'rc868_cart';

// ── State ───────────────────────────────────────────────────
function getCart() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}
function saveCart(cart) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
}

// ── Cart operations ─────────────────────────────────────────
export function addItem(product, size) {
  const cart = getCart();
  const key = `${product.id}__${size}`;
  const existing = cart.find(i => i.key === key);
  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({
      key,
      id: product.id,
      name: product.name,
      size,
      price: product.price,
      image: product.imageFront,
      qty: 1,
    });
  }
  saveCart(cart);
  renderSidebar();
  updateBadge();
  openSidebar();
}

export function removeItem(key) {
  saveCart(getCart().filter(i => i.key !== key));
  renderSidebar();
  updateBadge();
}

export function updateQty(key, delta) {
  const cart = getCart();
  const item = cart.find(i => i.key === key);
  if (!item) return;
  // Decrementing below 1 removes the item (no more stuck-at-1 confusion).
  if (item.qty + delta < 1) {
    removeItem(key);
    return;
  }
  item.qty += delta;
  saveCart(cart);
  renderSidebar();
  updateBadge();
}

export function getTotal() {
  return getCart().reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function getCount() {
  return getCart().reduce((sum, i) => sum + i.qty, 0);
}

export function clearCart() {
  localStorage.removeItem(STORAGE_KEY);
  updateBadge();
}

// ── Badge ───────────────────────────────────────────────────
function updateBadge() {
  const count = getCount();
  document.querySelectorAll('.nav__cart-badge').forEach(b => {
    b.textContent = count;
    b.classList.toggle('visible', count > 0);
  });
}

// ── Sidebar ─────────────────────────────────────────────────
const overlay  = document.querySelector('.cart-overlay');
const sidebar  = document.querySelector('.cart-sidebar');
const closeBtn = document.querySelector('.cart-sidebar__close');
const cartIcon = document.querySelector('.nav__cart');

export function openSidebar() {
  if (!sidebar) return;
  sidebar.classList.add('open');
  overlay?.classList.add('open');
  document.body.style.overflow = 'hidden';
}
export function closeSidebar() {
  if (!sidebar) return;
  sidebar.classList.remove('open');
  overlay?.classList.remove('open');
  document.body.style.overflow = '';
}

closeBtn?.addEventListener('click', closeSidebar);
overlay?.addEventListener('click', closeSidebar);
cartIcon?.addEventListener('click', (e) => {
  e.preventDefault();
  openSidebar();
});

function renderSidebar() {
  if (!sidebar) return;
  const cart = getCart();
  const itemsEl = sidebar.querySelector('.cart-sidebar__items');
  const emptyEl = sidebar.querySelector('.cart-sidebar__empty');
  const footerEl = sidebar.querySelector('.cart-sidebar__footer');
  const countEl  = sidebar.querySelector('.cart-sidebar__count');
  const amountEl = sidebar.querySelector('.cart-sidebar__subtotal-amount');

  if (countEl) countEl.textContent = `(${cart.length})`;
  if (amountEl) amountEl.textContent = `TTD $${getTotal().toLocaleString()}`;

  if (cart.length === 0) {
    if (itemsEl) itemsEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'flex';
    if (footerEl) footerEl.style.display = 'none';
    return;
  }

  if (itemsEl) itemsEl.style.display = 'block';
  if (emptyEl) emptyEl.style.display = 'none';
  if (footerEl) footerEl.style.display = 'block';

  if (itemsEl) {
    itemsEl.innerHTML = cart.map(item => `
      <div class="cart-item">
        <img class="cart-item__img"
             src="${item.image || ''}"
             alt="${item.name}"
             onerror="this.style.background='var(--surface-2)';this.src=''">
        <div>
          <div class="cart-item__name">${item.name}</div>
          <div class="cart-item__size">Size: ${item.size}</div>
          <div class="cart-item__price">TTD $${(item.price * item.qty).toLocaleString()}</div>
          <div class="cart-item__qty">
            <button onclick="window.__cartUpdateQty('${item.key}', -1)" aria-label="Decrease">−</button>
            <span>${item.qty}</span>
            <button onclick="window.__cartUpdateQty('${item.key}', 1)" aria-label="Increase">+</button>
          </div>
        </div>
        <button class="cart-item__remove" onclick="window.__cartRemove('${item.key}')" aria-label="Remove">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" width="18" height="18">
            <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/>
          </svg>
        </button>
      </div>
    `).join('');
  }
}

// Expose to inline onclick handlers (sidebar rendered HTML)
window.__cartRemove    = (key) => removeItem(key);
window.__cartUpdateQty = (key, d) => updateQty(key, d);

// ── Init sidebar ────────────────────────────────────────────
updateBadge();
renderSidebar();
