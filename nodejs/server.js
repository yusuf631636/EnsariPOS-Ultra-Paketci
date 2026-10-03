/* GELISMIS KURYE SISTEMI - bagimsiz sunucu.
   Bu, mevcut "kendi-restoranim-kurye" (kurye.ornek-alanadi.com, port 4021) uygulamasindan
   TAMAMEN AYRI, kendi portunda calisan YENI bir uygulamadir. Ayni SQL Server/SambaPOS
   veritabanina baglanir ama HICBIR dosyasini paylasmaz/degistirmez - test asamasinda
   ayni restoranda ikisi YAN YANA calisabilir, biri digerini etkilemez.

   Kapsam (once sadece bu restorana, sonra genel musteri urunune tasinacak):
   - Kurye: "Bekleyen Paketler" sekmesinden bosta paketi KENDI USTUNE ALIR (claimPackage) -
     SambaPOS'ta sanki elle atanmis gibi gorunur.
   - Kurye: "Uzerimdekiler" sekmesinden teslim ederken GERCEK SambaPOS odeme turlerinden
     birini secer; "odeme alinmadi" derse adisyon KAPANMAZ.
   - Restoran: kim hangi paketi ne zaman aldi, canli (WebSocket) gorur. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { config } = require('./sql');
const sambapos = require('./sambapos');
const auth = require('./auth');
const wsServer = require('./ws');
const { logEvent, deliverySummary, paymentBreakdown, deliveryDetails, courierDeliveries, setCourierLocation, allCourierLocations, recentEvents,
  getCourierNotifyEnabled, setCourierNotifyEnabled, allCourierNotifySettings,
  savePushSubscription, removePushSubscription, pushSubscriptionsForCourier } = require('./db');
const license = require('./license');
const push = require('./push');

const PORT = Number(process.env.PORT || config.port || 4090);
const ROOT = __dirname;
const APP_NAME = 'Ultra Gelişmiş Kurye';

/* "day" (YYYY-MM-DD) sunucunun YEREL takvim gunu olarak yorumlanir; kendi-restoranim-kurye
   ile ayni dogrulanmis desen (delivery_events.at SQLite'da her zaman UTC yaziyor). */
function dayRangeUtc(day) {
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
  return { start: fmt(start), end: fmt(end) };
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  const map = { '/courier': '/courier/index.html', '/restoran': '/restoran/index.html', '/': '/courier/index.html' };
  const rel = map[pathname] || pathname;
  const file = path.join(ROOT, 'public', rel);
  if (!file.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Bulunamadı' });
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

/* Guvenlik basliklari (16.09.2026) - HER yanita (statik dosya, API, 404, hata) uygulanir.
   res.setHeader() burada, asagidaki handleRequest icindeki res.writeHead() cagrilarindan
   ONCE calisir; Node.js ikisini BIRLESTIRIR (writeHead'e verilenler setHeader'a EKLENIR,
   celiskiye dusmez) - bu yuzden json()/serveStatic() icindeki tek tek writeHead
   cagrilarinin HICBIRI degistirilmeden tum yanitlar bu basliklari alir.
   CSP: restoran ekranindaki canli harita (Leaflet, unpkg.com CDN + OpenStreetMap karo
   sunucusu) ACIKCA izin listesine alinmistir - aksi halde harita sessizce bozulurdu. */
function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); // OSM karo sunucusu Referer'siz istegi engelliyor (yedek harita)
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://unpkg.com",
    "img-src 'self' data: https://maps.wikimedia.org https://tile.openstreetmap.org https://unpkg.com",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; '));
  if (auth.isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}

/* Genel API hiz siniri (16.09.2026) - IP basina dakikada 100 istek. Giris uclarinin
   KENDI (auth.js: lockedForMs/registerFail, 5 hatali deneme -> 5dk kilit) daha siki
   korumasi zaten var; bu, TUM /api/* icin ikinci/genel bir katman - tek bir IP'nin
   (bozuk bir istemci dongusu, taramaci, kaba kuvvet script'i) sunucuyu/SQL'i
   bogmasini engeller. Sabit 1 dakikalik pencere, bellekte tutulan basit bir Map -
   Redis'e gerek yok (tek sunucu sureci). */
const RATE_LIMIT_MAX = 600, RATE_LIMIT_WINDOW_MS = 60000; // 30.09.2026: 100 -> 600 (ayni restoranin cihazlari tek dis IP'den gorunebilir)
const rateLimitState = new Map(); // ip -> { count, windowStart }
function isRateLimited(ip) {
  const now = Date.now();
  const state = rateLimitState.get(ip);
  if (!state || now - state.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(ip, { count: 1, windowStart: now });
    return false;
  }
  state.count += 1;
  return state.count > RATE_LIMIT_MAX;
}
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, state] of rateLimitState) if (state.windowStart < cutoff) rateLimitState.delete(ip);
}, RATE_LIMIT_WINDOW_MS).unref();

