import { wrap } from '../lib/http.js';
import * as T from '../lib/emailTemplates.js';

export function registerCartRoutes(app, { db, auth }) {
  // The storefront syncs a signed-in customer's bag here (debounced). Empty bag removes the row.
  app.put('/api/cart', auth('customer'), wrap((req, res) => {
    const raw = Array.isArray(req.body?.items) ? req.body.items.slice(0, 50) : [];
    const merged = new Map();
    for (const i of raw) {
      const id = Number(i.productId ?? i.id), q = Math.floor(Number(i.quantity ?? 1));
      if (Number.isInteger(id) && q >= 1 && q <= 99) merged.set(id, Math.min(99, (merged.get(id) || 0) + q));
    }
    if (!merged.size) { db.prepare('DELETE FROM abandoned_carts WHERE user_id=?').run(req.user.sub); return res.json({ ok: true }); }
    const json = JSON.stringify([...merged].sort((a, b) => a[0] - b[0]).map(([productId, quantity]) => ({ productId, quantity })));
    const cur = db.prepare('SELECT cart_json FROM abandoned_carts WHERE user_id=?').get(req.user.sub);
    if (cur?.cart_json === json) return res.json({ ok: true });   // unchanged: keep the idle timer running
    const u = db.prepare('SELECT email FROM users WHERE id=?').get(req.user.sub);
    db.prepare(`INSERT INTO abandoned_carts(user_id,email,cart_json,updated_at,reminded_at) VALUES(?,?,?,?,NULL)
      ON CONFLICT(user_id) DO UPDATE SET cart_json=excluded.cart_json,updated_at=excluded.updated_at,reminded_at=NULL`).run(req.user.sub, u.email, json, new Date().toISOString());
    res.json({ ok: true });
  }));
}

// One reminder per cart state; only for signed-in customers (guests have no email on file).
export async function runAbandonedCartSweep({ db, mail }) {
  const delayH = Number(process.env.ABANDONED_CART_DELAY_HOURS || 3);
  const now = Date.now();
  const rows = db.prepare('SELECT c.*,u.name FROM abandoned_carts c JOIN users u ON u.id=c.user_id WHERE c.reminded_at IS NULL AND c.updated_at<=? AND c.updated_at>=?')
    .all(new Date(now - delayH * 3600e3).toISOString(), new Date(now - 7 * 86400e3).toISOString());
  let sent = 0;
  for (const c of rows) {
    let cart = []; try { cart = JSON.parse(c.cart_json); } catch { /* skip */ }
    const items = cart.map(i => { const p = db.prepare('SELECT name,price,stock FROM products WHERE id=? AND active=1').get(i.productId); return p && p.stock > 0 ? { name: p.name, quantity: Math.min(i.quantity, p.stock), lineTotal: p.price * Math.min(i.quantity, p.stock) } : null; }).filter(Boolean);
    db.prepare('UPDATE abandoned_carts SET reminded_at=? WHERE user_id=?').run(new Date().toISOString(), c.user_id);
    if (!items.length) continue;
    const r = await mail.sendMail({ to: c.email, kind: 'abandoned_cart', ...T.abandonedCart(c.name, items) });
    if (r.ok) sent++;
  }
  return sent;
}
export function startAbandonedCartJob(deps) {
  const every = Number(process.env.ABANDONED_CART_CHECK_MINUTES || 15) * 60e3;
  setInterval(() => runAbandonedCartSweep(deps).catch(e => console.error('Abandoned-cart sweep failed:', e.message)), every).unref();
}
