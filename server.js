import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Razorpay from 'razorpay';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './lib/migrations.js';
import { createMailer } from './lib/mail.js';
import { createOrdersService, shippingFor, giftWrapFee } from './lib/orders.js';
import { HttpError, rateLimit } from './lib/http.js';
import { registerCheckoutRoutes } from './routes/checkout.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerCartRoutes, startAbandonedCartJob } from './routes/carts.js';
import { registerShareRoutes } from './routes/share.js';
import { registerBannerRoutes } from './routes/banner.js';
import { registerGuestCartRoutes, startGuestCartJob } from './routes/guestCarts.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.DATABASE_FILE || path.join(dataDir, 'ssquare.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 phone TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS addresses (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 label TEXT DEFAULT 'Home', recipient TEXT NOT NULL, phone TEXT NOT NULL, line1 TEXT NOT NULL,
 line2 TEXT DEFAULT '', city TEXT NOT NULL, state TEXT NOT NULL, postal_code TEXT NOT NULL,
 is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT UNIQUE, category TEXT NOT NULL,
 description TEXT DEFAULT '', price INTEGER NOT NULL CHECK(price >= 0), old_price INTEGER DEFAULT 0,
 image TEXT DEFAULT '', tag TEXT DEFAULT '', rating TEXT NOT NULL DEFAULT '4.8', reviews INTEGER NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_number TEXT NOT NULL UNIQUE, user_id INTEGER REFERENCES users(id),
 customer_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
 address_json TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0,
 delivery_fee INTEGER NOT NULL, total INTEGER NOT NULL, item_count INTEGER NOT NULL,
 payment_method TEXT NOT NULL, payment_status TEXT NOT NULL DEFAULT 'pending',
 payment_reference TEXT, order_status TEXT NOT NULL DEFAULT 'placed',
 notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 product_id INTEGER REFERENCES products(id), product_name TEXT NOT NULL, image TEXT DEFAULT '',
 unit_price INTEGER NOT NULL, quantity INTEGER NOT NULL, line_total INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coupons (
 id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'percent',
 value INTEGER NOT NULL, min_total INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
 starts_at TEXT, ends_at TEXT, usage_limit INTEGER, used_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS newsletter (
 id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
`);

const countProducts = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (!countProducts) {
 const seed = [
  ['Blush Bunny Glow Lamp','blush-bunny-glow-lamp','Small Lamps','A soft, warm-glow bunny lamp that brings a little magic to bedtime.',699,999,'/images/rabbit-lamp.png','Bestseller',12],
  ['Cosy Panda Night Light','cosy-panda-night-light','Panda Lamps','A cuddly panda-shaped lamp for calm evenings and cosy rooms.',799,1099,'/images/panda-lamp.png','Customer favourite',8],
  ['Little Bunny Bedside Lamp','little-bunny-bedside-lamp','Small Lamps','A cute, glowing companion for desks, bedside tables and gifting.',549,749,'/images/rabbit-lamp-product.jpeg','Gift pick',5],
  ['Surprise & Smile Gift Set','surprise-smile-gift-set','Gift Sets','A cheerful gift edit made for birthdays, celebrations and little surprises.',1199,1499,'/images/hero-banner.jpeg','Gift-ready',7],
  ['Dreamy Panda Lamp','dreamy-panda-lamp','Panda Lamps','Gentle ambient light with an irresistibly cute panda design.',849,1099,'/images/panda-lamp.png','New',4],
  ['Bunny Bestie Light','bunny-bestie-light','Other Toys','A sweet little gift to brighten up their favourite corner.',599,799,'/images/rabbit-lamp.png','Under ₹600',0]
 ];
 const insert = db.prepare('INSERT INTO products(name,slug,category,description,price,old_price,image,tag,stock) VALUES(?,?,?,?,?,?,?,?,?)');
 const tx = db.transaction(rows => rows.forEach(r => insert.run(...r)));
 tx(seed);
}

runMigrations(db);
const mail = createMailer(db);

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
app.use(cors({ origin: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(s=>s.trim()), credentials: true }));
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 24) console.warn('WARNING: Set JWT_SECRET to a long random value in backend/.env before deployment.');
const signToken = user => jwt.sign({ sub: user.id, role: user.role, email: user.email }, JWT_SECRET || 'development-only-change-this-secret-now', { expiresIn: '7d' });
function optionalAuth(req,res,next) {
 const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
 if (token) { try { req.user = jwt.verify(token, JWT_SECRET || 'development-only-change-this-secret-now'); } catch { /* guest checkout remains available if an old token expired */ } }
 next();
}
function auth(requiredRole) {
 return (req,res,next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if (!token) return res.status(401).json({ error: 'Please sign in to continue.' });
  try {
   req.user = jwt.verify(token, JWT_SECRET || 'development-only-change-this-secret-now');
   if (requiredRole && req.user.role !== requiredRole) return res.status(403).json({ error: 'You do not have permission to do that.' });
   next();
  } catch { return res.status(401).json({ error: 'Your session expired. Please sign in again.' }); }
 };
}
const parseImages = v => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const cleanImages = v => (Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(x => /^(https?:\/\/|\/)/.test(x)).slice(0, 6);
const publicProduct = p => ({...p, images: parseImages(p.images), oldPrice: p.old_price, rating: p.rating || '4.8', reviews: Number(p.reviews || 0), active: Boolean(p.active), stock: Number(p.stock), price: Number(p.price)});
const productFields = 'id,name,slug,category,description,price,old_price,image,images,tag,rating,reviews,stock,active,created_at,updated_at';
function safeUser(row) { return { id: row.id, name: row.name, email: row.email, phone: row.phone, role: row.role }; }
function makeSlug(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
function getRazorpay() {
 if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
 return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

async function sendAdminWhatsApp(input) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const to = String(process.env.WHATSAPP_ADMIN_PHONE || '').replace(/\D/g, '');

  if (!token || !phoneNumberId || !to) {
    console.error('WhatsApp notification settings are incomplete.');
    return { ok: false, status: 503, error: 'WhatsApp environment settings are incomplete.' };
  }

  const templateName = process.env.WHATSAPP_ADMIN_TEMPLATE;
  let template;
  if (templateName) {
    if (!input || typeof input !== 'object' || !input.order) {
      console.error('WhatsApp: skipped an alert with no order details:', String(input));
      return { ok: false, status: 400, error: 'Nothing to send.' };
    }
    const o = input.order;
    const rupee = process.env.WHATSAPP_ADMIN_AMOUNT_PREFIX ?? '₹';
    const values = [
      o.order_number,
      rupee + Number(o.total || 0).toLocaleString('en-IN'),
      o.payment_method === 'bank_transfer' ? 'Bank transfer' : 'Online payment (Razorpay)',
      input.statusText || (o.payment_status === 'paid' ? 'Paid' : 'Pending verification')
    ];
    const names = String(process.env.WHATSAPP_ADMIN_PARAM_NAMES || '').split(',').map(s => s.trim());
    template = {
      name: templateName,
      language: { code: process.env.WHATSAPP_ADMIN_TEMPLATE_LANG || 'en' },
      components: [{
        type: 'body',
        parameters: values.map((v, i) => ({
          type: 'text',
          ...(names[i] ? { parameter_name: names[i] } : {}),
          text: String(v ?? '-').replace(/\s+/g, ' ').trim().slice(0, 200) || '-'
        }))
      }]
    };
  } else {
    template = { name: 'hello_world', language: { code: 'en_US' } };
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template })
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data.error?.message || 'Unknown error';
      console.error('Admin WhatsApp notification failed:', msg);
      return { ok: false, status: 502, error: 'WhatsApp: ' + msg };
    }
    return { ok: true };
  } catch (error) {
    console.error('Admin WhatsApp notification failed:', error.message);
    return { ok: false, status: 502, error: 'Could not reach the WhatsApp API.' };
  }
}

app.get('/api/health', (req,res) => res.json({ ok: true, service: 'S Square Elite API' }));
app.get('/api/config', (req,res) => res.json({
 freeShippingMinItems: Number(process.env.FREE_SHIPPING_MIN_ITEMS || 5),
 flatDeliveryFee: Number(process.env.FLAT_DELIVERY_FEE || 40),
 razorpayEnabled: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
 razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
 giftWrapFee: giftWrapFee(),
 instagramUrl: process.env.INSTAGRAM_URL || '',
  shareBase: (process.env.API_PUBLIC_URL || '').replace(/\/$/, ''),
 siteUrl: (process.env.SITE_URL || (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0]).trim()
}));

function isAllowedEmail(email) {
 return /^[^\s@]+@(gmail\.com|yahoo\.com)$/i.test(
  String(email || '').trim()
 );
}

function isStrongPassword(password) {
 return typeof password === 'string' &&
  password.length >= 8 &&
  /[A-Z]/.test(password) &&
  /[a-z]/.test(password) &&
  /[0-9]/.test(password) &&
  /[^A-Za-z0-9]/.test(password);
}

app.post('/api/auth/register', rateLimit({ max: 15 }), async (req,res) => {
 try {
  const { name,email,password,phone } = req.body || {};

  if (!name?.trim() || !email?.trim() || !password) {
   return res.status(400).json({
    error: 'Name, email and password are required.'
   });
  }

  if (!isAllowedEmail(email)) {
   return res.status(400).json({
    error: 'Please use a valid @gmail.com or @yahoo.com email address.'
   });
  }

  if (!isStrongPassword(password)) {
   return res.status(400).json({
    error: 'Password must be at least 8 characters and include uppercase, lowercase, a number and a special character.'
   });
  }

  const normalized = email.trim().toLowerCase();
  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare('INSERT INTO users(name,email,phone,password_hash,role) VALUES(?,?,?,?,?)').run(name.trim(), normalized, phone?.trim() || '', hash, 'customer');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid);
  res.status(201).json({ token: signToken(user), user: safeUser(user) });
 } catch (e) { res.status(e.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500).json({error:e.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'An account with that email already exists.' : 'Could not create your account.'}); }
});
app.post('/api/auth/login', rateLimit({ max: 30 }), async (req,res) => {
 const { email,password } = req.body || {};

 if (!isAllowedEmail(email)) {
  return res.status(400).json({
   error: 'Please use a valid @gmail.com or @yahoo.com email address.'
  });
 }

 const user = db.prepare('SELECT * FROM users WHERE email=?').get(String(email||'').trim().toLowerCase());
 if (!user) return res.status(404).json({error:"Account doesn't exist. Please sign up first."});
 if (!(await bcrypt.compare(String(password||''), user.password_hash))) return res.status(401).json({error:'Incorrect password. Please try again.'});
 res.json({ token: signToken(user), user: safeUser(user) });
});
app.get('/api/auth/me', auth(), (req,res) => {
 const user = db.prepare('SELECT id,name,email,phone,role FROM users WHERE id=?').get(req.user.sub);
 if (!user) return res.status(401).json({error:'Account not found.'});
 res.json({user});
});
app.patch('/api/auth/profile', auth('customer'), (req,res) => {
 const { name, phone } = req.body || {};
 if (!name?.trim()) return res.status(400).json({error:'Name is required.'});
 db.prepare('UPDATE users SET name=?,phone=? WHERE id=?').run(name.trim(), String(phone||''), req.user.sub);
 res.json({user:db.prepare('SELECT id,name,email,phone,role FROM users WHERE id=?').get(req.user.sub)});
});

app.get('/api/products', (req,res) => {
 const { category, search, includeOutOfStock } = req.query;
 let sql = `SELECT ${productFields} FROM products WHERE active=1`;
 const args = [];
 if (category) { sql += ' AND category=?'; args.push(category); }
 if (search) { sql += ' AND (name LIKE ? OR category LIKE ? OR description LIKE ?)'; args.push(`%${search}%`,`%${search}%`,`%${search}%`); }
 if (includeOutOfStock !== 'true') sql += ' AND stock>0';
 sql += ' ORDER BY created_at DESC, id DESC';
 res.json({ products: db.prepare(sql).all(...args).map(publicProduct) });
});
app.get('/api/admin/summary', auth('admin'), (req,res) => {
 res.json({
  products: db.prepare('SELECT COUNT(*) n FROM products WHERE active=1').get().n,
  lowStock: db.prepare('SELECT COUNT(*) n FROM products WHERE active=1 AND stock>0 AND stock<=5').get().n,
  outOfStock: db.prepare('SELECT COUNT(*) n FROM products WHERE active=1 AND stock=0').get().n,
  orders: db.prepare('SELECT COUNT(*) n FROM orders').get().n,
  pendingOrders: db.prepare("SELECT COUNT(*) n FROM orders WHERE order_status NOT IN ('delivered','cancelled','refunded')").get().n,
  revenue: db.prepare("SELECT COALESCE(SUM(total),0) n FROM orders WHERE payment_status='paid'").get().n
 });
});
app.get('/api/admin/products', auth('admin'), (req,res) => res.json({products:db.prepare(`SELECT ${productFields} FROM products ORDER BY active DESC, name`).all().map(publicProduct)}));
app.post('/api/admin/products', auth('admin'), (req,res) => {
 const p = req.body || {};
 if (!p.name?.trim() || !p.category?.trim() || !Number.isFinite(Number(p.price)) || Number(p.price)<0) return res.status(400).json({error:'Product name, category and a valid price are required.'});
 const slug = makeSlug(p.slug || p.name) + '-' + crypto.randomBytes(3).toString('hex');
 const result = db.prepare('INSERT INTO products(name,slug,category,description,price,old_price,image,images,tag,stock,active) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run(p.name.trim(),slug,p.category.trim(),String(p.description||''),Number(p.price),Number(p.oldPrice||0),String(p.image||''),JSON.stringify(cleanImages(p.images)),String(p.tag||''),Math.max(0,Math.floor(Number(p.stock||0))),p.active===false?0:1);
 res.status(201).json({product:publicProduct(db.prepare(`SELECT ${productFields} FROM products WHERE id=?`).get(result.lastInsertRowid))});
});
app.patch('/api/admin/products/:id', auth('admin'), (req,res) => {
 const current = db.prepare(`SELECT ${productFields} FROM products WHERE id=?`).get(req.params.id);
 if (!current) return res.status(404).json({error:'Product not found.'});
 const p = req.body || {};
 const next = {
  name: p.name ?? current.name, category: p.category ?? current.category, description: p.description ?? current.description,
  price: p.price === undefined ? current.price : Number(p.price), old_price: p.oldPrice === undefined ? current.old_price : Number(p.oldPrice),
  image: p.image ?? current.image, images: p.images === undefined ? current.images : JSON.stringify(cleanImages(p.images)), tag: p.tag ?? current.tag, stock: p.stock === undefined ? current.stock : Math.max(0,Math.floor(Number(p.stock))),
  active: p.active === undefined ? current.active : (p.active ? 1 : 0)
 };
 if (!String(next.name).trim() || !String(next.category).trim() || !Number.isFinite(next.price) || next.price<0 || !Number.isFinite(next.stock)) return res.status(400).json({error:'Check product name, category, price and stock.'});
 db.prepare('UPDATE products SET name=?,category=?,description=?,price=?,old_price=?,image=?,images=?,tag=?,stock=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
 .run(next.name,next.category,next.description,next.price,next.old_price,next.image,next.images,next.tag,next.stock,next.active,req.params.id);
 res.json({product:publicProduct(db.prepare(`SELECT ${productFields} FROM products WHERE id=?`).get(req.params.id))});
});
app.delete('/api/admin/products/:id', auth('admin'), (req,res) => {
 const result = db.prepare('UPDATE products SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id);
 if (!result.changes) return res.status(404).json({error:'Product not found.'});
 res.json({ok:true});
});

app.get('/api/addresses', auth('customer'), (req,res) => res.json({addresses:db.prepare('SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC,id DESC').all(req.user.sub)}));
app.post('/api/addresses', auth('customer'), (req,res) => {
 const a = req.body || {};
 if (!a.recipient?.trim() || !a.phone?.trim() || !a.line1?.trim() || !a.city?.trim() || !a.state?.trim() || !a.postal_code?.trim()) return res.status(400).json({error:'Please complete recipient, phone and full address.'});
 const isDefault = a.is_default ? 1 : 0;
 const tx = db.transaction(() => {
  if (isDefault) db.prepare('UPDATE addresses SET is_default=0 WHERE user_id=?').run(req.user.sub);
  const r = db.prepare('INSERT INTO addresses(user_id,label,recipient,phone,line1,line2,city,state,postal_code,is_default) VALUES(?,?,?,?,?,?,?,?,?,?)')
   .run(req.user.sub,a.label||'Home',a.recipient.trim(),a.phone.trim(),a.line1.trim(),String(a.line2||''),a.city.trim(),a.state.trim(),a.postal_code.trim(),isDefault);
  return db.prepare('SELECT * FROM addresses WHERE id=?').get(r.lastInsertRowid);
 });
 res.status(201).json({address:tx()});
});
app.delete('/api/addresses/:id', auth('customer'), (req,res) => {
 const r=db.prepare('DELETE FROM addresses WHERE id=? AND user_id=?').run(req.params.id,req.user.sub);
 if (!r.changes) return res.status(404).json({error:'Address not found.'});
 res.json({ok:true});
});

const service = createOrdersService({ db, mail, notifyAdmin: sendAdminWhatsApp });
registerCheckoutRoutes(app, { db, service, auth, optionalAuth, getRazorpay, notifyAdmin: sendAdminWhatsApp });
registerAccountRoutes(app, { db, auth, mail, isStrongPassword });
registerCatalogRoutes(app, { db, auth, publicProduct, productFields, uploadsDir: process.env.UPLOADS_DIR || path.resolve(__dirname, 'uploads') });
registerCartRoutes(app, { db, auth });
startAbandonedCartJob({ db, mail });
registerGuestCartRoutes(app, { db });
startGuestCartJob({ db, mail });
registerShareRoutes(app, { db });
registerBannerRoutes(app, { db, auth });
app.get('/api/admin/customers', auth('admin'), (req,res) => {
 res.json({customers:db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.created_at,COUNT(o.id) order_count,COALESCE(SUM(CASE WHEN o.payment_status='paid' THEN o.total ELSE 0 END),0) spend FROM users u LEFT JOIN orders o ON o.user_id=u.id WHERE u.role='customer' GROUP BY u.id ORDER BY u.created_at DESC`).all()});
});
app.post('/api/newsletter', (req,res) => {
 const email=String(req.body?.email||'').trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:'Enter a valid email address.'});
 try{db.prepare('INSERT INTO newsletter(email) VALUES(?)').run(email);res.status(201).json({ok:true})}
 catch(e){if(e.code==='SQLITE_CONSTRAINT_UNIQUE')return res.json({ok:true});res.status(500).json({error:'Could not subscribe right now.'})}
});
app.get('/api/admin/coupons', auth('admin'), (req,res) => res.json({coupons:db.prepare('SELECT * FROM coupons ORDER BY id DESC').all()}));
app.post('/api/admin/coupons', auth('admin'), (req,res) => {
 const c=req.body||{};
 const code=String(c.code||'').trim().toUpperCase();
 if(!code||!['percent','fixed'].includes(c.type)||!Number.isInteger(Number(c.value))||Number(c.value)<=0)return res.status(400).json({error:'Enter a code, type and positive integer value.'});
 try{const r=db.prepare('INSERT INTO coupons(code,type,value,min_total,active,usage_limit) VALUES(?,?,?,?,?,?)').run(code,c.type,Number(c.value),Number(c.minTotal||0),c.active===false?0:1,c.usageLimit?Number(c.usageLimit):null);res.status(201).json({coupon:db.prepare('SELECT * FROM coupons WHERE id=?').get(r.lastInsertRowid)})}
 catch(e){res.status(409).json({error:'That coupon code already exists.'})}
});
app.post('/api/admin/whatsapp/test', auth('admin'), async (req, res) => {
  const r = await sendAdminWhatsApp({
    order: { order_number: 'TEST-0001', total: 1, payment_method: 'bank_transfer', payment_status: 'pending' },
    statusText: 'Test message - please ignore'
  });
  if (!r.ok) return res.status(r.status || 502).json({ error: r.error || 'WhatsApp test message failed. Check the backend terminal for details.' });
  res.json({ message: 'WhatsApp test message accepted by Meta.' });
});
// --- Serve the built React frontend (dist) from this same server ---
const distDir = path.resolve(__dirname, '..', 'dist');
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(express.static(distDir, { index: false, maxAge: '1h' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  console.warn('dist/ not found - run "npm run build" to serve the frontend from this server.');
}
app.use((err,req,res,next)=>{if(err instanceof HttpError)return res.status(err.status).json({error:err.message});console.error(err);res.status(500).json({error:'Unexpected server error.'})});
const port=Number(process.env.PORT||4000);
app.listen(port,()=>console.log(`S Square Elite API listening on http://localhost:${port}`));