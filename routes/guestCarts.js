import crypto from 'node:crypto';
import { wrap, rateLimit, HttpError, esc } from '../lib/http.js';
import * as T from '../lib/emailTemplates.js';

const apiBase = () => (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
const site = () => (process.env.SITE_URL || (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0]).trim().replace(/\/$/, '');

export function registerGuestCartRoutes(app, { db }) {
  app.put('/api/cart/guest', rateLimit({ max: 60, windowMs: 15 * 60 * 1000 }), wrap((req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new HttpError(400, 'Enter a valid email address.');
    const raw = Array.isArray(req.body?.items) ? req.body.items.slice(0, 50) : [];
    const merged = new Map();
    for (const i of raw) {
      const id = Number(i.productId ?? i.id), q = Math.floor(Number(i.quantity ?? 1));
      if (Number.isInteger(id) && q >= 1 && q <= 99) merged.set(id, Math.min(99, (merged.get(id) || 0) + q));
    }
    if (!merged.size) { db.prepare('DELETE FROM guest_carts WHERE email=?').run(email); return res.json({ ok: true }); }
    const json = JSON.stringify([...merged].sort((a, b) => a[0] - b[0]).map(([productId, quantity]) => ({ productId, quantity })));
    const cur = db.prepare('SELECT cart_json,unsubscribed FROM guest_carts WHERE email=?').get(email);
    if (cur && (cur.unsubscribed || cur.cart_json === json)) return res.json({ ok: true });
    db.prepare(`INSERT INTO guest_carts(email,cart_json,updated_at,reminded_at,unsub_token) VALUES(?,?,?,NULL,?)
      ON CONFLICT(email) DO UPDATE SET cart_json=excluded.cart_json,updated_at=excluded.updated_at,reminded_at=NULL`)
      .run(email, json, new Date().toISOString(), crypto.randomBytes(16).toString('hex'));
    res.json({ ok: true });
  }));

  app.get('/unsubscribe', wrap((req, res) => {
    const token = String(req.query.token || '');
    const r = /^[0-9a-f]{32}$/.test(token) ? db.prepare('UPDATE guest_carts SET unsubscribed=1 WHERE unsub_token=?').run(token) : { changes: 0 };
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#2b1a29;text-align:center">
<h2 style="color:#57244f">${r.changes ? 'You are unsubscribed' : 'Link not recognised'}</h2>
<p>${r.changes ? 'We will not send you any more bag reminders.' : 'This link may be old or incomplete.'}</p>
<p><a href="${esc(site())}" style="color:#57244f">Back to S Square Elite</a></p></body>`);
  }));
}

export async function runGuestCartSweep({ db, mail }) {
  const delayH = Number(process.env.ABANDONED_CART_DELAY_HOURS || 3);
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM guest_carts WHERE reminded_at IS NULL AND unsubscribed=0 AND updated_at<=? AND updated_at>=?
    AND email NOT IN (SELECT email FROM abandoned_carts)`)
    .all(new Date(now - delayH * 3600e3).toISOString(), new Date(now - 7 * 86400e3).toISOString());
  let sent = 0;
  for (const c of rows) {
    let cart = []; try { cart = JSON.parse(c.cart_json); } catch { /* skip */ }
    const items = cart.map(i => {
      const p = db.prepare('SELECT name,price,stock FROM products WHERE id=? AND active=1').get(i.productId);
      return p && p.stock > 0 ? { name: p.name, quantity: Math.min(i.quantity, p.stock), lineTotal: p.price * Math.min(i.quantity, p.stock) } : null;
    }).filter(Boolean);
    db.prepare('UPDATE guest_carts SET reminded_at=? WHERE email=?').run(new Date().toISOString(), c.email);
    if (!items.length) continue;
    const r = await mail.sendMail({ to: c.email, kind: 'abandoned_cart_guest', ...T.abandonedCart('there', items, `${apiBase()}/unsubscribe?token=${c.unsub_token}`) });
    if (r.ok) sent++;
  }
  return sent;
}
export function startGuestCartJob(deps) {
  const every = Number(process.env.ABANDONED_CART_CHECK_MINUTES || 15) * 60e3;
  setInterval(() => runGuestCartSweep(deps).catch(e => console.error('Guest cart sweep failed:', e.message)), every).unref();
}