function ownsOrder(session, order) { return session.role === 'admin' || (session.role === 'courier' && order.courierName === session.courierName); }

/* "showOnlineOrdersToCouriers" (16.09.2026, kullanici istegi): bazi restoranlar
   platform (Yemeksepeti/Trendyol/Getir/Migros) siparislerini PLATFORMUN KENDI
   kuryesiyle gonderiyor - bu durumda o siparisler bizim kurye uygulamasinda hic
   GORUNMEMELI (kurye yanlislikla "uzerine alip" platform kuryesiyle catismasin),
   ama RESTORAN ekrani (admin) HER ZAMAN hepsini gormeli - restoranin kendi karari.
   Alan yoksa (eski config.json'lar) ESKI DAVRANIS (hepsini goster) korunur.
   Online/platform siparisi tespiti sambapos.js'teki detectOrderSource()'un DEGERINE
   dayanir (bu restoranda canli dogrulanmis tek guvenilir sinyal: platform
   entegrasyon kullanicisinin adi, orn. "Trendyol Yemek" - DB'de TicketType/Department
   HER SIPARISTE ayni/sabit cikti, ayirt edici degil; bu yuzden mevcut, kanitlanmis
   tespiti tekrar kullaniyoruz, yeni bir alan/sorgu uydurmuyoruz). */
const SHOW_ONLINE_ORDERS_TO_COURIERS = config.showOnlineOrdersToCouriers !== false;
function filterForCourierScreen(orders) {
  return SHOW_ONLINE_ORDERS_TO_COURIERS ? orders : orders.filter(o => o.source === 'Paket');
}

/* "notifyOnlineOrders" (16.09.2026, kullanici istegi) - showOnlineOrdersToCouriers'tan
   TAMAMEN BAGIMSIZ ikinci bir anahtar: bir siparis listede gorunebilir AMA bildirim
   GITMEYEBILIR (ya da tam tersi). false ise online/platform siparisleri icin push
   ATILMAZ (watchAndNotify - asagida), ama siparis veritabanina/rapora HER ZAMAN normal
   sekilde yaziliyor - SADECE bildirim gonderimi etkilenir. Alan yoksa varsayilan true
   (eski davranis: hepsi icin bildirim gider). */
const NOTIFY_ONLINE_ORDERS = config.notifyOnlineOrders !== false;
function isOnlineOrder(order) { return !!order && order.source !== 'Paket'; }

/* claimPackage() cagrildiginda buraya (ticketId -> zaman) yazilir - asagidaki
   arka plan bekcisi (watchAndNotify) bu ticket'in "artik bir kuryesi var" oldugunu
   gorse bile SELF-CLAIM oldugunu anlayip "sana atandi" push'u ATMAZ (kullanici
   istegi: kendi ustune alan kurye icin ses/bildirim gerekmez). 2 dakika sonra
   kendiliginden "eskir" - sonsuza kadar buyuyen bir Map olmasin diye. */
const recentSelfClaims = new Map();
const SELF_CLAIM_TTL_MS = 2 * 60 * 1000;

/* Arka planda, HICBIR tarayici sekmesi acik olmasa BILE calisan bekci: yeni bekleyen
   paket / yeni atama oldugunda TUM kuryelere (ya da ilgili kuryeye) push bildirimi
   gonderir (push.js). "Kurye uygulamadan cikmadigi surece bildirim servisi calismali"
   istegi (15.09.2026) - bu, uygulamanin KENDI sunucu surecinde, herhangi bir tarayici
   sekmesinden bagimsiz calisir; polling'e/tarayiciya guvenmez. */
let knownPendingIds = null;
let knownAssignments = null; // ticketId -> courierName
async function watchAndNotify() {
  try {
    const [pending, active] = await Promise.all([sambapos.unassignedPackages(), sambapos.activeCourierOrders()]);
    const pendingIds = new Set(pending.map(o => o.id));
    const assignments = new Map(active.filter(o => o.courierName).map(o => [o.id, o.courierName]));

    if (knownPendingIds !== null) {
      const newPending = pending.filter(o => !knownPendingIds.has(o.id));
      // notifyOnlineOrders=false ise platform siparisleri BILDIRIM ICIN sayilmaz (listede
      // yine gorunurler, bkz. showOnlineOrdersToCouriers - bu SADECE push'u etkiler).
      const notifiable = NOTIFY_ONLINE_ORDERS ? newPending : newPending.filter(o => !isOnlineOrder(o));
      if (notifiable.length) {
        const single = notifiable.length === 1 ? notifiable[0] : null;
        const onlineTag = single && isOnlineOrder(single) ? ` (ONLINE · ${single.source})` : '';
        await push.notifyAllCouriers({
          title: single ? `Yeni bekleyen sipariş${onlineTag}` : `${notifiable.length} yeni bekleyen sipariş`,
          body: single ? `#${single.number || single.id} · ${single.customerName || ''}` : 'Bekleyen paketler listesine düştü.',
          kind: 'yeni-bekleyen', tag: 'gks-bekleyen'
        });
      }
    }
    if (knownAssignments !== null) {
      const now = Date.now();
      for (const [id, courierName] of assignments) {
        if (knownAssignments.has(id)) continue; // zaten atanmisti, degisiklik yok
        const claimedAt = recentSelfClaims.get(id);
        if (claimedAt && now - claimedAt < SELF_CLAIM_TTL_MS) { recentSelfClaims.delete(id); continue; }
        const order = active.find(o => o.id === id);
        if (!NOTIFY_ONLINE_ORDERS && isOnlineOrder(order)) continue; // online siparis + bildirim kapali -> atla
        const onlineTag = isOnlineOrder(order) ? ` (ONLINE · ${order.source})` : '';
        await push.notifyCourier(courierName, {
          title: `Yeni sipariş atandı${onlineTag}`, body: `#${order ? (order.number || order.id) : id} size atandı.`,
          kind: 'atandi', tag: 'gks-atandi'
        });
      }
    }
    for (const [id, at] of recentSelfClaims) if (Date.now() - at > SELF_CLAIM_TTL_MS) recentSelfClaims.delete(id);

    knownPendingIds = pendingIds;
    knownAssignments = assignments;
  } catch (error) {
    console.error('watchAndNotify hatası (yoksayıldı, bir sonraki turda tekrar denenecek):', error.message);
  }
}

