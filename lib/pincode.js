// Rule-based serviceability (NOT live courier data). Default: Tamil Nadu (PIN prefixes 600-643).
// Extend with SERVICEABLE_PIN_PREFIXES="600-643,605,670-679" (3-digit prefixes, ranges allowed).
// Fast zone (2-3 days) prefixes: FAST_PIN_PREFIXES, default "600-603".
function parse(spec) {
  const out = [];
  for (const part of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map(Number);
    if (Number.isInteger(a)) out.push([a, Number.isInteger(b) ? b : a]);
  }
  return out;
}
const inRanges = (n, ranges) => ranges.some(([a, b]) => n >= a && n <= b);
export function checkPincode(pin) {
  const p = String(pin || '').trim();
  if (!/^[1-9]\d{5}$/.test(p)) return { valid: false, serviceable: false, message: 'Enter a valid 6-digit PIN code.' };
  const prefix = Number(p.slice(0, 3));
  const served = parse(process.env.SERVICEABLE_PIN_PREFIXES || '600-643');
  if (!inRanges(prefix, served)) {
    return { valid: true, serviceable: false, message: `Sorry, we don't deliver to ${p} yet. We currently deliver within Tamil Nadu.` };
  }
  const fast = inRanges(prefix, parse(process.env.FAST_PIN_PREFIXES || '600-603'));
  return {
    valid: true, serviceable: true, pincode: p, etaDays: fast ? [2, 3] : [3, 5],
    message: `Great news — we deliver to ${p}. Estimated arrival: ${fast ? '2–3' : '3–5'} business days after dispatch.`
  };
}
