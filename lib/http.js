export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const wrap = fn => (req, res, next) =>
  Promise.resolve().then(() => fn(req, res, next)).catch(e =>
    e instanceof HttpError ? res.status(e.status).json({ error: e.message }) : next(e));

export function rateLimit({ windowMs = 15 * 60 * 1000, max = 20, message = 'Too many attempts. Please try again in a few minutes.' } = {}) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(req.ip, h); }
    if (++h.n > max) { res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000))); return res.status(429).json({ error: message }); }
    next();
  };
}
export const digits = s => String(s || '').replace(/\D/g, '');
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = n => '₹' + Number(n || 0).toLocaleString('en-IN');
