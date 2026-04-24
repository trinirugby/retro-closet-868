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
  item.qty = Math.max(1, item.qty + delta);
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
        <button class="cart-item__remove" onclick="window.__cartRemove('${item.key}')">REMOVE</button>
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
