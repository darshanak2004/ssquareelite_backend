import { esc, money } from './http.js';
const site = () => (process.env.SITE_URL || (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0]).trim().replace(/\/$/, '');
const wrap = (title, body) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;padding:24px;color:#2b1a29">
<h2 style="color:#57244f;margin:0 0 12px">${esc(title)}</h2>${body}
<hr style="border:none;border-top:1px solid #eee;margin:24px 0"><p style="font-size:12px;color:#888">S Square Elite Gift Shop</p></div>`;
const btn = (href, label) => `<p><a href="${esc(href)}" style="background:#57244f;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${esc(label)}</a></p>`;
const lines = (items, hidePrice) => `<table style="width:100%;border-collapse:collapse">${items.map(i =>
  `<tr><td style="padding:6px 0">${esc(i.name)} × ${i.quantity}</td><td style="text-align:right">${hidePrice ? '' : money(i.lineTotal)}</td></tr>`).join('')}</table>`;
export const trackUrl = o => `${site()}/track?order=${encodeURIComponent(o.order_number)}`;

export function orderPlaced(o, items) {
  const paid = o.payment_status === 'paid';
  const subject = `Order ${o.order_number} received — thank you!`;
  const html = wrap('Thank you for your order!', `<p>Hi ${esc(o.customer_name)}, we've received your order <b>${esc(o.order_number)}</b>.</p>
${lines(items, false)}<p><b>Total: ${money(o.total)}</b> · ${paid ? 'Payment received' : 'Payment pending (bank transfer — we will confirm once it is verified)'}</p>
${o.gift_wrap ? '<p>🎀 Gift wrapping included.</p>' : ''}${btn(trackUrl(o), 'Track your order')}`);
  return { subject, html, text: `Thank you ${o.customer_name}! Order ${o.order_number} total ${money(o.total)}. Track: ${trackUrl(o)}` };
}
export function orderShipped(o) {
  const t = o.tracking_number ? `<p>${o.courier ? esc(o.courier) + ' · ' : ''}Tracking number: <b>${esc(o.tracking_number)}</b></p>` : '';
  return { subject: `Your order ${o.order_number} is on its way`, html: wrap('Your order has shipped 🚚', `<p>Hi ${esc(o.customer_name)}, order <b>${esc(o.order_number)}</b> is on its way.</p>${t}${btn(trackUrl(o), 'Track your order')}`),
    text: `Order ${o.order_number} has shipped.${o.tracking_number ? ' Tracking: ' + o.tracking_number : ''} ${trackUrl(o)}` };
}
export function orderDelivered(o) {
  return { subject: `Order ${o.order_number} delivered`, html: wrap('Delivered — we hope it brings a smile 🎁', `<p>Hi ${esc(o.customer_name)}, your order <b>${esc(o.order_number)}</b> has been delivered.</p><p>Loved it? Sign in and leave a review on the product page — it helps other gift-givers.</p>${btn(site(), 'Visit the shop')}`),
    text: `Order ${o.order_number} was delivered. Reviews: ${site()}` };
}
export function orderCancelled(o) {
  return { subject: `Order ${o.order_number} cancelled`, html: wrap('Your order was cancelled', `<p>Hi ${esc(o.customer_name)}, order <b>${esc(o.order_number)}</b> has been cancelled. If you paid, we'll be in touch about your refund.</p>`),
    text: `Order ${o.order_number} was cancelled.` };
}
const UPDATES = {
  confirmed: ['Your order is confirmed', 'We have confirmed your order and will start preparing it soon.'],
  processing: ['We are preparing your order', 'Your gifts are being picked and checked with care.'],
  packed: ['Your order is packed', 'Your order is packed and waiting for our courier.'],
  out_for_delivery: ['Out for delivery 🚚', 'Your order is out for delivery. Please keep your phone handy.']
};
export function orderUpdate(o, status) {
  const u = UPDATES[status]; if (!u) return null;
  return { subject: `${u[0]} — ${o.order_number}`, html: wrap(u[0], `<p>Hi ${esc(o.customer_name)}, ${esc(u[1])}</p><p>Order <b>${esc(o.order_number)}</b></p>${btn(trackUrl(o), 'Track your order')}`),
    text: `${u[0]}. Order ${o.order_number}. Track: ${trackUrl(o)}` };
}
export function passwordReset(name, token) {
  const link = `${site()}/reset-password?token=${token}`;
  return { subject: 'Reset your S Square Elite password', html: wrap('Reset your password', `<p>Hi ${esc(name)}, use the button below to choose a new password. The link works once and expires in 1 hour.</p>${btn(link, 'Choose a new password')}<p style="font-size:12px;color:#888">Didn't ask for this? Ignore this email — your password stays the same.</p>`),
    text: `Reset your password (valid 1 hour): ${link}` };
}
export function abandonedCart(name, items, unsubscribeUrl = '') {
  const link = `${site()}/checkout`;
  const unsub = unsubscribeUrl ? ` <a href="${esc(unsubscribeUrl)}" style="color:#888">Unsubscribe</a>` : '';
  return { subject: 'You left something lovely in your bag', html: wrap('Still thinking it over?', `<p>Hi ${esc(name)}, these are still waiting in your bag:</p>${lines(items, false)}${btn(link, 'Complete my order')}<p style="font-size:12px;color:#888">Stock is limited and not reserved until you check out.${unsub}</p>`),
    text: `Your bag is waiting: ${items.map(i => i.name + ' × ' + i.quantity).join(', ')}. ${link}${unsubscribeUrl ? ' Unsubscribe: ' + unsubscribeUrl : ''}` };
}
export function adminAlert(o) {
  return { subject: `New order ${o.order_number} (${money(o.total)})`, html: wrap('New order', `<p>${esc(o.customer_name)} · ${esc(o.phone)} · ${esc(o.payment_method)} · ${esc(o.payment_status)}</p><p><b>${money(o.total)}</b></p>`),
    text: `New order ${o.order_number}: ${money(o.total)} (${o.payment_method}, ${o.payment_status})` };
}