/* ============================================================
   MAIN.JS — Nav, scroll, reveal, shared utilities
   ============================================================ */

// ── Nav scroll state ────────────────────────────────────────
const nav = document.querySelector('.nav');
const scrollTopBtn = document.querySelector('.scroll-top');

function onScroll() {
  const y = window.scrollY;
  if (nav) nav.classList.toggle('scrolled', y > 20);
  if (scrollTopBtn) scrollTopBtn.classList.toggle('visible', y > 400);
}
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// ── Active nav link ─────────────────────────────────────────
const currentPage = location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('.nav__link, .nav__mobile-link').forEach(link => {
  const href = link.getAttribute('href') || '';
  if (
    (href === 'index.html' && (currentPage === '' || currentPage === 'index.html')) ||
    (href !== 'index.html' && currentPage.startsWith(href.replace('.html', '')))
  ) {
    link.classList.add('active');
  }
});

// ── Mobile hamburger ────────────────────────────────────────
const hamburger = document.querySelector('.nav__hamburger');
if (hamburger) {
  hamburger.addEventListener('click', () => {
    document.body.classList.toggle('nav-open');
    hamburger.setAttribute('aria-expanded',
      document.body.classList.contains('nav-open').toString()
    );
  });
}

// Close mobile menu on link click
document.querySelectorAll('.nav__mobile-link').forEach(link => {
  link.addEventListener('click', () => document.body.classList.remove('nav-open'));
});

// ── Scroll to top ───────────────────────────────────────────
if (scrollTopBtn) {
  scrollTopBtn.addEventListener('click', () =>
    window.scrollTo({ top: 0, behavior: 'smooth' })
  );
}

// ── Intersection Observer — reveal animations ───────────────
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// ── Cart badge update ───────────────────────────────────────
export function updateCartBadge() {
  const cart = JSON.parse(localStorage.getItem('rc868_cart') || '[]');
  const total = cart.reduce((sum, item) => sum + (item.qty || 1), 0);
  document.querySelectorAll('.nav__cart-badge').forEach(badge => {
    badge.textContent = total;
    badge.classList.toggle('visible', total > 0);
  });
}
updateCartBadge();

// ── Toast notification ──────────────────────────────────────
let toastTimer = null;
export function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

// ── Hero parallax ───────────────────────────────────────────
// Move the video and its poster still together so they never drift apart.
const heroLayers = [
  document.querySelector('.hero__bg'),
  document.querySelector('.hero__poster'),
].filter(Boolean);
if (heroLayers.length) {
  let ticking = false;
  const applyParallax = () => {
    const t = `scale(1.05) translateY(${window.scrollY * 0.3}px)`;
    heroLayers.forEach(el => { el.style.transform = t; });
    ticking = false;
  };
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(applyParallax); }
  }, { passive: true });
}

// ── Touch-to-flip product images ────────────────────────────
// Touch & hold a jersey image to flip to the back; lift to flip front.
// While scrolling, each image under the finger flips in turn. Listeners are
// passive and never preventDefault, so vertical scrolling is fully preserved.
// Delegated on document so it works for cards rendered after the async fetch.
let flippedCard = null;

function flipElFromPoint(x, y) {
  return document.elementFromPoint(x, y)?.closest('.product-card__flip') || null;
}

function setFlipped(el) {
  if (el === flippedCard) return;
  if (flippedCard) flippedCard.classList.remove('is-flipped');
  if (el) el.classList.add('is-flipped');
  flippedCard = el;
}

function clearFlipped() {
  if (flippedCard) flippedCard.classList.remove('is-flipped');
  flippedCard = null;
}

document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  if (t) setFlipped(flipElFromPoint(t.clientX, t.clientY));
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (t) setFlipped(flipElFromPoint(t.clientX, t.clientY));
}, { passive: true });

document.addEventListener('touchend', clearFlipped, { passive: true });
document.addEventListener('touchcancel', clearFlipped, { passive: true });
