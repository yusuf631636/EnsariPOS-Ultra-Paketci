// Ultra Paketçi - C# SÜRÜM (30.09.2026, kullanici istegi: "tek tek tum projeleri C#'a cevirelim, node
// bagimliligi kalmasin"). server.js + sambapos.js + auth.js + db.js + push.js + ws.js + license.js + tunnel.js
// karsiligi. Ayni config.json, ayni SQLite veritabani (data/gelismis-kurye.db), ayni VAPID anahtari
// (data/vapid.json), ayni HTTP uclari ve sayfalar (public/) - kurye ve restoran uygulamalari degismeden calisir.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Alfa;

[assembly: System.Reflection.AssemblyTitle("Ultra Paketçi Sunucusu")]
[assembly: System.Reflection.AssemblyProduct("AlfaPOS Ultra Paketçi")]
[assembly: System.Reflection.AssemblyVersion("1.1.0.0")]

namespace Ultra
{
    public static class Program
    {
        public const string ServiceName = "UltraPaketci";
        public static Dictionary<string, string> Opts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public static string Opt(string k) { string v; return Opts.TryGetValue(k, out v) && v.Length > 0 ? v : null; }

        public static void Main(string[] args)
        {
            foreach (var a in args) { string s = a.TrimStart('/', '-'); int i = s.IndexOf(':'); if (i > 0) Opts[s.Substring(0, i)] = s.Substring(i + 1); else Opts[s] = ""; }
            if (Opts.ContainsKey("sqltest")) { SqlTest.Run(Opt("sqltest")); return; }
            if (!(Opts.ContainsKey("console") || Environment.UserInteractive)) { ServiceBase.Run(new Svc()); return; }
            try { App.Start(); } catch (Exception ex) { Console.WriteLine("BASLATILAMADI: " + ex); Environment.ExitCode = 1; return; }
            Console.WriteLine("Ultra Paketçi (konsol) http://127.0.0.1:" + App.Port + "  - Ctrl+C ile durdurun");
            Thread.Sleep(Timeout.Infinite);
        }
    }

    public class Svc : ServiceBase
    {
        public Svc() { ServiceName = Program.ServiceName; CanStop = true; CanShutdown = true; }
        protected override void OnStart(string[] args) { App.Start(); }
        protected override void OnStop() { App.Stop(); }
        protected override void OnShutdown() { App.Stop(); }
    }

    public static class App
    {
        public const string Version = "1.1.0";
        const string AppName = "Ultra Gelişmiş Kurye";
        public static string Root;
        public static int Port = 4090;
        static LocalHost _host;
        static Timer _watch;
        static WebPush _push;

