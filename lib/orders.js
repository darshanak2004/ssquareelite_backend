import crypto from 'node:crypto';
import { HttpError, digits } from './http.js';
import { checkPincode } from './pincode.js';
import * as T from './emailTemplates.js';

export const shippingFor = n => n >= Number(process.env.FREE_SHIPPING_MIN_ITEMS || 5) ? 0 : Number(process.env.FLAT_DELIVERY_FEE || 40);
export const giftWrapFee = () => Number(process.env.GIFT_WRAP_FEE || 49);
const CLOSED = ['cancelled', 'refunded'];
export const ORDER_STATUSES = ['placed', 'confirmed', 'processing', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'refunded'];

export function createOrdersService({ db, mail, notifyAdmin }) {
  const itemsOf = id => db.prepare('SELECT id,product_id AS productId,product_name AS name,image,unit_price AS price,quantity,line_total AS lineTotal FROM order_items WHERE order_id=?').all(id);
  const addEvent = (orderId, status, note = '') => db.prepare('INSERT INTO order_events(order_id,status,note) VALUES(?,?,?)').run(orderId, status, note);
  const getOrder = id => db.prepare('SELECT * FROM orders WHERE id=?').get(id);

  function detail(row) {
    let address = {}; try { address = JSON.parse(row.address_json); } catch { /* keep empty */ }
    const n = k => Number(row[k]);
    return { ...row, items: itemsOf(row.id), address, subtotal: n('subtotal'), discount: n('discount'), delivery_fee: n('delivery_fee'), total: n('total'), item_count: n('item_count'),
      gift_wrap: Boolean(row.gift_wrap), gift_hide_price: Boolean(row.gift_hide_price), needs_review: Boolean(row.needs_review) };
  }

  // Validates everything and prices the cart on the server. Throws HttpError; never touches res.
  function prepareOrder(body = {}, user, paymentMethod) {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > 100) throw new HttpError(400, 'Your cart is empty or contains too many items.');
    const customer = body.customer || {}, address = body.address || {};
    if (!customer.name?.trim() || !customer.email?.trim() || !customer.phone?.trim()) throw new HttpError(400, 'Customer name, email and phone are required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email.trim())) throw new HttpError(400, 'Please enter a valid email address.');
    if (digits(customer.phone).length < 10) throw new HttpError(400, 'Please enter a valid phone number.');
    if (!address.line1?.trim() || !address.city?.trim() || !address.state?.trim() || !address.postal_code?.trim()) throw new HttpError(400, 'Please enter a complete delivery address.');
    const pin = checkPincode(address.postal_code);
    if (!pin.valid || !pin.serviceable) throw new HttpError(400, pin.message);

    const qtyById = new Map();
    for (const item of items) {
      const id = Number(item.productId ?? item.id), qty = Math.floor(Number(item.quantity ?? 1));
      if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 99) throw new HttpError(400, 'One of the cart items has an invalid quantity.');
      qtyById.set(id, (qtyById.get(id) || 0) + qty);
    }
    const productRows = [];
    for (const [id, qty] of qtyById) {
      const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);
      if (!p) throw new HttpError(400, 'A product in your cart is no longer available.');
      if (p.stock < qty) throw new HttpError(409, `Only ${p.stock} unit(s) of ${p.name} remain in stock.`);
      productRows.push({ p, qty });
    }

    const g = body.gift || {};
    const giftMessage = String(g.message || '').trim();
    if (giftMessage.length > 200) throw new HttpError(400, 'Gift message can be at most 200 characters.');
    const gift = { wrap: Boolean(g.wrap), message: giftMessage, hidePrice: Boolean(g.hidePrice), recipient: String(g.recipient || '').trim().slice(0, 80) };
    const giftFee = gift.wrap ? giftWrapFee() : 0;

    const itemCount = productRows.reduce((n, x) => n + x.qty, 0);
    const subtotal = productRows.reduce((n, x) => n + x.p.price * x.qty, 0);
    let discount = 0, couponCode = null;
    if (body.coupon) {
      const code = String(body.coupon).trim().toUpperCase();
      const c = db.prepare('SELECT * FROM coupons WHERE code=? AND active=1').get(code);
      const now = new Date().toISOString();
      if (c && subtotal >= c.min_total && (!c.starts_at || c.starts_at <= now) && (!c.ends_at || c.ends_at >= now) && (!c.usage_limit || c.used_count < c.usage_limit)) {
        discount = c.type === 'percent' ? Math.round(subtotal * Math.min(c.value, 100) / 100) : Math.min(c.value, subtotal);
        if (discount > 0) couponCode = code;
      }
    }
    const deliveryFee = shippingFor(itemCount);
    const total = Math.max(0, subtotal - discount + deliveryFee + giftFee);
    const orderNumber = 'SQE-' + new Date().toISOString().slice(2, 10).replaceAll('-', '') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const addressJson = JSON.stringify({ ...address, postal_code: address.postal_code.trim(), recipient: gift.recipient || address.recipient || customer.name, phone: address.phone || customer.phone });
    return { orderNumber, subtotal, discount, deliveryFee, giftFee, total, itemCount, productRows, addressJson, gift, couponCode, customer, notes: String(body.notes || ''), userId: user?.sub || null, paymentMethod };
  }

  function deductStock(orderId) {
    let oversold = false;
    for (const it of db.prepare('SELECT product_id,quantity FROM order_items WHERE order_id=?').all(orderId)) {
      const r = db.prepare('UPDATE products SET stock=stock-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND stock>=?').run(it.quantity, it.product_id, it.quantity);
      if (!r.changes) { oversold = true; db.prepare('UPDATE products SET stock=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(it.product_id); }
    }
    db.prepare('UPDATE orders SET stock_deducted=1 WHERE id=?').run(orderId);
    return oversold;
  }

  // Inserts the order. Bank transfers reserve stock immediately; Razorpay orders deduct on payment (markPaid).
  function create(info, paymentStatus, paymentRef = null, razorpayOrderId = null) {
    const orderId = db.transaction(() => {
      const r = db.prepare(`INSERT INTO orders(order_number,user_id,customer_name,email,phone,address_json,subtotal,discount,delivery_fee,total,item_count,payment_method,payment_status,payment_reference,razorpay_order_id,notes,gift_wrap,gift_wrap_fee,gift_message,gift_hide_price,gift_recipient,coupon_code)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(info.orderNumber, info.userId, info.customer.name.trim(), info.customer.email.trim().toLowerCase(), info.customer.phone.trim(), info.addressJson,
        info.subtotal, info.discount, info.deliveryFee, info.total, info.itemCount, info.paymentMethod, paymentStatus, paymentRef, razorpayOrderId, info.notes,
        info.gift.wrap ? 1 : 0, info.giftFee, info.gift.message, info.gift.hidePrice ? 1 : 0, info.gift.recipient, info.couponCode);
      const id = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT INTO order_items(order_id,product_id,product_name,image,unit_price,quantity,line_total) VALUES(?,?,?,?,?,?,?)');
      for (const { p, qty } of info.productRows) ins.run(id, p.id, p.name, p.image, p.price, qty, p.price * qty);
      if (info.paymentMethod === 'bank_transfer') {
        for (const { p, qty } of info.productRows) {
          const u = db.prepare('UPDATE products SET stock=stock-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND stock>=?').run(qty, p.id, qty);
          if (!u.changes) throw new HttpError(409, `Only a few units of ${p.name} remain — please reduce the quantity.`);
        }
        db.prepare('UPDATE orders SET stock_deducted=1 WHERE id=?').run(id);
      }
      if (info.couponCode) db.prepare('UPDATE coupons SET used_count=used_count+1 WHERE code=?').run(info.couponCode);
      if (info.userId) db.prepare('DELETE FROM abandoned_carts WHERE user_id=?').run(info.userId);
            db.prepare('DELETE FROM guest_carts WHERE email=?').run(info.customer.email.trim().toLowerCase());
      addEvent(id, 'placed', info.paymentMethod === 'bank_transfer' ? 'Order placed — awaiting bank transfer' : 'Order placed — awaiting payment');
      return id;
    })();
    if (info.paymentMethod === 'bank_transfer') afterPlaced(orderId);
    return orderId;
  }

  function afterPlaced(orderId) {
    const o = getOrder(orderId);
    const t = T.orderPlaced(o, itemsOf(o.id));
    void mail.sendMail({ to: o.email, kind: 'order_placed', ...t });
    const a = T.adminAlert(o);
    if (process.env.ADMIN_EMAIL) void mail.sendMail({ to: process.env.ADMIN_EMAIL, kind: 'admin_alert', ...a });
   void notifyAdmin?.({ order: o });
  }

  // Idempotent: the Razorpay /verify call, the webhook and the admin "mark paid" can all call this safely.
  function markPaid({ orderNumber, razorpayOrderId, paymentId = null }) {
    const res = db.transaction(() => {
      const o = razorpayOrderId
        ? db.prepare('SELECT * FROM orders WHERE razorpay_order_id=?').get(razorpayOrderId)
        : db.prepare('SELECT * FROM orders WHERE order_number=?').get(orderNumber);
      if (!o) return { found: false };
      if (o.payment_status === 'paid') return { found: true, already: true, orderId: o.id };
      db.prepare("UPDATE orders SET payment_status='paid',payment_reference=COALESCE(?,payment_reference),paid_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(paymentId, o.id);
      let oversold = false;
      if (!o.stock_deducted && !CLOSED.includes(o.order_status)) oversold = deductStock(o.id);
      if (oversold || CLOSED.includes(o.order_status)) db.prepare('UPDATE orders SET needs_review=1 WHERE id=?').run(o.id);
      addEvent(o.id, 'paid', 'Payment received');
      return { found: true, already: false, oversold, orderId: o.id, method: o.payment_method };
    })();
    if (res.found && !res.already) {
      if (res.method === 'razorpay') afterPlaced(res.orderId);
   if (res.oversold) void notifyAdmin?.({ order: getOrder(res.orderId), statusText: 'Paid - stock short, needs manual review' });
    }
    return res;
  }

  // Admin update: status, payment status, tracking. Restocks and releases the coupon on cancel/refund.
  function updateOrder(id, { status, paymentStatus, trackingNumber, courier, note }) {
    const before = getOrder(id);
    if (!before) throw new HttpError(404, 'Order not found.');
    if (status && CLOSED.includes(before.order_status) && status !== before.order_status) throw new HttpError(409, 'Cancelled or refunded orders cannot be reopened. Place a new order instead.');
    if (paymentStatus === 'paid') markPaid({ orderNumber: before.order_number });
    db.transaction(() => {
      const f = [], a = [];
      if (status) { f.push('order_status=?'); a.push(status); }
      if (paymentStatus && paymentStatus !== 'paid') { f.push('payment_status=?'); a.push(paymentStatus); }
      if (trackingNumber !== undefined) { f.push('tracking_number=?'); a.push(String(trackingNumber).trim().slice(0, 80)); }
      if (courier !== undefined) { f.push('courier=?'); a.push(String(courier).trim().slice(0, 60)); }
      if (f.length) db.prepare(`UPDATE orders SET ${f.join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...a, id);
      const now = getOrder(id);
      if (status && status !== before.order_status) {
        addEvent(id, status, note || '');
        if (CLOSED.includes(status)) {
          if (now.stock_deducted && !now.restocked) {
            for (const it of db.prepare('SELECT product_id,quantity FROM order_items WHERE order_id=?').all(id))
              db.prepare('UPDATE products SET stock=stock+?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(it.quantity, it.product_id);
            db.prepare('UPDATE orders SET restocked=1 WHERE id=?').run(id);
          }
          if (now.coupon_code && !now.coupon_released) {
            db.prepare('UPDATE coupons SET used_count=MAX(0,used_count-1) WHERE code=?').run(now.coupon_code);
            db.prepare('UPDATE orders SET coupon_released=1 WHERE id=?').run(id);
          }
        }
      } else if (trackingNumber) addEvent(id, 'tracking', `Tracking number added${courier ? ' (' + courier + ')' : ''}`);
    })();
    const after = getOrder(id);
    if (status && status !== before.order_status) {
      const tpl = status === 'shipped' ? T.orderShipped(after) : status === 'delivered' ? T.orderDelivered(after) : status === 'cancelled' ? T.orderCancelled(after) : T.orderUpdate(after, status);
      if (tpl) void mail.sendMail({ to: after.email, kind: 'order_' + status, ...tpl });
    }
    return detail(after);
  }

  function trackView(orderNumber, phone) {
    const o = db.prepare('SELECT * FROM orders WHERE order_number=?').get(String(orderNumber || '').trim().toUpperCase());
    const last10 = s => digits(s).slice(-10);
    if (!o || last10(o.phone).length < 10 || last10(o.phone) !== last10(phone)) throw new HttpError(404, 'We could not find an order with those details.');
    let city = '', pin = ''; try { const a = JSON.parse(o.address_json); city = a.city; pin = a.postal_code; } catch { /* ignore */ }
    return { orderNumber: o.order_number, status: o.order_status, paymentStatus: o.payment_status, createdAt: o.created_at, courier: o.courier, trackingNumber: o.tracking_number,
      city, pincode: pin, total: o.total, giftWrap: Boolean(o.gift_wrap), hidePrice: Boolean(o.gift_hide_price),
      items: itemsOf(o.id).map(i => ({ name: i.name, quantity: i.quantity, image: i.image, ...(o.gift_hide_price ? {} : { lineTotal: i.lineTotal }) })),
      events: db.prepare('SELECT status,note,created_at AS at FROM order_events WHERE order_id=? ORDER BY id').all(o.id) };
  }

  return { prepareOrder, create, markPaid, updateOrder, detail, trackView, getOrder };
}
