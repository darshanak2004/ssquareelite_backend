import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { HttpError, wrap, rateLimit } from '../lib/http.js';
import * as T from '../lib/emailTemplates.js';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

export function registerAccountRoutes(app, { db, auth, mail, isStrongPassword }) {
  // ---- Password reset ----
  app.post('/api/auth/forgot-password', rateLimit({ max: 8 }), wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const generic = { ok: true, message: 'If an account exists for that email, a reset link is on its way.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json(generic);
    const user = db.prepare("SELECT id,name,email FROM users WHERE email=? AND role='customer'").get(email);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare("UPDATE password_resets SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL").run(user.id);
      db.prepare('INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES(?,?,?)').run(user.id, sha(token), new Date(Date.now() + 3600e3).toISOString());
      void mail.sendMail({ to: user.email, kind: 'password_reset', ...T.passwordReset(user.name, token) });
    }
    res.json(generic);
  }));

  app.post('/api/auth/reset-password', rateLimit({ max: 15 }), wrap(async (req, res) => {
    const { token, password } = req.body || {};
    if (!isStrongPassword(password)) throw new HttpError(400, 'Password must be at least 8 characters and include uppercase, lowercase, a number and a special character.');
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash=?').get(sha(String(token || '')));
    if (!row || row.used_at || row.expires_at < new Date().toISOString()) throw new HttpError(400, 'This reset link is invalid or has expired. Please request a new one.');
    const hash = await bcrypt.hash(password, 12);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, row.user_id);
      db.prepare('UPDATE password_resets SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL').run(row.user_id);
    })();
    res.json({ ok: true, message: 'Password updated. You can sign in now.' });
  }));

  // ---- Wishlist (saved to the account) ----
  const ids = uid => db.prepare('SELECT product_id FROM wishlist WHERE user_id=? ORDER BY created_at DESC').all(uid).map(r => r.product_id);
  app.get('/api/wishlist', auth('customer'), (req, res) => res.json({ ids: ids(req.user.sub) }));
  app.put('/api/wishlist/:productId', auth('customer'), wrap((req, res) => {
    const pid = Number(req.params.productId);
    if (!db.prepare('SELECT 1 FROM products WHERE id=? AND active=1').get(pid)) throw new HttpError(404, 'Product not found.');
    db.prepare('INSERT OR IGNORE INTO wishlist(user_id,product_id) VALUES(?,?)').run(req.user.sub, pid);
    res.json({ ids: ids(req.user.sub) });
  }));
  app.delete('/api/wishlist/:productId', auth('customer'), (req, res) => {
    db.prepare('DELETE FROM wishlist WHERE user_id=? AND product_id=?').run(req.user.sub, Number(req.params.productId));
    res.json({ ids: ids(req.user.sub) });
  });
  // Merge a guest (localStorage) wishlist into the account after sign-in.
  app.post('/api/wishlist/merge', auth('customer'), (req, res) => {
    const list = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 200);
    const ins = db.prepare('INSERT OR IGNORE INTO wishlist(user_id,product_id) SELECT ?,id FROM products WHERE id=? AND active=1');
    db.transaction(() => list.forEach(id => ins.run(req.user.sub, id)))();
    res.json({ ids: ids(req.user.sub) });
  });
}
