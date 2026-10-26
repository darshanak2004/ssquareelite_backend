import crypto from 'node:crypto';
import { HttpError, wrap, rateLimit } from '../lib/http.js';
import { shippingFor, giftWrapFee, ORDER_STATUSES } from '../lib/orders.js';
import { checkPincode } from '../lib/pincode.js';

export function registerCheckoutRoutes(app, { db, service, auth, optionalAuth, getRazorpay, notifyAdmin }) {
  const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  app.post('/api/checkout/quote', optionalAuth, wrap((req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) throw new HttpError(400, 'Your cart is empty.');
    let subtotal = 0, itemCount = 0;
    for (const i of items) {
      const p = db.prepare('SELECT id,name,price,stock FROM products WHERE id=? AND active=1').get(Number(i.productId ?? i.id));
      const q = Math.floor(Number(i.quantity ?? 1));
      if (!p || q < 1) throw new HttpError(400, 'A product or quantity in your cart is invalid.');
      if (p.stock < q) throw new HttpError(409, `Only ${p.stock} unit(s) of ${p.name} remain.`);
      subtotal += p.price * q; itemCount += q;
    }
    const giftFee = req.body?.gift?.wrap ? giftWrapFee() : 0;
    const deliveryFee = shippingFor(itemCount);
    const pin = req.body?.postalCode ? checkPincode(req.body.postalCode) : null;
    res.json({ subtotal, discount: 0, deliveryFee, giftFee, total: subtotal + deliveryFee + giftFee, itemCount, freeShipping: itemCount >= Number(process.env.FREE_SHIPPING_MIN_ITEMS || 5), pincode: pin });
  }));

  app.post('/api/checkout/razorpay/order', optionalAuth, wrap(async (req, res) => {
    const rp = getRazorpay();
    if (!rp) throw new HttpError(503, 'Online payments are not configured yet. Add Razorpay test credentials to backend/.env.');
    const info = service.prepareOrder(req.body, req.user, 'razorpay');
    let rpOrder;
    try { rpOrder = await rp.orders.create({ amount: info.total * 100, currency: 'INR', receipt: info.orderNumber, notes: { orderNumber: info.orderNumber } }); }
    catch { throw new HttpError(502, 'Could not start the payment. Please try again.'); }
    const orderId = service.create(info, 'pending', null, rpOrder.id);
    res.status(201).json({ orderId, orderNumber: info.orderNumber, amount: info.total, currency: 'INR', razorpayOrderId: rpOrder.id, keyId: process.env.RAZORPAY_KEY_ID, subtotal: info.subtotal, deliveryFee: info.deliveryFee, giftFee: info.giftFee, discount: info.discount });
  }));

  app.post('/api/checkout/razorpay/verify', optionalAuth, wrap((req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderNumber } = req.body || {};
    if (!process.env.RAZORPAY_KEY_SECRET) throw new HttpError(503, 'Payments are not configured.');
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (!razorpay_signature || !safeEq(expected, razorpay_signature)) throw new HttpError(400, 'Payment signature could not be verified.');
    const order = db.prepare('SELECT order_number FROM orders WHERE order_number=? AND razorpay_order_id=?').get(orderNumber, razorpay_order_id);
    if (!order) throw new HttpError(404, 'Order could not be found.');
    const r = service.markPaid({ razorpayOrderId: razorpay_order_id, paymentId: razorpay_payment_id });
    res.json({ ok: true, orderNumber: order.order_number, paymentStatus: 'paid', alreadyProcessed: Boolean(r.already) });
  }));

  app.post('/api/checkout/bank-transfer', optionalAuth, wrap((req, res) => {
    const info = service.prepareOrder(req.body, req.user, 'bank_transfer');
    const orderId = service.create(info, 'pending', null, null);
    res.status(201).json({ orderId, orderNumber: info.orderNumber, total: info.total, paymentStatus: 'pending', message: 'Order created. The bank transfer must be verified by the shop before the order is marked paid.' });
  }));

  app.post('/api/razorpay/webhook', (req, res) => {
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) return res.status(503).send('Webhook not configured');
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(req.rawBody || Buffer.from('')).digest('hex');
    if (!safeEq(req.headers['x-razorpay-signature'], expected)) return res.status(400).send('Invalid signature');
    let event; try { event = JSON.parse((req.rawBody || Buffer.from('')).toString('utf8')); } catch { return res.status(400).send('Invalid payload'); }
    if (event.event === 'payment.captured') {
      const p = event.payload?.payment?.entity;
      if (p?.order_id) service.markPaid({ razorpayOrderId: p.order_id, paymentId: p.id });
    }
    res.json({ received: true });
  });

  app.get('/api/orders/mine', auth('customer'), (req, res) =>
    res.json({ orders: db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC').all(req.user.sub).map(service.detail) }));
  app.get('/api/orders/mine/:orderNumber', auth('customer'), wrap((req, res) => {
    const row = db.prepare('SELECT * FROM orders WHERE order_number=? AND user_id=?').get(req.params.orderNumber, req.user.sub);
    if (!row) throw new HttpError(404, 'Order not found.');
    res.json({ order: { ...service.detail(row), events: db.prepare('SELECT status,note,created_at AS at FROM order_events WHERE order_id=? ORDER BY id').all(row.id) } });
  }));
  app.post('/api/orders/track', rateLimit({ max: 30 }), wrap((req, res) =>
    res.json({ order: service.trackView(req.body?.orderNumber, req.body?.phone) })));

  app.get('/api/admin/orders', auth('admin'), (req, res) => {
    const { status, search } = req.query;
    let sql = 'SELECT * FROM orders WHERE 1=1'; const args = [];
    if (status) { sql += ' AND order_status=?'; args.push(status); }
    if (search) { sql += ' AND (order_number LIKE ? OR customer_name LIKE ? OR email LIKE ? OR phone LIKE ?)'; args.push(...Array(4).fill(`%${search}%`)); }
    res.json({ orders: db.prepare(sql + ' ORDER BY id DESC').all(...args).map(service.detail) });
  });
  app.patch('/api/admin/orders/:id/status', auth('admin'), wrap((req, res) => {
    const { status, paymentStatus, trackingNumber, courier, note } = req.body || {};
    if (status && !ORDER_STATUSES.includes(status)) throw new HttpError(400, 'Invalid order status.');
    if (paymentStatus && !['pending', 'paid', 'failed', 'refunded'].includes(paymentStatus)) throw new HttpError(400, 'Invalid payment status.');
    if (!status && !paymentStatus && trackingNumber === undefined && courier === undefined) throw new HttpError(400, 'No status provided.');
    res.json({ order: service.updateOrder(Number(req.params.id), { status, paymentStatus, trackingNumber, courier, note }) });
  }));
}