        public static void Start()
        {
            Web.Init();
            Root = Path.GetFullPath(Program.Opt("root") ?? AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\');
            Log.Init(Program.Opt("logs") ?? Path.Combine(Root, "logs"));
            Cfg.PathFile = Path.Combine(Root, "config.json");
            var c = Cfg.Read();
            int p;
            Port = int.TryParse(Program.Opt("port"), out p) ? p : (int)J.NumOr(J.Get(c, "port"), 4090);
            int w, io; ThreadPool.GetMinThreads(out w, out io); ThreadPool.SetMinThreads(Math.Max(w, 32), Math.Max(io, 32));
            Store.Open(Root);
            // 16.09.2026 ayarlari (masaustu Node surumunden): alan yoksa eski davranis (true)
            ShowOnlineToCouriers = !(J.Get(c, "showOnlineOrdersToCouriers") is bool) || (bool)J.Get(c, "showOnlineOrdersToCouriers");
            NotifyOnline = !(J.Get(c, "notifyOnlineOrders") is bool) || (bool)J.Get(c, "notifyOnlineOrders");
            RestaurantLocation = J.Get(c, "restaurantLocation");
            string key = J.S(c, "gkActivationKey").Trim(); if (key.Length == 0) key = J.S(c, "activationKey").Trim();
            License.Init("ultra_paketci", key, J.S(c, "cloudServerUrl"), true);
            _push = InitPush();
            string bind = J.S(c, "bindHost");
            _host = new LocalHost(Port, Handle, bind.Length > 0 ? bind : null) { Upgrade = WsUpgrade };
            _host.Start();
            Log.Write(AppName + " (C#) " + UpdaterVersion() + ": http://127.0.0.1:" + Port + "  (kurye: /courier, restoran: /restoran)  klasör: " + Root);
            if (_push != null && !Program.Opts.ContainsKey("nowatch"))
            {
                Log.Write(AppName + ": push bildirimleri aktif (VAPID anahtarı hazır).");
                _watch = new Timer(_ => WatchAndNotify(), null, 0, 10000);
            }
            if (!Program.Opts.ContainsKey("notunnel")) Tunnel.Start(Handle, License.CloudUrl, "/ultra-tunnel", License.Key);
            Updater.Root = Root; Updater.Channel = "ultra-cs-update"; Updater.DefaultVersion = Version;
            Updater.Never = new[] { "config.json", "data/gelismis-kurye.db", "data/vapid.json" };
            if (!Program.Opts.ContainsKey("noupdate")) Updater.Start(Program.Opts.ContainsKey("updatenow"));
            ThreadPool.QueueUserWorkItem(delegate { try { Db.Query("SELECT 1"); Log.Write("SQL bağlantısı hazır: " + Db.Source); } catch (Exception ex) { Log.Write("UYARI - SQL'e bağlanılamadı: " + ex.Message); } });
        }
        static string UpdaterVersion() { try { string v = File.ReadAllText(Path.Combine(Root, "surum.txt")).Trim(); if (v.Length > 0) return v; } catch { } return Version; }
        public static void Stop() { try { Tunnel.Stop(); _host.Stop(); } catch { } Log.Write(AppName + " durduruldu."); }

        // ============================================================== push (push.js)
        static WebPush InitPush()
        {
            try
            {
                string f = Path.Combine(Root, "data", "vapid.json");
                Dictionary<string, object> keys = null;
                if (File.Exists(f)) { try { keys = J.D(J.Parse(Files.Read(f))); } catch { } }
                if (keys == null || J.S(keys, "publicKey").Length == 0)
                {
                    keys = WebPush.GenerateKeys();
                    Directory.CreateDirectory(Path.GetDirectoryName(f));
                    Files.Write(f, J.Pretty(keys));
                }
                return new WebPush(J.S(keys, "publicKey"), J.S(keys, "privateKey"), "mailto:destek@ornek-alanadi.com");
            }
            catch (Exception ex) { Log.Write("push bildirimleri pasif: " + ex.Message); return null; }
        }
        static void SendToSubscription(string endpoint, string subscriptionJson, Dictionary<string, object> payload)
        {
            if (_push == null) return;
            try
            {
                int status = _push.Send(J.DD(J.Parse(subscriptionJson)), J.Str(payload));
                if (status == 404 || status == 410) Store.RemovePushSubscription(endpoint);
            }
            catch { }
        }
        static void NotifyCourier(string courierName, Dictionary<string, object> payload)
        {
            if (_push == null) return;
            foreach (var s in Store.PushSubscriptionsForCourier(courierName)) SendToSubscription(J.S(s, "endpoint"), J.S(s, "subscription"), payload);
        }
        static void NotifyAllCouriers(Dictionary<string, object> payload)
        {
            if (_push == null) return;
            foreach (var s in Store.AllCourierPushSubscriptions().Where(s => Store.GetCourierNotifyEnabled(s["courier_name"])))
                SendToSubscription(J.S(s, "endpoint"), J.S(s, "subscription"), payload);
        }

        // ============================================================== arka plan bekcisi (watchAndNotify)
        static readonly ConcurrentDictionary<long, long> _selfClaims = new ConcurrentDictionary<long, long>();
        const long SelfClaimTtl = 2 * 60 * 1000;
        static HashSet<long> _knownPending;
        static Dictionary<long, string> _knownAssign;
        static int _watching;
        static void WatchAndNotify()
        {
            if (Interlocked.Exchange(ref _watching, 1) == 1) return;
            try
            {
                var pending = Samba.UnassignedPackages();
                var active = Samba.ActiveCourierOrders();
                var pendingIds = new HashSet<long>(pending.Select(o => (long)J.Num(o["id"])));
                var assign = new Dictionary<long, string>();
                foreach (var o in active) if (J.S(o, "courierName").Length > 0) assign[(long)J.Num(o["id"])] = J.S(o, "courierName");
                if (_knownPending != null)
                {
                    var np = pending.Where(o => !_knownPending.Contains((long)J.Num(o["id"]))).ToList();
                    // notifyOnlineOrders=false: platform siparisleri bildirim icin sayilmaz (listede yine gorunurler)
                    if (!NotifyOnline) np = np.Where(o => !IsOnlineOrder(o)).ToList();
                    if (np.Count > 0)
                    {
                        string num0 = J.S(np[0], "number").Length > 0 ? J.S(np[0], "number") : J.S(np[0], "id");
                        string tag0 = np.Count == 1 && IsOnlineOrder(np[0]) ? " (ONLINE · " + J.S(np[0], "source") + ")" : "";
                        NotifyAllCouriers(J.Obj("title", np.Count == 1 ? "Yeni bekleyen sipariş" + tag0 : np.Count + " yeni bekleyen sipariş",
                            "body", np.Count == 1 ? "#" + num0 + " · " + J.S(np[0], "customerName") : "Bekleyen paketler listesine düştü.", "kind", "yeni-bekleyen", "tag", "gks-bekleyen"));
                    }
                }
                if (_knownAssign != null)
                {
                    long now = J.NowMs();
                    foreach (var kv in assign)
                    {
                        if (_knownAssign.ContainsKey(kv.Key)) continue;
                        long at;
                        if (_selfClaims.TryGetValue(kv.Key, out at) && now - at < SelfClaimTtl) { _selfClaims.TryRemove(kv.Key, out at); continue; }
                        var order = active.FirstOrDefault(o => (long)J.Num(o["id"]) == kv.Key);
                        if (!NotifyOnline && IsOnlineOrder(order)) continue;
                        string num = order != null ? (J.S(order, "number").Length > 0 ? J.S(order, "number") : J.S(order, "id")) : kv.Key.ToString();
                        string tag = IsOnlineOrder(order) ? " (ONLINE · " + J.S(order, "source") + ")" : "";
                        NotifyCourier(kv.Value, J.Obj("title", "Yeni sipariş atandı" + tag, "body", "#" + num + " size atandı.", "kind", "atandi", "tag", "gks-atandi"));
                    }
                }
                foreach (var kv in _selfClaims.ToArray()) { long x; if (J.NowMs() - kv.Value > SelfClaimTtl) _selfClaims.TryRemove(kv.Key, out x); }
                _knownPending = pendingIds; _knownAssign = assign;
            }
            catch (Exception ex) { Log.Write("watchAndNotify hatası (yoksayıldı, bir sonraki turda tekrar denenecek): " + ex.Message); }
            finally { Interlocked.Exchange(ref _watching, 0); }
        }

        // ============================================================== canli akis (ws.js) - Windows 8+ ; Windows 7'de ekran zaten sorgulamayla calisir
        static readonly List<object> _wsClients = new List<object>();
        static bool WsUpgrade(HttpListenerContext ctx) { return WsServer.Accept(ctx, _wsClients); }
        static void Broadcast(Dictionary<string, object> ev) { WsServer.Broadcast(_wsClients, J.Str(ev)); }

        // ============================================================== oturum (auth.js)
        const long SessionTtl = 180L * 24 * 60 * 60 * 1000;
        static readonly Dictionary<string, string> CookieNames = new Dictionary<string, string> { { "admin", "gks_admin_session" }, { "courier", "gks_courier_session" } };
        class Lk { public int Count; public long Until; }
        static readonly ConcurrentDictionary<string, Lk> _attempts = new ConcurrentDictionary<string, Lk>();
        static long LockedMs(string ip) { Lk s; return _attempts.TryGetValue(ip, out s) && s.Until > J.NowMs() ? s.Until - J.NowMs() : 0; }
        static void Fail(string ip) { var s = _attempts.GetOrAdd(ip, _ => new Lk()); lock (s) { s.Count++; if (s.Count >= 5) { s.Until = J.NowMs() + 5 * 60 * 1000; s.Count = 0; } } }
        static void Success(string ip) { Lk s; _attempts.TryRemove(ip, out s); }
        static string ClientIp(Req req) { string xf = req.Header("x-forwarded-for"); return (string.IsNullOrEmpty(xf) ? req.RemoteIp : xf).Split(',')[0].Trim(); }
        static bool IsHttps(Req req) { return req.Header("x-forwarded-proto") == "https"; }
        static void SetSessionCookie(Req req, Res res, string token, string role)
        {
            string v = CookieNames[role] + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + (SessionTtl / 1000);
            res.SetHeader("Set-Cookie", IsHttps(req) ? v + "; Secure" : v);
        }
        static void ClearSessionCookie(Req req, Res res)
        {
            res.Headers.RemoveAll(h => h.Key.Equals("Set-Cookie", StringComparison.OrdinalIgnoreCase));
            foreach (var n in CookieNames.Values) res.AddHeader("Set-Cookie", n + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (IsHttps(req) ? "; Secure" : ""));
        }
        static string NewSession(string role, object courierId, object courierName)
        {
            string token = Crypto.RandomHex(24);
            Store.SaveSession(token, role, courierId, courierName, J.NowMs() + SessionTtl);
            return token;
        }
        /* 16.09.2026 (masaustu Node surumu): iOS PWA'da cerez her zaman guvenilir degil - ayni token istemcinin
           localStorage'inda da tutulup "X-Session-Token" basligiyla gelir; cerez yoksa bu kullanilir.
           Token baska role ait olabilir - rol KOVASI kontrol edilir (admin-pending, admin kovasindadir). */
        static string BearerToken(Req req) { string h = req.Header("x-session-token"); return string.IsNullOrEmpty(h) ? null : h; }
        static string RoleBucket(string sessionRole) { return sessionRole == "admin-pending" ? "admin" : sessionRole; }
        static Dictionary<string, object> CurrentSession(Req req, string role)
        {
            foreach (var r in role != null ? new[] { role } : new[] { "admin", "courier" })
            {
                string token = req.Cookie(CookieNames[r]);
                if (string.IsNullOrEmpty(token)) token = BearerToken(req);
                if (string.IsNullOrEmpty(token)) continue;
                var rec = Store.LoadSession(token);
                if (rec == null) continue;
                if (RoleBucket(J.S(rec, "role")) != r) continue;
                if (J.Num(rec, "expires") < J.NowMs()) { Store.DeleteSession(token); continue; }
                long exp = J.NowMs() + SessionTtl;
                Store.TouchSession(token, exp);
                rec["expires"] = exp;
                return rec;
            }
            return null;
        }
        static void DestroySession(Req req) { string bt = BearerToken(req); if (bt != null) Store.DeleteSession(bt); foreach (var r in new[] { "admin", "courier" }) { string t = req.Cookie(CookieNames[r]); if (!string.IsNullOrEmpty(t)) Store.DeleteSession(t); } }

        // ============================================================== 16.09.2026 ozellikleri (masaustu Node surumu)
        static bool ShowOnlineToCouriers = true, NotifyOnline = true;
        static object RestaurantLocation;
        /* showOnlineOrdersToCouriers=false: platform (Yemeksepeti/Trendyol/Getir/Migros) siparisleri kurye
           ekraninda gorunmez (platformun kendi kuryesi goturuyor); restoran (admin) HER ZAMAN hepsini gorur. */
        static List<Dictionary<string, object>> FilterForCourierScreen(List<Dictionary<string, object>> orders)
        {
            return ShowOnlineToCouriers ? orders : orders.Where(o => J.S(o, "source") == "Paket").ToList();
        }
        static bool IsOnlineOrder(Dictionary<string, object> o) { return o != null && J.S(o, "source") != "Paket"; }

        /* Guvenlik basliklari - her yanita. Harita: Leaflet (unpkg) + Wikimedia karolari, yedek OpenStreetMap.
           Referrer-Policy "no-referrer" DEGIL: OpenStreetMap karo sunucusu Referer'siz istegi engelliyor. */
        static void SecurityHeaders(Req req, Res res)
        {
            res.SetHeader("X-Content-Type-Options", "nosniff");
            res.SetHeader("X-Frame-Options", "DENY");
            res.SetHeader("Referrer-Policy", "strict-origin-when-cross-origin");
            res.SetHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; " +
                "img-src 'self' data: https://maps.wikimedia.org https://tile.openstreetmap.org https://unpkg.com; font-src 'self'; connect-src 'self' ws: wss:; " +
                "manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
            if (IsHttps(req)) res.SetHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
        }

        /* Genel /api/* hiz siniri. Node surumu IP basina 100/dk idi - restoran ekrani yalniz haritayi 30/dk
           yeniliyor ve ayni restorandaki cihazlar tunelde tek dis IP'den gorunebiliyor; 600/dk yapildi. */
        const int RateMax = 600; const long RateWindowMs = 60000;
        class Rate { public long Start; public int Count; }
        static readonly ConcurrentDictionary<string, Rate> _rate = new ConcurrentDictionary<string, Rate>();
        static long _rateSweep;
        static bool RateLimited(string ip)
        {
            long now = J.NowMs();
            if (now - Interlocked.Read(ref _rateSweep) > RateWindowMs)
            {
                Interlocked.Exchange(ref _rateSweep, now);
                foreach (var kv in _rate.ToArray()) if (now - kv.Value.Start >= RateWindowMs) { Rate x; _rate.TryRemove(kv.Key, out x); }
            }
            var s = _rate.GetOrAdd(ip, _ => new Rate { Start = now });
            lock (s)
            {
                if (now - s.Start >= RateWindowMs) { s.Start = now; s.Count = 0; }
                return ++s.Count > RateMax;
            }
        }

        // ============================================================== yardimcilar
        static Dictionary<string, object> Err(string m) { return J.Obj("error", m); }
        static string[] DayRangeUtc(string day)
        {
            var start = DateTime.ParseExact(day, "yyyy-MM-dd", J.Inv, System.Globalization.DateTimeStyles.AssumeLocal).ToUniversalTime();
            var end = start.AddHours(24);
            return new[] { start.ToString("yyyy-MM-dd HH:mm:ss", J.Inv), end.ToString("yyyy-MM-dd HH:mm:ss", J.Inv) };
        }
        static string DayParam(Req req)
        {
            string d = req.Q("date") ?? "";
            return Regex.IsMatch(d, @"^\d{4}-\d{2}-\d{2}$") ? d : DateTime.UtcNow.ToString("yyyy-MM-dd", J.Inv);
        }
        static bool OwnsOrder(Dictionary<string, object> s, Dictionary<string, object> o)
        {
            return J.S(s, "role") == "admin" || (J.S(s, "role") == "courier" && J.S(o, "courierName") == J.S(s, "courierName"));
        }
        static readonly Dictionary<string, string> Types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            { ".html", "text/html; charset=utf-8" }, { ".css", "text/css; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" }, { ".json", "application/json; charset=utf-8" },
            { ".webmanifest", "application/manifest+json; charset=utf-8" }, { ".png", "image/png" }, { ".ico", "image/x-icon" } };
        static void ServeStatic(Res res, string pathname)
        {
            var map = new Dictionary<string, string> { { "/courier", "/courier/index.html" }, { "/restoran", "/restoran/index.html" }, { "/", "/courier/index.html" } };
            string mapped; string rel = map.TryGetValue(pathname, out mapped) ? mapped : pathname;
            string pub = Path.Combine(Root, "public");
            string file;
            try { file = Path.GetFullPath(Path.Combine(pub, Uri.UnescapeDataString(rel).TrimStart('/').Replace('/', '\\'))); } catch { res.Json(404, Err("Bulunamadı")); return; }
            if (!file.StartsWith(pub + "\\", StringComparison.OrdinalIgnoreCase) || !File.Exists(file)) { res.Json(404, Err("Bulunamadı")); return; }
            string t; if (!Types.TryGetValue(Path.GetExtension(file), out t)) t = "application/octet-stream";
            res.Send(200, t, File.ReadAllBytes(file), "no-store");
        }

