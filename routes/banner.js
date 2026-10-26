import { wrap, HttpError } from '../lib/http.js';

const THEMES = ['berry', 'sunset', 'mint', 'gold'];
const defaults = { enabled: false, emoji: '🎉', text: '', linkLabel: '', link: '', theme: 'berry', endsAt: '' };
const read = db => {
  const r = db.prepare("SELECT value FROM site_settings WHERE key='banner'").get();
  try { return { ...defaults, ...JSON.parse(r?.value || '{}') }; } catch { return { ...defaults }; }
};

export function registerBannerRoutes(app, { db, auth }) {
  app.get('/api/banner', (req, res) => {
    const b = read(db);
    const expired = b.endsAt && new Date(b.endsAt + 'T23:59:59') < new Date();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ banner: b.enabled && b.text && !expired ? { emoji: b.emoji, text: b.text, linkLabel: b.linkLabel, link: b.link, theme: b.theme } : null });
  });
  app.get('/api/admin/banner', auth('admin'), (req, res) => res.json({ banner: read(db) }));
  app.put('/api/admin/banner', auth('admin'), wrap((req, res) => {
    const b = req.body || {};
    const next = {
      enabled: Boolean(b.enabled), emoji: String(b.emoji || '').trim().slice(0, 8), text: String(b.text || '').trim(),
      linkLabel: String(b.linkLabel || '').trim(), link: String(b.link || '').trim(), theme: String(b.theme || 'berry'), endsAt: String(b.endsAt || '').trim()
    };
    if (next.text.length > 140) throw new HttpError(400, 'Banner text can be at most 140 characters.');
    if (next.enabled && !next.text) throw new HttpError(400, 'Write the banner text before switching it on.');
    if (!THEMES.includes(next.theme)) throw new HttpError(400, 'Choose one of the colour themes.');
    if (next.linkLabel.length > 30) throw new HttpError(400, 'Button text can be at most 30 characters.');
    if (next.link && !/^\/(?!\/)/.test(next.link) && !/^https:\/\//i.test(next.link)) throw new HttpError(400, 'The link must start with / (a page on your shop) or https://.');
    if (next.endsAt && !/^\d{4}-\d{2}-\d{2}$/.test(next.endsAt)) throw new HttpError(400, 'End date must look like 2026-11-15.');
    db.prepare("INSERT INTO site_settings(key,value) VALUES('banner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
    res.json({ banner: next });
  }));
}