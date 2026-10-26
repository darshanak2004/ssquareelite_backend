
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.DATABASE_FILE ||
  path.join(here, '..', 'data', 'ssquare.sqlite');

fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

const [name, emailInput, password] = process.argv.slice(2);
const email = String(emailInput || '').trim().toLowerCase();

function isAllowedEmail(value) {
  return /^[^\s@]+@(gmail\.com|yahoo\.com)$/.test(value);
}

function isStrongPassword(value) {
  return typeof value === 'string' &&
    value.length >= 8 &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /[0-9]/.test(value) &&
    /[^A-Za-z0-9]/.test(value);
}

if (!name?.trim() || !isAllowedEmail(email)) {
  console.error('Enter an admin name and a valid @gmail.com or @yahoo.com email.');
  process.exit(1);
}

if (!isStrongPassword(password)) {
  console.error(
    'Password must have at least 8 characters, uppercase, lowercase, a number and a special character.'
  );
  process.exit(1);
}

const db = new Database(file);

try {
  const hash = await bcrypt.hash(password, 12);
  const existing = db.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).get(email);

  if (existing) {
    db.prepare(
      "UPDATE users SET name = ?, password_hash = ?, role = 'admin' WHERE id = ?"
    ).run(name.trim(), hash, existing.id);

    console.log('Existing account promoted to admin and password updated.');
  } else {
    db.prepare(
      "INSERT INTO users(name, email, password_hash, role) VALUES(?, ?, ?, 'admin')"
    ).run(name.trim(), email, hash);

    console.log('Admin account created.');
  }
} finally {
  db.close();
}