/* Bu fonksiyon, "kuryeler.ornek-alanadi.com" tuneli (tunnel.js) tarafindan da AYNEN
   cagirilir - gercek bir HTTP sunucusundan gelen req/res ile tunelden gelen
   TAKLIT req/res arasinda BURADA hicbir fark yoktur, TEK SATIR degismez. */
async function handleRequest(req, res) {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ip = auth.clientIp(req);
    applySecurityHeaders(req, res);

    if (u.pathname.startsWith('/api/') && isRateLimited(ip)) {
      return json(res, 429, { error: 'Çok fazla istek gönderildi. Lütfen biraz bekleyip tekrar deneyin.' });
    }

    /* Lisans kontrolu, giris ekranindan ONCE degil - statik sayfalar (login ekrani)
       her zaman acik kalir ki musteri neden calismadigini gorsun, ama HICBIR API
       islemi (giris denemesi dahil) lisans kapaliyken calismaz. */
    if (u.pathname.startsWith('/api/') && u.pathname !== '/api/config' && !license.isLicensed()) {
      return json(res, 403, { error: license.licenseError() || 'Bu kurulumun lisansı aktif değil. AlfaPOS ile iletişime geçin.' });
    }

    if (u.pathname === '/api/courier/login' && req.method === 'POST') {
      const wait = auth.lockedForMs(ip);
      if (wait > 0) return json(res, 429, { error: `Çok fazla hatalı deneme. ${Math.ceil(wait / 1000)} saniye sonra tekrar deneyin.` });
      const body = await auth.readJsonBody(req);
      const courier = await auth.courierLogin(String(body.pin || ''));
      if (!courier) { auth.registerFail(ip); return json(res, 401, { error: 'PIN hatalı.' }); }
      auth.registerSuccess(ip);
      const token = auth.newSession({ role: 'courier', courierId: courier.id, courierName: courier.name });
      auth.setSessionCookie(req, res, token, 'courier');
      // token'i govdede de don - istemci localStorage'a yazip X-Session-Token olarak
      // geri gonderir, cerez tutmazsa/silinirse bile oturum kalici olur (bkz. auth.js).
      return json(res, 200, { ok: true, courierName: courier.name, token });
    }
    /* Restoran/admin girisi IKI ADIMA bolunmustur (13.09.2026, canli bir karisiklik
       sonrasi): 1) e-posta/telefon + BULUT PANEL SIFRESI (musterinin diger panellerde
       de kullandigi GERCEK sifre, customers.password_hash'e karsi dogrulanir), 2)
       SADECE 1. adim basarili olduktan sonra SambaPOS admin PIN'i sorulur. Onceki
       tek-ekranli tasarimda kullanici bulut sifresini SambaPOS PIN'i saniyor,
       ikisini karistiriyordu. 1. adimi gecen oturum GECICI "admin-pending" rolundedir -
       gercek admin uclarinin hicbirine erisemez, sadece 2. adimi tamamlayabilir. */
    if (u.pathname === '/api/admin/login-step1' && req.method === 'POST') {
      const wait = auth.lockedForMs(ip);
      if (wait > 0) return json(res, 429, { error: `Çok fazla hatalı deneme. ${Math.ceil(wait / 1000)} saniye sonra tekrar deneyin.` });
      const body = await auth.readJsonBody(req);
      const identifier = String(body.identifier || '').trim();
      const password = String(body.password || '');
      if (!identifier || !password) return json(res, 400, { error: 'E-posta/telefon ve şifrenizi girin.' });
      const verified = await license.verifyPassword(identifier, password);
      if (!verified.ok) { auth.registerFail(ip); return json(res, 401, { error: verified.error || 'E-posta/telefon veya şifre hatalı.' }); }
      auth.registerSuccess(ip);
      const token = auth.newSession({ role: 'admin-pending' });
      auth.setSessionCookie(req, res, token, 'admin');
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/admin/login-step2' && req.method === 'POST') {
      const wait = auth.lockedForMs(ip);
      if (wait > 0) return json(res, 429, { error: `Çok fazla hatalı deneme. ${Math.ceil(wait / 1000)} saniye sonra tekrar deneyin.` });
      const pending = auth.currentSession(req);
      if (!pending || pending.role !== 'admin-pending') return json(res, 401, { error: 'Önce e-posta ve şifrenizle giriş yapın.' });
      const body = await auth.readJsonBody(req);
      if (!(await auth.adminLogin(String(body.pin || '')))) { auth.registerFail(ip); return json(res, 401, { error: 'PIN hatalı.' }); }
      auth.registerSuccess(ip);
      const token = auth.newSession({ role: 'admin' });
      auth.setSessionCookie(req, res, token, 'admin');
      return json(res, 200, { ok: true, token });
    }
    if (u.pathname === '/api/logout' && req.method === 'POST') {
      auth.destroySession(req);
      auth.clearSessionCookie(req, res);
      return json(res, 200, { ok: true });
    }
    /* restaurantLocation (16.09.2026, kullanici istegi): restoran ekraninda haritada
       SABIT bir ev ikonuyla gosterilecek konum - config.json'da elle girilir (biz
       tahmin edemeyiz), girilmemisse null doner, restoran/app.js hic marker eklemez. */
    if (u.pathname === '/api/config') return json(res, 200, { appName: APP_NAME, restaurantLocation: config.restaurantLocation || null });

    if (u.pathname.startsWith('/api/')) {
      /* admin VE kurye cerezleri AYNI cihazda birbirinden BAGIMSIZ olarak
         gecerli olabilir (APK'lar ayni Chrome depolamasini paylasiyor) - HER
         BIRI kendi cerezine gore ayri ayri cozulur, biri digerini "kazanip"
         gecersiz kilmaz (bkz. auth.js'teki not, 13.09.2026 canli tespit). */
      const adminSession = auth.currentSession(req, 'admin');
      const courierSession = auth.currentSession(req, 'courier');
      if (!adminSession && !courierSession) return json(res, 401, { error: 'Oturum gerekli.' });
      // Geriye donuk uyumluluk: rol farki gozetmeyen yerlerde (ownsOrder,
      // /api/me) "hangisi varsa" seklinde tek bir session da lazim - admin
      // BURADA da ONCELIKLI ama SADECE bilgi/erisim-VAR-MI amacli, kurye'ye
      // OZEL uclar asla bunu kullanmaz (dogrudan courierSession'a bakarlar).
      const session = adminSession || courierSession;

      if (u.pathname === '/api/me' && req.method === 'GET') {
        return json(res, 200, { role: session.role, courierName: session.courierName || null });
      }
      if (u.pathname === '/api/courier/unassigned' && req.method === 'GET') {
        return json(res, 200, { orders: filterForCourierScreen(await sambapos.unassignedPackages()) });
      }
      const claimMatch = u.pathname.match(/^\/api\/courier\/orders\/(\d+)\/claim$/);
      if (claimMatch && req.method === 'POST') {
        if (!courierSession) return json(res, 403, { error: 'Yetkiniz yok.' });
        try {
          await sambapos.claimPackage(claimMatch[1], courierSession.courierName);
        } catch (error) {
          return json(res, 409, { error: error.message });
        }
        logEvent(+claimMatch[1], courierSession.courierName, 'paket-alindi', null, null);
        wsServer.broadcastEvent({ kind: 'paket-alindi', ticketId: +claimMatch[1], courierName: courierSession.courierName });
        /* Kurye KENDI aldigi paket icin "sana atandi" sesli bildirimi ALMAMALI (kullanici
           istegi: "kurye kendi ustune alirsa ses celmasina gerek yok") - arka plan poller'i
           (asagida, watchForAssignments) bu ticket'in SambaPOS'ta artik bir kuryesi oldugunu
           gorup normalde "atandi" push'u atardi; buraya kaydedilen kisa omurlu isaret onu
           susturur. TTL kisa (2dk) - poller zaten ~10sn'de bir calisir, cok daha uzun tutmaya
           gerek yok, sonsuza kadar biriken bir Map olmasin diye. */
        recentSelfClaims.set(Number(claimMatch[1]), Date.now());
        return json(res, 200, { ok: true });
      }
      if (u.pathname === '/api/courier/orders' && req.method === 'GET') {
        const all = await sambapos.activeCourierOrders();
        // Restoran (admin) HER ZAMAN hepsini gorur, filtre SADECE kurye kendi listesine bakarken uygulanir.
        const scoped = adminSession ? all : filterForCourierScreen(all.filter(o => o.courierName === courierSession.courierName));
        return json(res, 200, { orders: scoped, appName: APP_NAME });
      }
      if (u.pathname === '/api/payment-types' && req.method === 'GET') {
        return json(res, 200, { types: await sambapos.paymentTypes() });
      }
      /* Kuryenin kendi ekraninda "bugun ne teslim ettim" ozeti - aksam raporu icin. */
      if (u.pathname === '/api/courier/my-deliveries' && req.method === 'GET') {
        if (!courierSession) return json(res, 403, { error: 'Yetkiniz yok.' });
        const day = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('date') || '') ? u.searchParams.get('date') : new Date().toISOString().slice(0, 10);
        const { start, end } = dayRangeUtc(day);
        const deliveries = courierDeliveries(courierSession.courierName, start, end);
        const total = deliveries.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
        return json(res, 200, { date: day, count: deliveries.length, total, deliveries });
      }
      /* "Gün Sonu" - kuryenin bugun ne kadar, hangi odeme turunden tahsil ettigi ozeti
         (kullanici istegi, 15.09.2026): "Bugünkü teslimatlar / Toplam ciro / Nakit /
         Kart / Online / Tahsil edilmesi gereken nakit". "Tahsil edilmesi gereken nakit"
         burada = bugun NAKIT turunde tahsil edilen toplam (kuryenin aksam restorana
         teslim etmesi gereken fiziksel para) - odeme turu ADI "nakit" gecen (kucuk/buyuk
         harf duyarsiz) turler nakit sayilir, digerleri (kart/online) zaten restorana
         dogrudan/elektronik gittigi icin kuryeden ayrica tahsil edilmez. */
      if (u.pathname === '/api/courier/end-of-day' && req.method === 'GET') {
        if (!courierSession) return json(res, 403, { error: 'Yetkiniz yok.' });
        const day = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('date') || '') ? u.searchParams.get('date') : new Date().toISOString().slice(0, 10);
        const { start, end } = dayRangeUtc(day);
        const deliveries = courierDeliveries(courierSession.courierName, start, end);
        const total = deliveries.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
        const byType = {};
        let cashToCollect = 0;
        for (const d of deliveries) {
          const name = d.payment_type_name || 'Bilinmiyor';
          byType[name] = (byType[name] || 0) + (Number(d.amount) || 0);
          if (/nakit|cash/i.test(name)) cashToCollect += Number(d.amount) || 0;
        }
        return json(res, 200, {
          date: day, count: deliveries.length, total,
          byType: Object.entries(byType).map(([paymentTypeName, amount]) => ({ paymentTypeName, amount })),
          cashToCollect
        });
      }
      /* Bekleyen siparis bildirimi ac/kapa - SUNUCU TARAFINDA saklanir (bkz. db.js notu):
         kurye kendi ekranindan degistirebilir AMA yonetici HER ZAMAN uzaktan geri
         acabilir/kapatabilir - kullanici istegi (15.09.2026): "bildirimi kurye kapatsa
         bile biz acabilecek olmaliyiz". */
      if (u.pathname === '/api/courier/settings' && req.method === 'GET') {
        if (!courierSession) return json(res, 403, { error: 'Yetkiniz yok.' });
        return json(res, 200, { notifyEnabled: getCourierNotifyEnabled(courierSession.courierName) });
      }
      if (u.pathname === '/api/courier/settings' && req.method === 'POST') {
        if (!courierSession) return json(res, 403, { error: 'Yetkiniz yok.' });
        const body = await auth.readJsonBody(req);
        setCourierNotifyEnabled(courierSession.courierName, !!body.notifyEnabled, courierSession.courierName);
        return json(res, 200, { ok: true });
      }
      if (u.pathname === '/api/admin/courier-settings' && req.method === 'GET') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        const couriers = await sambapos.couriers();
        const settings = new Map(allCourierNotifySettings().map(s => [s.courier_name, !!s.notify_enabled]));
        return json(res, 200, { couriers: couriers.map(c => ({ name: c.name, notifyEnabled: settings.has(c.name) ? settings.get(c.name) : true })) });
      }
      if (u.pathname === '/api/admin/courier-settings' && req.method === 'POST') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        const body = await auth.readJsonBody(req);
        if (!body.courierName) return json(res, 400, { error: 'Kurye adı eksik.' });
        setCourierNotifyEnabled(body.courierName, !!body.notifyEnabled, 'admin');
        return json(res, 200, { ok: true });
      }
      /* Push (arka plan bildirim) aboneligi - kurye giris yaptiktan sonra tarayicidan
         cagirir. subscription tarayicinin PushManager.subscribe() cikisi (endpoint+keys). */
      if (u.pathname === '/api/push/vapid-public-key' && req.method === 'GET') {
        return json(res, 200, { key: push.publicKey() });
      }
      if (u.pathname === '/api/push/subscribe' && req.method === 'POST') {
        const body = await auth.readJsonBody(req);
        if (!body.subscription || !body.subscription.endpoint) return json(res, 400, { error: 'Geçersiz abonelik.' });
        savePushSubscription(body.subscription.endpoint, courierSession ? courierSession.courierName : null, courierSession ? 'courier' : 'admin', JSON.stringify(body.subscription));
        return json(res, 200, { ok: true });
      }
      if (u.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
        const body = await auth.readJsonBody(req);
        if (body.endpoint) removePushSubscription(body.endpoint);
        return json(res, 200, { ok: true });
      }
      /* GERCEK uctan uca test - "sorun gercek bir siparis kacirilmadan ONCE fark
         edilsin" istegi (15.09.2026). Sahte/yerel bir bildirim DEGIL - sunucudan
         GERCEK bir push gonderilir (push.js -> web-push -> Google/Mozilla push
         servisi -> telefon) - kurye uygulamayi tamamen kapatip gercekten telefonuna
         dusup dusmedigini gorebilir. */
      if (u.pathname === '/api/push/test' && req.method === 'POST') {
        if (!courierSession) return json(res, 403, { error: 'Yetkiniz yok.' });
        if (!push.isReady()) return json(res, 503, { error: 'Sunucuda push henüz aktif değil.' });
        const subs = pushSubscriptionsForCourier(courierSession.courierName);
        if (!subs.length) return json(res, 404, { error: 'Kayıtlı bir abonelik bulunamadı - önce "Arka plan bildirimlerini etkinleştir" butonuna basın.' });
        await push.notifyCourier(courierSession.courierName, {
          title: 'Test Bildirimi', body: `${new Date().toLocaleTimeString('tr-TR')} - bu bildirim sunucudan gerçekten gönderildi.`,
          kind: 'test', tag: 'gks-test'
        });
        return json(res, 200, { ok: true, subscriptionCount: subs.length });
      }
      const contentMatch = u.pathname.match(/^\/api\/courier\/orders\/(\d+)\/content$/);
      if (contentMatch && req.method === 'GET') {
        /* "Sipariş içeriğini göster" butonu HEM Bekleyen Paketler (henuz kimseye
           atanmamis) HEM Uzerimdekiler listesinde gorunur (public/courier/app.js:73) -
           ama burada SADECE activeCourierOrders() (atanmis siparisler) icinde arandigi
           icin bekleyen bir paketin icerigine bakmaya calisan kurye hep "izin yok"
           aliyordu (13.09.2026, canli tespit). Atanmamis bir paketin icerigi herkese
           acik olmali (henuz sahiplenilmeden karar vermek icin), atanmis bir paketin
           icerigi ise SADECE sahibine/admin'e (ownsOrder). */
        const active = (await sambapos.activeCourierOrders()).find(o => String(o.id) === contentMatch[1]);
        if (active) {
          if (!ownsOrder(session, active)) return json(res, 403, { error: 'Bu siparişe erişiminiz yok.' });
        } else {
          const pending = (await sambapos.unassignedPackages()).find(o => String(o.id) === contentMatch[1]);
          if (!pending) return json(res, 403, { error: 'Bu siparişe erişiminiz yok.' });
        }
        return json(res, 200, { items: await sambapos.orderContent(contentMatch[1]) });
      }
      const deliveredMatch = u.pathname.match(/^\/api\/courier\/orders\/(\d+)\/delivered$/);
      if (deliveredMatch && req.method === 'POST') {
        const order = (await sambapos.activeCourierOrders()).find(o => String(o.id) === deliveredMatch[1]);
        if (!order || !ownsOrder(session, order)) return json(res, 403, { error: 'Bu siparişe erişiminiz yok.' });
        const body = await auth.readJsonBody(req);
        const noPayment = !!body.noPayment;
        let result;
        try {
          result = await sambapos.markDelivered(deliveredMatch[1], body.paymentTypeId, noPayment, session.courierId, body.tenderedAmount);
        } catch (error) {
          return json(res, 409, { error: error.message });
        }
        /* Guvenlik agi: order.courierName normalde HICBIR ZAMAN bos olamaz (SQL
           WHERE'i zaten bos olanlari eler) ama "raporlarda kurye adi bos gorunuyor"
           sikayeti sonrasi (15.09.2026) - muhtemelen SambaPOS masaustu istemcisiyle
           ES ZAMANLI bir etkilesimden kaynaklanan nadir bir yaris durumu icin - burada
           oturumun KENDI adina dusulur, raporda ASLA bos "Kurye" hucresi gorunmez. */
        const courierNameForLog = order.courierName || (session.role === 'courier' ? session.courierName : 'Bilinmeyen kurye');
        logEvent(order.id, courierNameForLog, result.closed ? 'teslim-edildi' : 'teslim-odeme-bekliyor', null, result.amountCollected, {
          paymentTypeId: result.paymentTypeId, paymentTypeName: result.paymentTypeName,
          ticketNumber: order.number, customerName: order.customerName, orderTotal: order.total,
          tenderedAmount: result.tenderedAmount, changeAmount: result.changeAmount, orderSource: order.source
        });
        wsServer.broadcastEvent({
          kind: result.closed ? 'teslim-edildi' : 'teslim-odeme-bekliyor',
          ticketId: order.id, number: order.number, courierName: courierNameForLog, amountCollected: result.amountCollected
        });
        return json(res, 200, { ok: true, ...result });
      }
      if (u.pathname === '/api/admin/couriers' && req.method === 'GET') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        return json(res, 200, { couriers: await sambapos.couriers() });
      }
      if (u.pathname === '/api/courier/location' && req.method === 'POST') {
        if (!courierSession) return json(res, 403, { error: 'Yetkiniz yok.' });
        const body = await auth.readJsonBody(req);
        const lat = Number(body.lat), lng = Number(body.lng);
        const accuracy = body.accuracy != null ? Number(body.accuracy) : null;
        /* Konum dogrulama (16.09.2026, kullanici istegi): sayi olmayan/asiri belirsiz
           (accuracy>100m) ya da "null island" (0,0 - GPS hatasinda sik gorulen bir
           varsayilan) konumlar YOK sayilir - marker haritada yanlis yere zipla(t)masin. */
        const invalid = !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)
          || (accuracy != null && Number.isFinite(accuracy) && accuracy > 100);
        if (invalid) return json(res, 400, { error: 'Geçersiz konum.' });
        setCourierLocation(courierSession.courierName, lat, lng, accuracy);
        wsServer.broadcastEvent({ kind: 'konum', courierName: courierSession.courierName, lat, lng, accuracy });
        return json(res, 200, { ok: true });
      }
      if (u.pathname === '/api/admin/locations' && req.method === 'GET') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        /* Eski/artik gecerli olmayan kurye adlari haritada SONSUZA KADAR asili
           kalmasin (ornegin "Kurye yusuf" - SambaPOS'ta yeniden adlandirilmis/
           silinmis bir kullanicidan kalma eski konum kaydi, 15.09.2026 canli
           tespit) - iki filtre birlikte: (1) SU AN GERCEKTEN var olan bir kurye
           kullanicisina ait olmali, (2) 10 dakikadan eski degil (daha eski ise
           kurye zaten cevrimdisi demektir, kaldirilir). AYRICA (16.09.2026,
           kullanici istegi): 3-10 dakika arasi "stale" (bekleniyor/gri) olarak
           isaretlenir - kurye telefonu kapatildiginda/sinyal kesildiginde marker
           HEMEN kaybolmak yerine once "baglanti bekleniyor" gosterir. */
        const [locations, currentCouriers] = await Promise.all([Promise.resolve(allCourierLocations()), sambapos.couriers()]);
        const currentNames = new Set(currentCouriers.map(c => c.name));
        const now = Date.now();
        const STALE_MS = 3 * 60 * 1000, GONE_MS = 10 * 60 * 1000;
        const fresh = locations
          .filter(l => currentNames.has(l.courier_name))
          .map(l => ({ l, ageMs: now - new Date(l.updated_at.replace(' ', 'T') + 'Z').getTime() }))
          .filter(({ ageMs }) => Number.isFinite(ageMs) && ageMs < GONE_MS)
          .map(({ l, ageMs }) => ({ ...l, stale: ageMs >= STALE_MS }));
        return json(res, 200, { locations: fresh });
      }
      /* "Canli Akis" sekmesi SADECE WebSocket push'una bagliydi - kuryeler.ornek-alanadi.com
         tuneli WS'i henuz tasimadigi icin (bkz. tunnel.js/gk-web.js) tunel uzerinden
         erisimde sekme HER ZAMAN bombos kaliyordu (13.09.2026, canli tespit). Bu uc,
         zaten var olan ama hic kullanilmayan recentEvents() ile son olaylari REST
         uzerinden de getirir - WS calisiyorsa aninda, calismiyorsa (tunel) ilk
         yuklemede/pollingde gorunur olur. */
      if (u.pathname === '/api/admin/recent-events' && req.method === 'GET') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        return json(res, 200, { events: recentEvents(50) });
      }
      /* "Paketçi Raporu": bugun (ya da secilen tarih) her kuryenin kac paket teslim
         ettigi + ne kadar tahsil ettigi, "su an uzerinde" bekleyen/yoldaki paket sayisiyla
         birlikte - kendi-restoranim-kurye'deki admin raporuyla ayni mantik. */
      if (u.pathname === '/api/admin/report' && req.method === 'GET') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        const day = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('date') || '') ? u.searchParams.get('date') : new Date().toISOString().slice(0, 10);
        const { start, end } = dayRangeUtc(day);
        const delivered = deliverySummary(start, end);
        const activeByCourier = {};
        for (const o of await sambapos.activeCourierOrders()) {
          const bucket = activeByCourier[o.courierName] || (activeByCourier[o.courierName] = { pending: 0, enroute: 0 });
          if (o.packageStatus === 'Yolda') bucket.enroute++; else bucket.pending++;
        }
        const names = new Set([...delivered.map(d => d.courier_name), ...Object.keys(activeByCourier)]);
        const byCourier = [...names].sort().map(name => {
          const d = delivered.find(row => row.courier_name === name);
          const a = activeByCourier[name] || { pending: 0, enroute: 0 };
          return { courierName: name, pending: a.pending, enroute: a.enroute, deliveredCount: d ? d.count : 0, deliveredTotal: d ? d.total : 0 };
        });
        /* "Ödeme türüne göre nasıl alınmış" kırılımı - kullanıcı isteği (15.09.2026):
           "sadece toplam ödeme göstermek yerine paranın nasıl alındığını ayrı ayrı
           göster". paymentTypes gercek SambaPOS turlerinin adiyla gelir, sabit
           Nakit/Kart/Online kategorileri VARSAYILMAZ. */
        const payments = paymentBreakdown(start, end);
        const grandTotal = payments.reduce((sum, p) => sum + (Number(p.total) || 0), 0);
        return json(res, 200, {
          date: day, byCourier,
          payments: payments.map(p => ({ paymentTypeName: p.payment_type_name, count: p.count, total: p.total })),
          grandTotal
        });
      }
      /* Her siparisin tek tek satiri - admin "Ödeme Raporu" detay tablosu. */
      if (u.pathname === '/api/admin/report/deliveries' && req.method === 'GET') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        const day = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('date') || '') ? u.searchParams.get('date') : new Date().toISOString().slice(0, 10);
        const { start, end } = dayRangeUtc(day);
        const rows = deliveryDetails(start, end).map(r => ({
          ticketId: r.ticket_id, ticketNumber: r.ticket_number, courierName: r.courier_name,
          customerName: r.customer_name, orderTotal: r.order_total, paymentTypeName: r.payment_type_name,
          amountCollected: r.amount, tenderedAmount: r.tendered_amount, changeAmount: r.change_amount,
          orderSource: r.order_source, at: r.at
        }));
        return json(res, 200, { date: day, deliveries: rows });
      }
      /* GECICI TESHIS UCU: "kurye PIN'i yanlis" hatasinin gercek nedenini bulmak icin -
         hangi Kullanici Rolu ID'sinin gercekten "Paketciler" oldugunu ve o rol altinda
         kayitli PIN'leri gosterir. Sadece admin oturumuyla erisilir. Sorun cozulunce
         bu uc kaldirilacak. */
      if (u.pathname === '/api/admin/debug/roles' && req.method === 'GET') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Yetkiniz yok.' });
        return json(res, 200, { rows: await sambapos.debugRolesAndUsers() });
      }
      return json(res, 404, { error: 'Bulunamadı' });
    }

    serveStatic(req, res, u.pathname);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