        // ============================================================== istekler (handleRequest)
        public static void Handle(Req req, Res res)
        {
            try { Route(req, res); }
            catch (Exception ex)
            {
                Log.Write("HATA " + req.Method + " " + req.Path + ": " + ex.Message);
                res.Headers.Clear(); res.Body.SetLength(0); SecurityHeaders(req, res);
                res.Json(500, Err(ex.Message));
            }
        }

        static void Route(Req req, Res res)
        {
            string path = req.Path, m = req.Method;
            bool GET = m == "GET", POST = m == "POST";
            string ip = ClientIp(req);
            Match mt;
            SecurityHeaders(req, res);
            if (path.StartsWith("/api/") && RateLimited(ip)) { res.Json(429, Err("Çok fazla istek gönderildi. Lütfen biraz bekleyip tekrar deneyin.")); return; }

            if (path.StartsWith("/api/") && path != "/api/config" && !License.IsLicensed)
            { res.Json(403, Err(License.Error ?? "Bu kurulumun lisansı aktif değil. AlfaPOS ile iletişime geçin.")); return; }

            if (path == "/api/courier/login" && POST)
            {
                long wait = LockedMs(ip);
                if (wait > 0) { res.Json(429, Err("Çok fazla hatalı deneme. " + (long)Math.Ceiling(wait / 1000.0) + " saniye sonra tekrar deneyin.")); return; }
                var b = req.JsonBody();
                var courier = Samba.CourierByPin(J.S(b, "pin"));
                if (courier == null) { Fail(ip); res.Json(401, Err("PIN hatalı.")); return; }
                Success(ip);
                string ctoken = NewSession("courier", courier["id"], courier["name"]);
                SetSessionCookie(req, res, ctoken, "courier");
                res.Json(200, J.Obj("ok", true, "courierName", courier["name"], "token", ctoken));   // token: istemci localStorage yedegi
                return;
            }
            if (path == "/api/admin/login-step1" && POST)
            {
                long wait = LockedMs(ip);
                if (wait > 0) { res.Json(429, Err("Çok fazla hatalı deneme. " + (long)Math.Ceiling(wait / 1000.0) + " saniye sonra tekrar deneyin.")); return; }
                var b = req.JsonBody();
                string identifier = J.S(b, "identifier").Trim(), password = J.S(b, "password");
                if (identifier.Length == 0 || password.Length == 0) { res.Json(400, Err("E-posta/telefon ve şifrenizi girin.")); return; }
                var v = License.VerifyPassword(identifier, password);
                if (!J.Truthy(J.Get(v, "ok"))) { Fail(ip); res.Json(401, Err(J.S(v, "error").Length > 0 ? J.S(v, "error") : "E-posta/telefon veya şifre hatalı.")); return; }
                Success(ip);
                SetSessionCookie(req, res, NewSession("admin-pending", null, null), "admin");
                res.Json(200, J.Obj("ok", true));
                return;
            }
            if (path == "/api/admin/login-step2" && POST)
            {
                long wait = LockedMs(ip);
                if (wait > 0) { res.Json(429, Err("Çok fazla hatalı deneme. " + (long)Math.Ceiling(wait / 1000.0) + " saniye sonra tekrar deneyin.")); return; }
                var pending = CurrentSession(req, null);
                if (pending == null || J.S(pending, "role") != "admin-pending") { res.Json(401, Err("Önce e-posta ve şifrenizle giriş yapın.")); return; }
                var b = req.JsonBody();
                if (!Samba.AdminValidByPin(J.S(b, "pin"))) { Fail(ip); res.Json(401, Err("PIN hatalı.")); return; }
                Success(ip);
                string atoken = NewSession("admin", null, null);
                SetSessionCookie(req, res, atoken, "admin");
                res.Json(200, J.Obj("ok", true, "token", atoken));
                return;
            }
            if (path == "/api/logout" && POST) { DestroySession(req); ClearSessionCookie(req, res); res.Json(200, J.Obj("ok", true)); return; }
            if (path == "/api/config") { res.Json(200, J.Obj("appName", AppName, "restaurantLocation", RestaurantLocation)); return; }

            if (path.StartsWith("/api/"))
            {
                var adminS = CurrentSession(req, "admin");
                var courierS = CurrentSession(req, "courier");
                if (adminS == null && courierS == null) { res.Json(401, Err("Oturum gerekli.")); return; }
                var session = adminS ?? courierS;
                bool isAdmin = J.S(session, "role") == "admin";

                if (path == "/api/me" && GET) { res.Json(200, J.Obj("role", session["role"], "courierName", J.Get(session, "courierName"))); return; }
                if (path == "/api/courier/unassigned" && GET) { res.Json(200, J.Obj("orders", FilterForCourierScreen(Samba.UnassignedPackages()))); return; }
                if ((mt = Regex.Match(path, @"^/api/courier/orders/(\d+)/claim$")).Success && POST)
                {
                    if (courierS == null) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    try { Samba.ClaimPackage(mt.Groups[1].Value, J.S(courierS, "courierName")); }
                    catch (Exception e) { res.Json(409, Err(e.Message)); return; }
                    long tid = long.Parse(mt.Groups[1].Value);
                    Store.LogEvent(tid, courierS["courierName"], "paket-alindi", null, null, null);
                    Broadcast(J.Obj("kind", "paket-alindi", "ticketId", tid, "courierName", courierS["courierName"]));
                    _selfClaims[tid] = J.NowMs();
                    res.Json(200, J.Obj("ok", true));
                    return;
                }
                if (path == "/api/courier/orders" && GET)
                {
                    var all = Samba.ActiveCourierOrders();
                    var scoped = adminS != null ? all : FilterForCourierScreen(all.Where(o => J.S(o, "courierName") == J.S(courierS, "courierName")).ToList());
                    res.Json(200, J.Obj("orders", scoped, "appName", AppName));
                    return;
                }
                if (path == "/api/payment-types" && GET) { res.Json(200, J.Obj("types", Samba.PaymentTypes())); return; }
                if (path == "/api/courier/my-deliveries" && GET)
                {
                    if (courierS == null) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    string day = DayParam(req); var rg = DayRangeUtc(day);
                    var list = Store.CourierDeliveries(J.S(courierS, "courierName"), rg[0], rg[1]);
                    double total = list.Sum(d => J.NumOr(d["amount"], 0));
                    res.Json(200, J.Obj("date", day, "count", list.Count, "total", J.NumVal(total), "deliveries", list));
                    return;
                }
                if (path == "/api/courier/end-of-day" && GET)
                {
                    if (courierS == null) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    string day = DayParam(req); var rg = DayRangeUtc(day);
                    var list = Store.CourierDeliveries(J.S(courierS, "courierName"), rg[0], rg[1]);
                    double total = list.Sum(d => J.NumOr(d["amount"], 0)), cash = 0;
                    var byType = new Dictionary<string, double>(); var order = new List<string>();
                    foreach (var d in list)
                    {
                        string name = J.Truthy(d["payment_type_name"]) ? J.S(d["payment_type_name"]) : "Bilinmiyor";
                        if (!byType.ContainsKey(name)) { byType[name] = 0; order.Add(name); }
                        byType[name] += J.NumOr(d["amount"], 0);
                        if (Regex.IsMatch(name, "nakit|cash", RegexOptions.IgnoreCase)) cash += J.NumOr(d["amount"], 0);
                    }
                    res.Json(200, J.Obj("date", day, "count", list.Count, "total", J.NumVal(total),
                        "byType", order.Select(n => (object)J.Obj("paymentTypeName", n, "amount", J.NumVal(byType[n]))).ToList(), "cashToCollect", J.NumVal(cash)));
                    return;
                }
                if (path == "/api/courier/settings" && GET)
                {
                    if (courierS == null) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    res.Json(200, J.Obj("notifyEnabled", Store.GetCourierNotifyEnabled(courierS["courierName"])));
                    return;
                }
                if (path == "/api/courier/settings" && POST)
                {
                    if (courierS == null) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    var b = req.JsonBody();
                    Store.SetCourierNotifyEnabled(J.S(courierS, "courierName"), J.Truthy(J.Get(b, "notifyEnabled")), J.S(courierS, "courierName"));
                    res.Json(200, J.Obj("ok", true));
                    return;
                }
                if (path == "/api/admin/courier-settings" && GET)
                {
                    if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    var couriers = Samba.Couriers();
                    var settings = new Dictionary<string, bool>();
                    foreach (var s in Store.AllCourierNotifySettings()) settings[J.S(s["courier_name"])] = J.Truthy(s["notify_enabled"]);
                    res.Json(200, J.Obj("couriers", couriers.Select(J.DD).Select(c => (object)J.Obj("name", c["name"], "notifyEnabled", settings.ContainsKey(J.S(c["name"])) ? settings[J.S(c["name"])] : true)).ToList()));
                    return;
                }
                if (path == "/api/admin/courier-settings" && POST)
                {
                    if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    var b = req.JsonBody();
                    if (!J.Truthy(J.Get(b, "courierName"))) { res.Json(400, Err("Kurye adı eksik.")); return; }
                    Store.SetCourierNotifyEnabled(J.S(b, "courierName"), J.Truthy(J.Get(b, "notifyEnabled")), "admin");
                    res.Json(200, J.Obj("ok", true));
                    return;
                }
                if (path == "/api/push/vapid-public-key" && GET) { res.Json(200, J.Obj("key", _push != null ? _push.PublicKey : null)); return; }
                if (path == "/api/push/subscribe" && POST)
                {
                    var b = req.JsonBody();
                    var sub = J.D(J.Get(b, "subscription"));
                    if (sub == null || !J.Truthy(J.Get(sub, "endpoint"))) { res.Json(400, Err("Geçersiz abonelik.")); return; }
                    Store.SavePushSubscription(J.S(sub, "endpoint"), courierS != null ? courierS["courierName"] : null, courierS != null ? "courier" : "admin", J.Str(sub));
                    res.Json(200, J.Obj("ok", true));
                    return;
                }
                if (path == "/api/push/unsubscribe" && POST)
                {
                    var b = req.JsonBody();
                    if (J.Truthy(J.Get(b, "endpoint"))) Store.RemovePushSubscription(J.S(b, "endpoint"));
                    res.Json(200, J.Obj("ok", true));
                    return;
                }
                if (path == "/api/push/test" && POST)
                {
                    if (courierS == null) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    if (_push == null) { res.Json(503, Err("Sunucuda push henüz aktif değil.")); return; }
                    var subs = Store.PushSubscriptionsForCourier(J.S(courierS, "courierName"));
                    if (subs.Count == 0) { res.Json(404, Err("Kayıtlı bir abonelik bulunamadı - önce \"Arka plan bildirimlerini etkinleştir\" butonuna basın.")); return; }
                    NotifyCourier(J.S(courierS, "courierName"), J.Obj("title", "Test Bildirimi", "body", DateTime.Now.ToString("HH:mm:ss") + " - bu bildirim sunucudan gerçekten gönderildi.", "kind", "test", "tag", "gks-test"));
                    res.Json(200, J.Obj("ok", true, "subscriptionCount", subs.Count));
                    return;
                }
                if ((mt = Regex.Match(path, @"^/api/courier/orders/(\d+)/content$")).Success && GET)
                {
                    string id = mt.Groups[1].Value;
                    var active = Samba.ActiveCourierOrders().FirstOrDefault(o => J.S(o, "id") == id);
                    if (active != null) { if (!OwnsOrder(session, active)) { res.Json(403, Err("Bu siparişe erişiminiz yok.")); return; } }
                    else if (Samba.UnassignedPackages().FirstOrDefault(o => J.S(o, "id") == id) == null) { res.Json(403, Err("Bu siparişe erişiminiz yok.")); return; }
                    res.Json(200, J.Obj("items", Samba.OrderContent(id)));
                    return;
                }
                if ((mt = Regex.Match(path, @"^/api/courier/orders/(\d+)/delivered$")).Success && POST)
                {
                    string id = mt.Groups[1].Value;
                    var order = Samba.ActiveCourierOrders().FirstOrDefault(o => J.S(o, "id") == id);
                    if (order == null || !OwnsOrder(session, order)) { res.Json(403, Err("Bu siparişe erişiminiz yok.")); return; }
                    var b = req.JsonBody();
                    bool noPayment = J.Truthy(J.Get(b, "noPayment"));
                    Dictionary<string, object> result;
                    try { result = Samba.MarkDelivered(id, J.Get(b, "paymentTypeId"), noPayment, J.Get(session, "courierId"), J.Get(b, "tenderedAmount")); }
                    catch (Exception e) { res.Json(409, Err(e.Message)); return; }
                    string cn = J.S(order, "courierName").Length > 0 ? J.S(order, "courierName") : (J.S(session, "role") == "courier" ? J.S(session, "courierName") : "Bilinmeyen kurye");
                    bool closed = J.IsTrue(result, "closed");
                    Store.LogEvent(order["id"], cn, closed ? "teslim-edildi" : "teslim-odeme-bekliyor", null, result["amountCollected"], J.Obj(
                        "paymentTypeId", result["paymentTypeId"], "paymentTypeName", result["paymentTypeName"], "ticketNumber", order["number"], "customerName", order["customerName"],
                        "orderTotal", order["total"], "tenderedAmount", result["tenderedAmount"], "changeAmount", result["changeAmount"], "orderSource", order["source"]));
                    Broadcast(J.Obj("kind", closed ? "teslim-edildi" : "teslim-odeme-bekliyor", "ticketId", order["id"], "number", order["number"], "courierName", cn, "amountCollected", result["amountCollected"]));
                    var o2 = J.Obj("ok", true); J.Assign(o2, result);
                    res.Json(200, o2);
                    return;
                }
                if (path == "/api/admin/couriers" && GET) { if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; } res.Json(200, J.Obj("couriers", Samba.Couriers())); return; }
                if (path == "/api/courier/location" && POST)
                {
                    if (courierS == null) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    var b = req.JsonBody();
                    double lat = J.Num(b, "lat"), lng = J.Num(b, "lng"), acc = J.Num(b, "accuracy");
                    object accuracy = (J.Get(b, "accuracy") != null && J.Finite(acc)) ? J.NumVal(acc) : null;
                    // 16.09.2026: sayi olmayan, 0,0 (GPS hatasi) veya 100 m'den belirsiz konum reddedilir - marker yanlis yere ziplamasin
                    bool badLoc = !J.Finite(lat) || !J.Finite(lng) || J.Get(b, "lat") == null || J.Get(b, "lng") == null || (lat == 0 && lng == 0)
                        || (accuracy != null && acc > 100);
                    if (badLoc) { res.Json(400, Err("Geçersiz konum.")); return; }
                    Store.SetCourierLocation(J.S(courierS, "courierName"), lat, lng, accuracy);
                    Broadcast(J.Obj("kind", "konum", "courierName", courierS["courierName"], "lat", J.NumVal(lat), "lng", J.NumVal(lng), "accuracy", accuracy));
                    res.Json(200, J.Obj("ok", true));
                    return;
                }
                if (path == "/api/admin/locations" && GET)
                {
                    if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    var names = new HashSet<string>(Samba.Couriers().Select(c => J.S(J.D(c), "name")));
                    // 16.09.2026: 10 dk'dan eski konum listeden cikar; 3-10 dk arasi "stale" (haritada gri, "Bağlantı bekleniyor")
                    long now = J.NowMs(); const long StaleMs = 3 * 60 * 1000, GoneMs = 10 * 60 * 1000;
                    var fresh = new List<Dictionary<string, object>>();
                    foreach (var l in Store.AllCourierLocations())
                    {
                        if (!names.Contains(J.S(l["courier_name"]))) continue;
                        DateTime u;
                        if (!DateTime.TryParseExact(J.S(l["updated_at"]), "yyyy-MM-dd HH:mm:ss", J.Inv, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out u)) continue;
                        long age = now - (long)(u - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                        if (age >= GoneMs) continue;
                        var row = new Dictionary<string, object>(l); row["stale"] = age >= StaleMs;
                        fresh.Add(row);
                    }
                    res.Json(200, J.Obj("locations", fresh));
                    return;
                }
                if (path == "/api/admin/recent-events" && GET) { if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; } res.Json(200, J.Obj("events", Store.RecentEvents(50))); return; }
                if (path == "/api/admin/report" && GET)
                {
                    if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    string day = DayParam(req); var rg = DayRangeUtc(day);
                    var delivered = Store.DeliverySummary(rg[0], rg[1]);
                    var activeBy = new Dictionary<string, int[]>();
                    foreach (var o in Samba.ActiveCourierOrders())
                    {
                        string cn = J.S(o, "courierName");
                        if (!activeBy.ContainsKey(cn)) activeBy[cn] = new int[2];
                        if (J.S(o, "packageStatus") == "Yolda") activeBy[cn][1]++; else activeBy[cn][0]++;
                    }
                    var names = new HashSet<string>(delivered.Select(d => J.S(d["courier_name"])).Concat(activeBy.Keys));
                    var byCourier = names.OrderBy(n => n, StringComparer.Ordinal).Select(n =>
                    {
                        var d = delivered.FirstOrDefault(r => J.S(r["courier_name"]) == n);
                        int[] a; if (!activeBy.TryGetValue(n, out a)) a = new int[2];
                        return (object)J.Obj("courierName", n, "pending", a[0], "enroute", a[1], "deliveredCount", d != null ? d["count"] : 0L, "deliveredTotal", d != null ? d["total"] : 0L);
                    }).ToList();
                    var payments = Store.PaymentBreakdown(rg[0], rg[1]);
                    double grand = payments.Sum(p => J.NumOr(p["total"], 0));
                    res.Json(200, J.Obj("date", day, "byCourier", byCourier,
                        "payments", payments.Select(p => (object)J.Obj("paymentTypeName", p["payment_type_name"], "count", p["count"], "total", p["total"])).ToList(), "grandTotal", J.NumVal(grand)));
                    return;
                }
                if (path == "/api/admin/report/deliveries" && GET)
                {
                    if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; }
                    string day = DayParam(req); var rg = DayRangeUtc(day);
                    var rows = Store.DeliveryDetails(rg[0], rg[1]).Select(r => (object)J.Obj("ticketId", r["ticket_id"], "ticketNumber", r["ticket_number"], "courierName", r["courier_name"],
                        "customerName", r["customer_name"], "orderTotal", r["order_total"], "paymentTypeName", r["payment_type_name"], "amountCollected", r["amount"],
                        "tenderedAmount", r["tendered_amount"], "changeAmount", r["change_amount"], "orderSource", r["order_source"], "at", r["at"])).ToList();
                    res.Json(200, J.Obj("date", day, "deliveries", rows));
                    return;
                }
                if (path == "/api/admin/debug/roles" && GET) { if (!isAdmin) { res.Json(403, Err("Yetkiniz yok.")); return; } res.Json(200, J.Obj("rows", Samba.DebugRolesAndUsers())); return; }
                res.Json(404, Err("Bulunamadı"));
                return;
            }
            ServeStatic(res, path);
        }
    }
}
