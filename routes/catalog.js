import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { HttpError, wrap } from '../lib/http.js';
import { checkPincode } from '../lib/pincode.js';

function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function registerCatalogRoutes(app, { db, auth, publicProduct, productFields, uploadsDir }) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } });

  // ---- Product detail (id or slug) ----
  app.get('/api/products/:key', wrap((req, res) => {
    const k = req.params.key;
    const p = /^\d+$/.test(k)
      ? db.prepare(`SELECT ${productFields} FROM products WHERE id=? AND active=1`).get(Number(k))
      : db.prepare(`SELECT ${productFields} FROM products WHERE slug=? AND active=1`).get(k);
    if (!p) throw new HttpError(404, 'Product not found.');
    res.json({ product: publicProduct(p) });
  }));

  // ---- Related products ----
  app.get('/api/products/:id/related', wrap((req, res) => {
    const cur = db.prepare('SELECT id,category FROM products WHERE id=? AND active=1').get(Number(req.params.id));
    if (!cur) return res.json({ products: [] });
    const same = db.prepare(`SELECT ${productFields} FROM products WHERE active=1 AND stock>0 AND id!=? AND category=? ORDER BY id DESC LIMIT 4`).all(cur.id, cur.category);
    const need = 4 - same.length;
    const more = need > 0 ? db.prepare(`SELECT ${productFields} FROM products WHERE active=1 AND stock>0 AND id!=? AND category!=? ORDER BY id DESC LIMIT ?`).all(cur.id, cur.category, need) : [];
    res.json({ products: [...same, ...more].map(publicProduct) });
  }));
  // ---- Verified reviews ----
  const purchased = (uid, pid) => Boolean(db.prepare(`SELECT 1 FROM orders o JOIN order_items i ON i.order_id=o.id
    WHERE o.user_id=? AND i.product_id=? AND o.order_status NOT IN ('cancelled','refunded') AND (o.payment_status='paid' OR o.order_status='delivered') LIMIT 1`).get(uid, pid));
  const summary = pid => {
    const rows = db.prepare('SELECT rating,COUNT(*) n FROM reviews WHERE product_id=? GROUP BY rating').all(pid);
    const count = rows.reduce((s, r) => s + r.n, 0);
    return { count, average: count ? Math.round(rows.reduce((s, r) => s + r.rating * r.n, 0) / count * 10) / 10 : 0,
      distribution: Object.fromEntries([5, 4, 3, 2, 1].map(s => [s, rows.find(r => r.rating === s)?.n || 0])) };
  };
  app.get('/api/products/:id/reviews', wrap((req, res) => {
    const pid = Number(req.params.id);
    const reviews = db.prepare(`SELECT r.id,r.rating,r.title,r.body,r.created_at,u.name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=? ORDER BY r.id DESC LIMIT 50`).all(pid)
      .map(r => { const [first, ...rest] = String(r.name).trim().split(/\s+/); return { id: r.id, rating: r.rating, title: r.title, body: r.body, createdAt: r.created_at, author: rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first, verified: true }; });
    res.json({ reviews, summary: summary(pid) });
  }));
  app.get('/api/products/:id/review-eligibility', auth('customer'), (req, res) => {
    const pid = Number(req.params.id);
    res.json({ canReview: purchased(req.user.sub, pid), alreadyReviewed: Boolean(db.prepare('SELECT 1 FROM reviews WHERE product_id=? AND user_id=?').get(pid, req.user.sub)) });
  });
  app.post('/api/products/:id/reviews', auth('customer'), wrap((req, res) => {
    const pid = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(pid)) throw new HttpError(404, 'Product not found.');
    if (!purchased(req.user.sub, pid)) throw new HttpError(403, 'Only customers who bought this product can review it.');
    const rating = Number(req.body?.rating), title = String(req.body?.title || '').trim(), body = String(req.body?.body || '').trim();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Please choose a rating from 1 to 5 stars.');
    if (title.length > 80 || body.length > 1000) throw new HttpError(400, 'Title is limited to 80 and review to 1000 characters.');
    if (db.prepare('SELECT 1 FROM reviews WHERE product_id=? AND user_id=?').get(pid, req.user.sub)) throw new HttpError(409, 'You have already reviewed this product.');
    db.transaction(() => {
      db.prepare('INSERT INTO reviews(product_id,user_id,rating,title,body) VALUES(?,?,?,?,?)').run(pid, req.user.sub, rating, title, body);
      const s = summary(pid);
      db.prepare('UPDATE products SET rating=?,reviews=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(s.average.toFixed(1), s.count, pid);
    })();
    res.status(201).json({ ok: true, summary: summary(pid) });
  }));

  // ---- Admin image upload ----
  app.use('/uploads', express_static(uploadsDir));
  app.post('/api/admin/uploads', auth('admin'),
    (req, res, next) => upload.single('image')(req, res, err => err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 3 MB or smaller.' : 'Upload failed.' }) : next()),
    wrap((req, res) => {
      if (!req.file) throw new HttpError(400, 'Choose an image to upload.');
      const ext = sniffImage(req.file.buffer);
      if (!ext) throw new HttpError(400, 'Only JPG, PNG or WebP images are allowed.');
      const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(uploadsDir, name), req.file.buffer);
      const base = (process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      res.status(201).json({ url: `${base}/uploads/${name}` });
    }));

  // ---- Pincode serviceability ----
  app.get('/api/pincode/:pin', (req, res) => res.json(checkPincode(req.params.pin)));
}
import expressLib from 'express';
function express_static(dir) {
  return expressLib.static(dir, { maxAge: '7d', index: false, setHeaders: r => r.setHeader('X-Content-Type-Options', 'nosniff') });
}
