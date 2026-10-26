import nodemailer from 'nodemailer';
// SMTP_HOST/PORT/USER/PASS/SECURE + MAIL_FROM. Without SMTP_HOST, emails are written to the console and email_outbox ("logged").
export function createMailer(db) {
  const transport = process.env.SMTP_HOST ? nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  }) : null;
  const from = process.env.MAIL_FROM || 'S Square Elite <no-reply@localhost>';
  const log = db.prepare('INSERT INTO email_outbox(to_email,subject,kind,status,error) VALUES(?,?,?,?,?)');
  async function sendMail({ to, subject, html, text, kind = 'general' }) {
    if (!to) return { ok: false };
    if (!transport) {
      console.log(`[mail:not-configured] ${kind} -> ${to} | ${subject}\n${text || ''}\n`);
      log.run(to, subject, kind, 'logged', null);
      return { ok: true, logged: true };
    }
    try { await transport.sendMail({ from, to, subject, html, text }); log.run(to, subject, kind, 'sent', null); return { ok: true }; }
    catch (e) { console.error(`Email "${kind}" to ${to} failed:`, e.message); log.run(to, subject, kind, 'failed', String(e.message).slice(0, 300)); return { ok: false }; }
  }
  return { sendMail, configured: Boolean(transport) };
}
