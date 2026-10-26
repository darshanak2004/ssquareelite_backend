// Additive, idempotent migrations. Safe to run on every start and on the existing database.
export function runMigrations(db) {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
  const addCol = (t, c, def) => { if (!has(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const once = (name, fn) => {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name)) return;
    db.transaction(() => { fn(); db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(name); })();
  };

  once('001_features', () => {
    addCol('products', 'images', "TEXT NOT NULL DEFAULT '[]'");
    for (const [c, d] of [
      ['gift_wrap', 'INTEGER NOT NULL DEFAULT 0'], ['gift_wrap_fee', 'INTEGER NOT NULL DEFAULT 0'],
      ['gift_message', "TEXT NOT NULL DEFAULT ''"], ['gift_hide_price', 'INTEGER NOT NULL DEFAULT 0'],
      ['gift_recipient', "TEXT NOT NULL DEFAULT ''"], ['tracking_number', "TEXT NOT NULL DEFAULT ''"],
      ['courier', "TEXT NOT NULL DEFAULT ''"], ['razorpay_order_id', 'TEXT'], ['coupon_code', 'TEXT'],
      ['stock_deducted', 'INTEGER NOT NULL DEFAULT 0'], ['restocked', 'INTEGER NOT NULL DEFAULT 0'],
      ['coupon_released', 'INTEGER NOT NULL DEFAULT 0'], ['needs_review', 'INTEGER NOT NULL DEFAULT 0'],
      ['paid_at', 'TEXT']
    ]) addCol('orders', c, d);
    // Orders created before this migration already had stock deducted under the old rules.
    db.exec("UPDATE orders SET stock_deducted=1 WHERE payment_status='paid' OR payment_method IN ('bank_transfer','cod')");
    db.exec("UPDATE orders SET razorpay_order_id=payment_reference WHERE payment_method='razorpay' AND payment_reference LIKE 'order_%'");
    db.exec(`
      CREATE TABLE IF NOT EXISTS order_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS wishlist (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, product_id)
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (product_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS abandoned_carts (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, email TEXT NOT NULL, cart_json TEXT NOT NULL,
        updated_at TEXT NOT NULL, reminded_at TEXT
      );
      CREATE TABLE IF NOT EXISTS email_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, to_email TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id);
      CREATE INDEX IF NOT EXISTS idx_orders_razorpay ON orders(razorpay_order_id);
    `);
  });
    once('002_guest_carts', () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS guest_carts (
          email TEXT PRIMARY KEY, cart_json TEXT NOT NULL, updated_at TEXT NOT NULL, reminded_at TEXT,
          unsub_token TEXT NOT NULL, unsubscribed INTEGER NOT NULL DEFAULT 0
        );
      `);
    });
      once('003_site_settings', () => {
        db.exec('CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      });
}
