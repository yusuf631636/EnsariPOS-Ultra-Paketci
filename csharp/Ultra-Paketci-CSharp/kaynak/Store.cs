using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Alfa;

namespace Ultra
{
    // db.js karsiligi - AYNI SQLite dosyasi (data/gelismis-kurye.db) ve ayni tablolar; mevcut veriler aynen kullanilir.
    public static class Store
    {
        static Sqlite db;

        public static void Open(string root)
        {
            db = new Sqlite(Path.Combine(root, "data", "gelismis-kurye.db"), root);
            db.Exec("PRAGMA journal_mode = WAL;");
            db.Exec("PRAGMA busy_timeout = 5000;");
            db.Exec(@"
  CREATE TABLE IF NOT EXISTS delivery_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id     INTEGER,
    courier_name  TEXT,
    event         TEXT NOT NULL,
    detail        TEXT,
    amount        REAL,
    at            TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS courier_locations (
    courier_name TEXT PRIMARY KEY,
    lat          REAL NOT NULL,
    lng          REAL NOT NULL,
    accuracy     REAL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token         TEXT PRIMARY KEY,
    role          TEXT NOT NULL,
    courier_id    TEXT,
    courier_name  TEXT,
    expires       INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS courier_settings (
    courier_name    TEXT PRIMARY KEY,
    notify_enabled  INTEGER NOT NULL DEFAULT 1,
    updated_by      TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint      TEXT PRIMARY KEY,
    courier_name  TEXT,
    role          TEXT NOT NULL DEFAULT 'courier',
    subscription  TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );");
            db.Exec("DELETE FROM sessions WHERE expires < " + J.NowMs());
            var cols = new HashSet<string>(db.All("PRAGMA table_info(delivery_events)").Select(c => J.S(c, "name")));
            Action<string, string> addCol = (n, t) => { if (!cols.Contains(n)) db.Exec("ALTER TABLE delivery_events ADD COLUMN " + n + " " + t); };
            addCol("payment_type_id", "INTEGER"); addCol("payment_type_name", "TEXT"); addCol("ticket_number", "TEXT"); addCol("customer_name", "TEXT");
            addCol("order_total", "REAL"); addCol("tendered_amount", "REAL"); addCol("change_amount", "REAL"); addCol("order_source", "TEXT");
        }

        public static void LogEvent(object ticketId, object courierName, string ev, object detail, object amount, Dictionary<string, object> e)
        {
            e = e ?? new Dictionary<string, object>();
            db.Run(@"INSERT INTO delivery_events
    (ticket_id, courier_name, event, detail, amount, payment_type_id, payment_type_name, ticket_number, customer_name, order_total, tendered_amount, change_amount, order_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ticketId, courierName, ev, detail, amount, J.Get(e, "paymentTypeId"), J.Get(e, "paymentTypeName"), J.Get(e, "ticketNumber"), J.Get(e, "customerName"),
                J.Get(e, "orderTotal"), J.Get(e, "tenderedAmount"), J.Get(e, "changeAmount"), J.Get(e, "orderSource"));
        }
        public static List<Dictionary<string, object>> RecentEvents(int limit) { return db.All("SELECT id, ticket_id, courier_name, event, detail, amount, at FROM delivery_events ORDER BY id DESC LIMIT ?", limit > 0 ? limit : 100); }
        public static List<Dictionary<string, object>> DeliverySummary(string s, string e)
        {
            return db.All(@"
    SELECT courier_name, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
    FROM delivery_events
    WHERE event='teslim-edildi' AND at >= ? AND at < ?
    GROUP BY courier_name ORDER BY total DESC", s, e);
        }
        public static List<Dictionary<string, object>> PaymentBreakdown(string s, string e)
        {
            return db.All(@"
    SELECT COALESCE(payment_type_name,'Bilinmiyor (eski kayıt)') AS payment_type_name,
      COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
    FROM delivery_events
    WHERE event='teslim-edildi' AND amount > 0 AND at >= ? AND at < ?
    GROUP BY COALESCE(payment_type_name,'Bilinmiyor (eski kayıt)') ORDER BY total DESC", s, e);
        }
        public static List<Dictionary<string, object>> DeliveryDetails(string s, string e)
        {
            return db.All(@"
    SELECT ticket_id, ticket_number, courier_name, customer_name, order_total,
      payment_type_name, amount, tendered_amount, change_amount, order_source, at
    FROM delivery_events
    WHERE event IN ('teslim-edildi','teslim-odeme-bekliyor') AND at >= ? AND at < ?
    ORDER BY at DESC", s, e);
        }
        public static List<Dictionary<string, object>> CourierDeliveries(string name, string s, string e)
        {
            return db.All(@"
    SELECT ticket_id, ticket_number, customer_name, amount, payment_type_name, at
    FROM delivery_events
    WHERE courier_name = ? AND event = 'teslim-edildi' AND at >= ? AND at < ?
    ORDER BY id DESC", name, s, e);
        }
        public static void SetCourierLocation(string name, double lat, double lng, object accuracy)
        {
            db.Run(@"INSERT INTO courier_locations (courier_name, lat, lng, accuracy, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(courier_name) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, accuracy=excluded.accuracy, updated_at=datetime('now')", name, lat, lng, accuracy);
        }
        public static List<Dictionary<string, object>> AllCourierLocations() { return db.All("SELECT courier_name, lat, lng, accuracy, updated_at FROM courier_locations"); }
        public static void SavePushSubscription(string endpoint, object courierName, string role, string json)
        {
            db.Run(@"INSERT INTO push_subscriptions (endpoint, courier_name, role, subscription, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(endpoint) DO UPDATE SET courier_name=excluded.courier_name, role=excluded.role, subscription=excluded.subscription",
                endpoint, courierName, string.IsNullOrEmpty(role) ? "courier" : role, json);
        }
        public static void RemovePushSubscription(string endpoint) { db.Run("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint); }
        public static List<Dictionary<string, object>> PushSubscriptionsForCourier(string name) { return db.All("SELECT endpoint, subscription FROM push_subscriptions WHERE role='courier' AND courier_name = ?", name); }
        public static List<Dictionary<string, object>> AllCourierPushSubscriptions() { return db.All("SELECT endpoint, courier_name, subscription FROM push_subscriptions WHERE role='courier'"); }
        public static bool GetCourierNotifyEnabled(object name)
        {
            var r = db.Get("SELECT notify_enabled FROM courier_settings WHERE courier_name = ?", name);
            return r == null || J.Truthy(r["notify_enabled"]);
        }
        public static void SetCourierNotifyEnabled(string name, bool enabled, string by)
        {
            db.Run(@"INSERT INTO courier_settings (courier_name, notify_enabled, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(courier_name) DO UPDATE SET notify_enabled=excluded.notify_enabled, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                name, enabled ? 1 : 0, string.IsNullOrEmpty(by) ? null : by);
        }
        public static List<Dictionary<string, object>> AllCourierNotifySettings() { return db.All("SELECT courier_name, notify_enabled, updated_at FROM courier_settings"); }
        public static void SaveSession(string token, string role, object courierId, object courierName, long expires)
        {
            db.Run("INSERT INTO sessions (token, role, courier_id, courier_name, expires) VALUES (?, ?, ?, ?, ?)", token, role, courierId, courierName, expires);
        }
        public static void TouchSession(string token, long expires) { db.Run("UPDATE sessions SET expires = ? WHERE token = ?", expires, token); }
        public static Dictionary<string, object> LoadSession(string token) { return db.Get("SELECT role, courier_id AS courierId, courier_name AS courierName, expires FROM sessions WHERE token = ?", token); }
        public static void DeleteSession(string token) { db.Run("DELETE FROM sessions WHERE token = ?", token); }
    }
}