http.createServer(handleRequest).listen(PORT, config.bindHost, function () {
  wsServer.attach(this);
  console.log(`${APP_NAME}: http://127.0.0.1:${PORT}  (kurye: /courier, restoran: /restoran)`);
  if (push.isReady()) {
    console.log(`${APP_NAME}: push bildirimleri aktif (VAPID anahtarı hazır).`);
    setInterval(watchAndNotify, 10000);
    watchAndNotify();
  } else {
    console.log(`${APP_NAME}: push bildirimleri pasif (web-push paketi kurulu değil ya da anahtar üretilemedi) - uygulama açıkken sesli alarm yine çalışır.`);
  }
});
/* config.bindHost YOKSA (restoran kurulumlarinin normal hali) tum arayuzlerde dinler -
   kurye telefonlari ayni WiFi'den yerel IP ile erisebilsin diye kasitli. Bu VPS'teki
   test ornegi gibi ONUNDE Caddy/HTTPS olan yerlerde config.json'a "bindHost":"127.0.0.1"
   eklenerek dogrudan disariya acilmasi engellenir. */

/* Buluttan (kuryeler.ornek-alanadi.com) uzaktan erisim tuneli - ayri bir Gelismis Kurye
   aktivasyon anahtari VARSA baslar, yoksa hic denemez (yerel-sadece kurulumlar
   etkilenmez). Lisans kontrolunden (license.js) BAGIMSIZ, kendi baglanti/yeniden
   deneme dongusune sahiptir. */
try { require('./tunnel').start(handleRequest); } catch (error) { console.error('Tünel modülü başlatılamadı (yoksayıldı):', error.message); }

/* Otomatik guncelleme - C:\toplu\kurye-bulut-ajan\updater.js ile AYNI kanitlanmis
   desen. config.json'da "cloudServerUrl" YOKSA app.ornek-alanadi.com varsayilir. */
try { require('./updater').start(config); } catch (error) { console.error('Güncelleme modülü başlatılamadı (yoksayıldı):', error.message); }

process.on('uncaughtException', error => console.error('Yakalanmamış hata:', error));
process.on('unhandledRejection', error => console.error('Yakalanmamış Promise reddi:', error));
