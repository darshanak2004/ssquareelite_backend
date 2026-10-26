import { wrap, esc, money } from '../lib/http.js';

const site = () => (process.env.SITE_URL || (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0]).trim().replace(/\/$/, '');
const abs = u => !u ? '' : /^https?:\/\//i.test(u) ? u : site() + (u.startsWith('/') ? '' : '/') + u;

export function registerShareRoutes(app, { db }) {
  app.get('/share/product/:key', wrap((req, res) => {
    const k = req.params.key;
    const p = /^\d+$/.test(k)
      ? db.prepare('SELECT id,name,slug,description,price,image,stock FROM products WHERE id=? AND active=1').get(Number(k))
      : db.prepare('SELECT id,name,slug,description,price,image,stock FROM products WHERE slug=? AND active=1').get(k);
    if (!p) return res.redirect(302, site());
    const target = `${site()}/product/${encodeURIComponent(p.slug || p.id)}`;
    const title = `${p.name} — S Square Elite`;
    const desc = `${money(p.price)} · ${String(p.description || 'A thoughtful gift from S Square Elite.').replace(/\s+/g, ' ').slice(0, 150)}`;
    const img = abs(p.image);
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="product"><meta property="og:site_name" content="S Square Elite">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(target)}">${img ? `<meta property="og:image" content="${esc(img)}"><meta property="og:image:alt" content="${esc(p.name)}">` : ''}
<meta property="product:price:amount" content="${p.price}"><meta property="product:price:currency" content="INR">
<meta property="product:availability" content="${p.stock > 0 ? 'in stock' : 'out of stock'}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${esc(target)}"><link rel="canonical" href="${esc(target)}"></head>
<body><p>Opening <a href="${esc(target)}">${esc(p.name)}</a>…</p></body></html>`);
  }));
}