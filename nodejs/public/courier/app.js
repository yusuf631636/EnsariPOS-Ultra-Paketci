if ('serviceWorker' in navigator) {
  // updateViaCache:'none' - sw.js dosyasinin KENDISI tarayici HTTP onbellegine
  // takilip eski kalmasin diye (bu oturumda .exe/.apk indirmelerinde yasanan
  // "eski surum inatla kaliyor" sorununun ayni sinifindan - service worker
  // icin ayrica onlem alinmazsa AYNI seye ugrar).
  window.addEventListener('load', () => navigator.serviceWorker.register('/courier/sw.js', { updateViaCache: 'none' }).catch(() => {}));
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'notification-click') switchTab(e.data.kind === 'atandi' ? 'mine' : 'unassigned');
  });
}

let activeTab = 'unassigned';
let selectedPayTypeId = null;
let selectedPayTypeName = '';
let deliverTicketId = null;
let deliverOrderRemaining = 0;
let payTypesCache = null;
let knownMineIds = new Set();
let knownUnassignedIds = new Set();
let unassignedById = new Map();
let hasLoadedMineOnce = false; // ilk yuklemede mevcut siparisleri "yeni" gibi seslendirmemek icin
let hasLoadedUnassignedOnce = false;
let missedOrders = []; // bu oturumda: gorunup courier almadan kaybolan siparisler (sunucuya kaydedilmiyor, sadece bu ekranda)
let snoozeUntil = 0;
let snoozeTimer = null;
let serverNotifyEnabled = null; // null = henuz sunucudan okunamadi -> yerel ayara dusulur

/* Yoneticinin uzaktan ac/kapa yapabilmesi icin (bkz. server.js /api/courier/settings) -
   giriste VE her pollingde tazelenir, boylece yonetici degistirdiginde kurye ekranina
   ~8sn icinde yansir. */
async function syncServerNotifySetting() {
  try {
    const data = await api('/api/courier/settings');
    serverNotifyEnabled = !!data.notifyEnabled;
    refreshSettingsUI();
  } catch { /* offline - en son bilinen deger (ya da null->yerel ayar) korunur */ }
}

function ageMinutes(dateStr) {
  if (!dateStr) return 0;
  const then = new Date(String(dateStr).replace(' ', 'T')).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.round((Date.now() - then) / 60000));
}
function ageBadgeHtml(mins) {
  const cls = mins >= 15 ? 'critical' : mins >= 8 ? 'warn' : '';
  return `<span class="age-badge ${cls}">${mins} dk bekliyor</span>`;
}

function money(n) { return `${(Number(n) || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`; }

/* --- Yüksek sesli bildirimler: "atandi" küçük banner, "bekleyen" TAM EKRAN uyarı
   (kullanıcı isteği: "Yeni bekleyen siparişte ekranda büyük şekilde 'YENİ BEKLEYEN
   SİPARİŞ' görünsün") - ikisi de görülene/kapatılana kadar alarm çalmaya devam eder. --- */
let bannerDismissTab = null;
function showAlarmBanner(kind, title, sub) {
  const host = document.getElementById('alarmBannerHost');
  host.innerHTML = '';
  const el = document.createElement('div');
  el.className = `alarm-banner ${kind === 'atandi' ? 'assign' : ''}`;
  el.innerHTML = `<div class="txt"><b>${title}</b><span>${sub || ''}</span></div><button id="alarmDismissBtn">Tamam</button>`;
  host.appendChild(el);
  bannerDismissTab = 'mine';
  document.getElementById('alarmDismissBtn').onclick = () => dismissAlarmBanner();
}
function dismissAlarmBanner() {
  document.getElementById('alarmBannerHost').innerHTML = '';
  if (window.GksAlarm) GksAlarm.stop();
  bannerDismissTab = null;
}

function showFullscreenAlert(title, sub) {
  document.getElementById('faTitle').textContent = title;
  document.getElementById('faSub').textContent = sub || '';
  document.getElementById('fullscreenAlert').hidden = false;
}
function hideFullscreenAlert(stopSound) {
  document.getElementById('fullscreenAlert').hidden = true;
  if (stopSound && window.GksAlarm) GksAlarm.stop();
}
/* "5 dakika sustur": alarmı susturur ama 5dk sonra HALA bekleyen paket varsa (kurye
   ne "Gördüm" ne de sekmeye geçiş yaparak fiilen ilgilenmediyse) yeniden uyarır -
   kullanıcı isteği: "5 dakika sustur diyebilsin ama yeni sipariş geldiğinde tekrar
   alarm çalsın" (yeni/farklı bir sipariş geldiğinde zaten AYRI bir "yeni" tetiklemesi
   olarak, snooze'dan BAĞIMSIZ hemen alarm çalar - bkz. loadUnassigned). */
function snoozeAlarm() {
  hideFullscreenAlert(true);
  snoozeUntil = Date.now() + 5 * 60 * 1000;
  clearTimeout(snoozeTimer);
  snoozeTimer = setTimeout(() => {
    if (knownUnassignedIds.size > 0 && activeTab !== 'unassigned') {
      showFullscreenAlert('HÂLÂ BEKLEYEN SİPARİŞ VAR', `${knownUnassignedIds.size} paket bekliyor.`);
      if (window.GksAlarm) GksAlarm.play('bekleyen');
    }
  }, 5 * 60 * 1000);
}

/* Restoran (SambaPOS'un kendi ekranindan) bu kuryeye yeni bir paket atadiginda VEYA
   bekleyen kuyruguna yeni bir siparis dustugunde YUKSEK SESLI, siparis gorulene kadar
   tekrarlanan alarm - kullanici istegi (15.09.2026). Kurye KENDI "Bu paketi al" dediginde
   (claimPackage - asagida) ses CALINMAZ; knownMineIds oraya HEMEN eklendigi icin buradaki
   fark (diff) onu "yeni" saymaz. snooze aktifken YENİ (daha önce hiç görülmemiş) bir
   sipariş gelirse yine de alarm çalar - snooze sadece "hâlâ bekliyor" hatırlatmasını susturur. */
function announceNewOrder(kind, title, sub) {
  if (kind === 'bekleyen') {
    // "Bildirme" seciliyse: siparis zaten normal listede goruntuleniyor (loadUnassigned
    // her zaman render eder) - burada SADECE ses/tam ekran uyariyi atlıyoruz. SUNUCUDAN
    // gelen deger (serverNotifyEnabled) ONCELIKLIDIR - yonetici uzaktan acmis/kapatmissa
    // o gecerlidir; sunucudan hic okunamadiysa (offline/ilk yukleme) yerel ayara dusulur.
    const pendingOn = serverNotifyEnabled !== null ? serverNotifyEnabled : (!window.GksAlarm || GksAlarm.settings.get().pendingAlarmEnabled !== false);
    if (!pendingOn) return;
    if (window.GksAlarm) GksAlarm.play('bekleyen');
    showFullscreenAlert(title.toUpperCase(), sub);
  } else {
    if (window.GksAlarm) GksAlarm.play(kind);
    showAlarmBanner(kind, title, sub);
  }
}

/* Oturum kalicilik yedegi (16.09.2026, kullanici istegi: "sayfa yenilenince/telefon
   kilitlenip acilinca sifre sormasin, TUM sekmeler kapansa/telefon yeniden baslasa
   bile"). Cerez zaten 180 gun kalici ama iOS PWA'da BAZEN guvenilmez olabiliyor
   (bkz. auth.js'teki not) - ayni token localStorage'da da tutulup HER istekte
   X-Session-Token header'i olarak gonderilir, boylece cerez tutmasa bile sunucu
   oturumu tanir. localStorage erisimi (private/gizli sekme, devre disi vb.) hata
   verebilir - try/catch ile sarilir, olmazsa sadece cereze guvenilir (eski davranis). */
const TOKEN_KEY = 'ultra_courier_token';
function getStoredToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
function setStoredToken(token) { try { if (token) localStorage.setItem(TOKEN_KEY, token); } catch {} }
function clearStoredToken() { try { localStorage.removeItem(TOKEN_KEY); } catch {} }

async function api(path, opts) {
  const token = getStoredToken();
  const headers = { 'Content-Type': 'application/json', ...(token ? { 'X-Session-Token': token } : {}) };
  const res = await fetch(path, { credentials: 'same-origin', headers, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'İstek başarısız.');
  return data;
}

async function login() {
  const pin = document.getElementById('pinInput').value.trim();
  const errBox = document.getElementById('loginErr');
  errBox.hidden = true;
  try {
    const data = await api('/api/courier/login', { method: 'POST', body: JSON.stringify({ pin }) });
    setStoredToken(data.token);
    document.getElementById('courierName').textContent = data.courierName;
    document.getElementById('loginView').hidden = true;
    document.getElementById('mainView').hidden = false;
    startPolling();
    requestAllPermissions();
  } catch (error) {
    errBox.textContent = error.message;
    errBox.hidden = false;
  }
}

async function logout() {
  if (window.GksAlarm) GksAlarm.stop();
  if (wakeLock) { try { await wakeLock.release(); } catch {} wakeLock = null; }
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  clearStoredToken();
  location.reload();
}

function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tabUnassigned').classList.toggle('active', tab === 'unassigned');
  document.getElementById('tabMine').classList.toggle('active', tab === 'mine');
  document.getElementById('tabDeliveries').classList.toggle('active', tab === 'deliveries');
  document.getElementById('tabEod').classList.toggle('active', tab === 'eod');
  document.getElementById('unassignedView').hidden = tab !== 'unassigned';
  document.getElementById('mineView').hidden = tab !== 'mine';
  document.getElementById('deliveriesView').hidden = tab !== 'deliveries';
  document.getElementById('eodView').hidden = tab !== 'eod';
  if (tab === 'deliveries') loadDeliveries();
  if (tab === 'eod') loadEod();
  // ilgili sekmeye gecince, o sekmeyle ilgili alarm otomatik susar (goruldu sayilir)
  if (tab === bannerDismissTab) dismissAlarmBanner();
  if (tab === 'unassigned') { hideFullscreenAlert(true); clearTimeout(snoozeTimer); snoozeUntil = 0; }
}

function sourceBadgeClass(source) {
  if (!source) return '';
  if (source.includes('Yemeksepeti')) return 'src-ys';
  if (source.includes('Trendyol')) return 'src-ty';
  if (source.includes('Getir')) return 'src-getir';
  if (source.includes('Migros')) return 'src-migros';
  return 'src-restoran';
}
/* Telefon numarasindan WhatsApp linki (16.09.2026, kullanici istegi: "kurye direk
   whatsaptan arayabilsin"). parsePhoneFromName (sambapos.js) 10 haneli ("5xx...")
   veya basinda 0 ile 11 haneli ("05xx...") dondurebilir - wa.me "90" + 10 hane
   (basinda 0 OLMADAN) bekler. NOT: Trendyol/Getir/Migros/Yemeksepeti gibi platform
   siparislerinde SambaPOS'a musteri telefonu HIC gelmiyor (canli DB'de dogrulandi -
   platformlar gizlilik icin numarayi paylasmiyor) - bu durumda zaten "phone" bos
   oldugundan asagidaki "Telefon yok" hali degismeden kalir, uydurma numara YOK. */
/* Basinda "0" olmadan kayitli numaralar (SambaPOS'a personel bazen 10 haneli,
   bazen basinda 0 ile 11 haneli yaziyor - tutarli degil) telefon UYGULAMASINDA
   "0"i KENDILIGINDEN eklemiyor, kurye "sifiri almiyor" diye sikayet etti
   (16.09.2026) - tel: linki VE ekrandaki gosterim ARTIK HER ZAMAN basinda 0'li,
   11 haneli standart yerli formata (0XXXXXXXXXX) normallestiriliyor. */
function toDialPhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.length === 10) p = '0' + p;
  return p.length === 11 ? p : String(phone || '');
}
function toWhatsAppLink(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.length === 11 && p.startsWith('0')) p = p.slice(1);
  return p.length === 10 ? `https://wa.me/90${p}` : null;
}
function orderCard({ id, number, total, customerName, address, phone, date, source }, kind) {
  const el = document.createElement('div');
  const mins = kind === 'unassigned' ? ageMinutes(date) : 0;
  el.className = `order${mins >= 15 ? ' stale' : ''}`;
  const dialPhone = phone ? toDialPhone(phone) : '';
  const waLink = phone ? toWhatsAppLink(phone) : null;
  el.innerHTML = `
    <div class="order-top"><span class="num">#${number || id}</span><span class="amount">${money(total)}</span></div>
    <div class="order-name">${customerName || 'Bilinmeyen'}</div>
    ${address ? `<div class="order-address">${address}</div>` : ''}
    <div class="order-meta">${source ? `<span class="source-badge ${sourceBadgeClass(source)}">${source}</span>` : ''}${phone ? `<span>${dialPhone}</span>` : ''}${kind === 'unassigned' ? ageBadgeHtml(mins) : ''}</div>
    <div class="actions">
      ${phone ? `<a href="tel:${dialPhone}">📞 Ara</a>` : `<span class="unavailable">Telefon yok</span>`}
      ${waLink ? `<a href="${waLink}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ''}
      ${address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank">🗺️ Yol Tarifi</a>` : `<span class="unavailable">Adres yok</span>`}
    </div>
    <button class="content-toggle" data-content="${id}">Sipariş içeriğini göster</button>
    ${kind === 'unassigned' ? `<button class="claim-btn" data-claim="${id}">Bu paketi al</button>` : `<button class="deliver-btn" data-deliver="${id}" data-remaining="${total}">Teslim Et</button>`}
  `;
  return el;
}

/* "Kaçırılanlar": bu kuryenin ekraninda bir an gorunup, KENDISI almadan (baskasi
   aldi/kapandi) listeden dusen siparisler - sadece bu oturumda (sayfa yenilenince
   sifirlanir, sunucuya kaydedilmiyor - kalici gecmis icin ayri, daha buyuk bir is
   gerekir, bkz. konusma notlari). */
function renderMissed() {
  const wrap = document.getElementById('missedWrap');
  const list = document.getElementById('missedList');
  wrap.hidden = missedOrders.length === 0;
  list.innerHTML = missedOrders.slice(0, 10).map(o => `
    <div class="order missed">
      <div class="order-top"><span class="num">#${o.number || o.id}</span><span class="amount">${money(o.total)}</span></div>
      <div class="order-name">${o.customerName || 'Bilinmeyen'}</div>
      <div class="order-meta"><span>Kaçırıldı · ${new Date(o.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span></div>
    </div>`).join('');
}

async function loadUnassigned() {
  const data = await api('/api/courier/unassigned');
  const list = document.getElementById('unassignedList');
  const empty = document.getElementById('unassignedEmpty');
  document.getElementById('countUnassigned').textContent = data.orders.length ? ` (${data.orders.length})` : '';

  const currentIds = new Set(data.orders.map(o => o.id));
  // Bu tur atlanan (kayboldu ama bu kurye almadi -> "kacirildi") - ilk yuklemede
  // henuz hicbir sey "biliniyor" olmadigi icin sayilmaz, ayrica kendi aldigimiz
  // (knownMineIds'e gecen) bir paket "kacirilan" DEGILDIR.
  if (hasLoadedUnassignedOnce) {
    for (const prevOrder of unassignedById.values()) {
      if (!currentIds.has(prevOrder.id) && !knownMineIds.has(prevOrder.id)) {
        missedOrders.unshift({ ...prevOrder, at: Date.now() });
      }
    }
    missedOrders = missedOrders.slice(0, 20);
  }
  unassignedById = new Map(data.orders.map(o => [o.id, o]));

  const newOnes = hasLoadedUnassignedOnce ? data.orders.filter(o => !knownUnassignedIds.has(o.id)) : [];
  if (newOnes.length) {
    announceNewOrder('bekleyen',
      newOnes.length === 1 ? 'Yeni bekleyen sipariş!' : `${newOnes.length} yeni bekleyen sipariş!`,
      newOnes.length === 1 ? `#${newOnes[0].number || newOnes[0].id} · ${newOnes[0].customerName || ''}` : 'Bekleyen Paketler sekmesine düştü.');
  }
  hasLoadedUnassignedOnce = true;
  knownUnassignedIds = currentIds;

  list.innerHTML = '';
  empty.hidden = data.orders.length > 0;
  data.orders.forEach(order => list.appendChild(orderCard(order, 'unassigned')));
  renderMissed();
}

async function loadMine() {
  const data = await api('/api/courier/orders');
  const list = document.getElementById('mineList');
  const empty = document.getElementById('mineEmpty');
  document.getElementById('countMine').textContent = data.orders.length ? ` (${data.orders.length})` : '';

  const currentIds = new Set(data.orders.map(o => o.id));
  const newOnes = hasLoadedMineOnce ? data.orders.filter(o => !knownMineIds.has(o.id)) : [];
  if (newOnes.length) {
    announceNewOrder('atandi', 'Yeni sipariş atandı',
      newOnes.length === 1 ? `#${newOnes[0].number || newOnes[0].id} size atandı.` : `${newOnes.length} sipariş size atandı.`);
  }
  hasLoadedMineOnce = true;
  knownMineIds = currentIds;

  list.innerHTML = '';
  empty.hidden = data.orders.length > 0;
  data.orders.forEach(order => {
    const el = orderCard(order, 'mine');
    const badge = document.createElement('span');
    badge.className = `badge ${order.packageStatus === 'Yolda' ? 'yolda' : 'bekliyor'}`;
    badge.textContent = order.packageStatus || 'Bekliyor';
    el.querySelector('.order-meta').appendChild(badge);
    list.appendChild(el);
  });
}

async function loadDeliveries() {
  const data = await api('/api/courier/my-deliveries');
  document.getElementById('deliveriesSummary').innerHTML = `<b>${data.count}</b> paket teslim edildi · <b>${money(data.total)}</b> tahsilat <span class="muted">(bugün)</span>`;
  const list = document.getElementById('deliveriesList');
  const empty = document.getElementById('deliveriesEmpty');
  empty.hidden = data.deliveries.length > 0;
  list.innerHTML = data.deliveries.map(d => `
    <div class="order">
      <div class="order-top"><span class="num">#${d.ticket_number || d.ticket_id}</span><span class="amount">${money(d.amount)}</span></div>
      <div class="order-name">${d.customer_name || 'Bilinmeyen'}</div>
      <div class="order-meta"><span>${new Date(d.at.replace(' ', 'T') + 'Z').toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span>${d.payment_type_name ? `<span>${d.payment_type_name}</span>` : ''}</div>
    </div>`).join('');
}

/* "Gün Sonu": bugün ne kadar hangi ödeme türünden alındı + kuryenin restorana teslim
   etmesi gereken nakit toplamı. */
async function loadEod() {
  let data;
  try { data = await api('/api/courier/end-of-day'); } catch { return; }
  document.getElementById('eodTotal').textContent = money(data.total);
  document.getElementById('eodCount').textContent = `${data.count} teslimat (bugün)`;
  const rows = data.byType.map(t => `<div class="pay-row"><span>${t.paymentTypeName}</span><span>${money(t.amount)}</span></div>`).join('');
  const cashRow = `<div class="pay-row total"><span>Tahsil edilmesi gereken nakit</span><span>${money(data.cashToCollect)}</span></div>`;
  document.getElementById('eodBreakdown').innerHTML = (rows || '<div class="empty" style="padding:24px">Bugün teslimat yok.</div>') + (data.count ? cashRow : '');
}

async function refresh() {
  try {
    document.getElementById('statusDot').classList.remove('off');
    document.getElementById('offlineBannerHost').innerHTML = '';
    await Promise.all([loadUnassigned(), loadMine()]);
  } catch {
    document.getElementById('statusDot').classList.add('off');
    document.getElementById('offlineBannerHost').innerHTML = '<div class="offline-banner">Bağlantı yok - yeniden bağlanmaya çalışılıyor…</div>';
  }
}

function startPolling() {
  refresh();
  syncServerNotifySetting();
  setInterval(refresh, 8000);
  setInterval(syncServerNotifySetting, 8000);
  setInterval(checkPushHealth, 10 * 60 * 1000);
  setupLocationPermissionUi();
}

/* "İnternet kısa süreli giderse bağlantıyı tekrar kurmaya çalışsın, geldiğinde
   bekleyenleri senkronize etsin" (kullanıcı isteği) - tarayıcının online olayı VE
   sekme tekrar görünür olduğu an (telefon kilidi açıldığında vb.) ANINDA bir
   refresh tetiklenir, 8sn'lik normal döngüyü beklemeye gerek kalmaz. */
window.addEventListener('online', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

/* Kurye izin verdigi surece konumu sunucuya gonderir (restoran ekranindaki canli
   haritada gorunsun diye) - kendi-restoranim-kurye ile ayni temel desen, 16.09.2026'da
   kullanici istegiyle GENISLETILDI:
   - Sabit 15sn yerine hareket halindeyken 7sn (5-10sn araligi), NEREDEYSE hic hareket
     etmiyorsa (son gonderilen noktadan <15m) en fazla 60sn'de bir - pil/veri tasarrufu,
     ayrica sunucuyu bosuna doldurmaz.
   - Gecersiz/asiri belirsiz konum (accuracy>100m, ya da lat/lng 0,0 gibi GPS hatasi)
     HIC gonderilmez - marker haritada yanlis yere zipla(t)masin (sunucu tarafinda da
     ayrica dogrulaniyor, bkz. server.js - burasi ilk/hizli filtre). */
let watchId = null;
let lastSentAt = 0, lastSentLat = null, lastSentLng = null;
const LOCATION_MOVING_INTERVAL_MS = 7000;
const LOCATION_STATIONARY_INTERVAL_MS = 60000;
const LOCATION_MOVE_THRESHOLD_M = 15;
const LOCATION_MAX_ACCURACY_M = 100;

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function setLocationDot(active) {
  const dot = document.getElementById('locationDot');
  if (dot) dot.hidden = !active;
}

function handlePosition(position) {
  const lat = position.coords.latitude, lng = position.coords.longitude, accuracy = position.coords.accuracy;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  if (lat === 0 && lng === 0) return; // GPS hatasinda sik gorulen gecersiz konum
  if (Number.isFinite(accuracy) && accuracy > LOCATION_MAX_ACCURACY_M) return; // cok belirsiz, gonderme

  const now = Date.now();
  const movedM = lastSentLat !== null ? distanceMeters(lastSentLat, lastSentLng, lat, lng) : Infinity;
  const minGap = movedM < LOCATION_MOVE_THRESHOLD_M ? LOCATION_STATIONARY_INTERVAL_MS : LOCATION_MOVING_INTERVAL_MS;
  if (now - lastSentAt < minGap) return;
  lastSentAt = now; lastSentLat = lat; lastSentLng = lng;

  api('/api/courier/location', { method: 'POST', body: JSON.stringify({ lat, lng, accuracy }) })
    .then(() => setLocationDot(true))
    .catch(() => {});
}

/* Ekran kapanip GPS'in isletim sistemi tarafindan durdurulmasini geciktirmeye calisir
   (kullanici istegi: "telefon kilitlenince konum gonderimi duruyor"). Wake Lock
   DESTEKLENMEYEBILIR (eski tarayicilar) ya da REDDEDILEBILIR (pil tasarrufu modu) -
   ikisinde de sessizce gec, konum paylasimi (destekleniyorsa) yine calisir, sadece
   ekranin acik kalma garantisi olmaz. */
let wakeLock = null;
async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* desteklenmiyor/reddedildi */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && watchId !== null) acquireWakeLock();
});

function startLocationSharing() {
  if (!('geolocation' in navigator) || watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(
    handlePosition,
    () => { setLocationDot(false); /* izin reddedildi/hata - sessizce devam, konum paylasilmadan da uygulama calisir */ },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
  );
  acquireWakeLock();
}

/* Konum izni UX'i (16.09.2026, kullanici istegi: "sessizce tarayiciya birakmak yerine
   ACIK bir buton/uyari"). Permissions API HER tarayicida yok (ozellikle Safari) - orada
   dogrudan "izin ver" butonu gosterilir, tiklama GERCEK bir kullanici jesti oldugu icin
   tarayici izin istegini engellemez. */
async function setupLocationPermissionUi() {
  const host = document.getElementById('locationPermHost');
  if (!host || !('geolocation' in navigator)) return;
  let state = 'prompt';
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      state = status.state;
      status.onchange = () => { if (status.state === 'granted') { host.innerHTML = ''; startLocationSharing(); } };
    }
  } catch { /* Permissions API bu tarayicida yok - asagida dogrudan buton gosterilir */ }
  if (state === 'granted') { startLocationSharing(); return; }
  if (state === 'denied') {
    host.innerHTML = '<div class="location-banner warn">⚠️ Konum izni reddedilmiş. Siparişleri yine alabilirsiniz ama restoran sizi haritada göremez - tarayıcı ayarlarından bu site için konum iznini açın.</div>';
    return;
  }
  host.innerHTML = '<div class="location-banner"><span>📍 Siparişlerin restoran ekranında görünmesi için konum izni verin.</span><button id="grantLocationBtn">Konum İzni Ver</button></div>';
  document.getElementById('grantLocationBtn').onclick = () => {
    navigator.geolocation.getCurrentPosition(
      () => { host.innerHTML = ''; startLocationSharing(); },
      () => { host.innerHTML = '<div class="location-banner warn">⚠️ Konum izni verilmedi. Siparişleri yine alabilirsiniz ama restoran sizi haritada göremez.</div>'; },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };
}

async function claimPackage(id) {
  try {
    await api(`/api/courier/orders/${id}/claim`, { method: 'POST' });
    // Kendi aldigimiz paket icin "atandi" alarmi CALMASIN (istek: kendi ustune
    // alan kurye icin ses gerekmez) - once mine listesine "biliniyor" olarak
    // ekleniyor, sonraki refresh'te diff onu yeni saymiyor.
    knownMineIds.add(Number(id));
    switchTab('mine');
    refresh();
  } catch (error) {
    alert(error.message);
  }
}

async function openContent(id) {
  const sheet = document.getElementById('contentSheet');
  const rows = document.getElementById('contentRows');
  rows.innerHTML = '<div class="muted">Yükleniyor…</div>';
  sheet.hidden = false;
  try {
    const data = await api(`/api/courier/orders/${id}/content`);
    rows.innerHTML = data.items.map(item => `<div class="content-row"><span><span class="qty">${item.quantity}×</span>${item.name}</span><span>${money(item.price * item.quantity)}</span></div>`).join('') || '<div class="muted">İçerik bulunamadı.</div>';
  } catch (error) {
    rows.innerHTML = `<div class="err">${error.message}</div>`;
  }
}

function isCashType(name) { return /nakit|cash/i.test(name || ''); }

async function openPaySheet(id, remaining) {
  deliverTicketId = id;
  deliverOrderRemaining = Number(remaining) || 0;
  selectedPayTypeId = null;
  selectedPayTypeName = '';
  document.getElementById('payErr').hidden = true;
  document.getElementById('confirmDeliverBtn').disabled = true;
  document.getElementById('tenderRow').hidden = true;
  const grid = document.getElementById('payGrid');
  grid.innerHTML = '<div class="muted">Yükleniyor…</div>';
  document.getElementById('paySheet').hidden = false;
  try {
    if (!payTypesCache) payTypesCache = (await api('/api/payment-types')).types;
    grid.innerHTML = '';
    payTypesCache.forEach(pt => {
      const btn = document.createElement('button');
      btn.className = 'pay-opt';
      btn.textContent = pt.name;
      btn.dataset.payId = pt.id;
      btn.dataset.payName = pt.name;
      btn.onclick = () => selectPayType(pt.id, pt.name);
      grid.appendChild(btn);
    });
  } catch (error) {
    grid.innerHTML = `<div class="err">${error.message}</div>`;
  }
}

function selectPayType(id, name) {
  selectedPayTypeId = id;
  selectedPayTypeName = name;
  document.querySelectorAll('.pay-opt').forEach(btn => btn.classList.toggle('selected', Number(btn.dataset.payId) === Number(id)));
  document.getElementById('confirmDeliverBtn').disabled = false;
  // Sadece NAKİT türünde "verilen tutar" (para üstü hesabı için) anlamlı - kart/online'da
  // her zaman tam tutar geçer, fazladan bir şey sormaya gerek yok.
  const tenderRow = document.getElementById('tenderRow');
  if (isCashType(name)) {
    tenderRow.hidden = false;
    document.getElementById('tenderInput').value = deliverOrderRemaining.toFixed(2);
    updateChangePreview();
  } else {
    tenderRow.hidden = true;
  }
}

/* "Müşteri ₺500 verdi, sipariş ₺437 ise para üstü ₺63 otomatik hesaplanmalı" -
   teslim etmeden ÖNCE canlı önizleme (sunucu zaten aynı hesabı tekrar, kesin
   şekilde yapıp kaydediyor - bkz. sambapos.js markDelivered). */
function updateChangePreview() {
  const tendered = Number(document.getElementById('tenderInput').value);
  const preview = document.getElementById('changePreview');
  if (!Number.isFinite(tendered) || tendered <= 0) { preview.textContent = ''; return; }
  const change = tendered - deliverOrderRemaining;
  preview.textContent = change > 0 ? `Para üstü: ${money(change)}` : (change < 0 ? `Eksik: ${money(-change)}` : 'Tam tutar');
}

async function confirmDeliver(noPayment) {
  const errBox = document.getElementById('payErr');
  errBox.hidden = true;
  try {
    const body = noPayment ? { noPayment: true } : { paymentTypeId: selectedPayTypeId };
    if (!noPayment && !document.getElementById('tenderRow').hidden) {
      const tendered = Number(document.getElementById('tenderInput').value);
      if (Number.isFinite(tendered) && tendered > 0) body.tenderedAmount = tendered;
    }
    const result = await api(`/api/courier/orders/${deliverTicketId}/delivered`, { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('paySheet').hidden = true;
    if (result.changeAmount > 0) alert(`Para üstü: ${money(result.changeAmount)}`);
    refresh();
  } catch (error) {
    errBox.textContent = error.message;
    errBox.hidden = false;
  }
}

/* --- Ayarlar: tema + alarm (ses/tekrar/tür) + arka plan bildirimleri --- */
function refreshSettingsUI() {
  const theme = window.gksTheme ? gksTheme.get() : 'system';
  document.querySelectorAll('#themeSeg [data-theme-opt]').forEach(b => b.classList.toggle('active', b.dataset.themeOpt === theme));
  const s = window.GksAlarm ? GksAlarm.settings.get() : { volume: 0.9, repeat: 'until-dismissed', type: 'sound-vibrate', pendingAlarmEnabled: true };
  document.getElementById('volumeRange').value = Math.round(s.volume * 100);
  document.querySelectorAll('#repeatSeg [data-repeat-opt]').forEach(b => b.classList.toggle('active', b.dataset.repeatOpt === s.repeat));
  document.querySelectorAll('#typeSeg [data-type-opt]').forEach(b => b.classList.toggle('active', b.dataset.typeOpt === s.type));
  const pendingOn = serverNotifyEnabled !== null ? serverNotifyEnabled : (s.pendingAlarmEnabled !== false);
  document.querySelectorAll('#pendingAlarmSeg [data-pending-opt]').forEach(b => b.classList.toggle('active', (b.dataset.pendingOpt === 'on') === pendingOn));
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function subscribePush() {
  const statusEl = document.getElementById('pushStatus');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { statusEl.textContent = 'Bu tarayıcı arka plan bildirimini desteklemiyor.'; return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { statusEl.textContent = 'Bildirim izni verilmedi.'; return; }
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('/api/push/vapid-public-key');
    if (!key) { statusEl.textContent = 'Sunucuda push henüz aktif değil.'; return; }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
    statusEl.textContent = 'Arka plan bildirimleri etkin.';
    maybeShowBatteryHint();
  } catch (error) {
    statusEl.textContent = `Etkinleştirilemedi: ${error.message}`;
  }
}

/* Android'de pil optimizasyonu bu tur uygulamalari arka planda "uyutup" bildirimleri
   geciktirebiliyor/kaybedebiliyor (kullanici istegi, 15.09.2026: "bunu baska turlu
   calistiramadik" - Web Push'un kendisi FCM uzerinden gitse de, OS'un kendi pil
   yonetimi devreye giriyor). Google/Chrome hesabi GEREKTIRMEYEN, HER ZAMAN
   uygulanabilir tek gercek onlem - kullaniciya YONLENDIRME. Bir kere gosterilir
   (localStorage), her girişte tekrar sormaz. */
function maybeShowBatteryHint() {
  const isAndroid = /Android/i.test(navigator.userAgent || '');
  if (!isAndroid) return;
  let seen = false;
  try { seen = localStorage.getItem('gks-battery-hint-seen') === '1'; } catch {}
  if (seen) return;
  document.getElementById('batteryHint').hidden = false;
}
document.getElementById('dismissBatteryHint').onclick = () => {
  document.getElementById('batteryHint').hidden = true;
  try { localStorage.setItem('gks-battery-hint-seen', '1'); } catch {}
};

/* iPhone (16.09.2026, kullanici istegi): Web Push SADECE ana ekrana eklenmis PWA'da
   calisir - Apple'in kendi kisitlamasi, Safari SEKMESINDEN hicbir sekilde calismaz
   (kod tarafinda duzeltilebilecek bir sey degil). Bu yuzden Safari'de (ana ekrana
   HENUZ eklenmemis halde) acildiginda ekranin ustunde nazik bir yonlendirme
   gosterilir - bir kere kapatilinca localStorage'a yazilir, bir daha cikmaz. */
function isIosSafariNotStandalone() {
  const ua = navigator.userAgent || '';
  const isIos = /iphone|ipad|ipod/i.test(ua) && !window.MSStream;
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  return isIos && !standalone;
}
function maybeShowIosHint() {
  if (!isIosSafariNotStandalone()) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem('gks-ios-hint-dismissed') === '1'; } catch {}
  if (dismissed) return;
  const el = document.createElement('div');
  el.className = 'ios-hint';
  el.innerHTML = `<span>📲 iPhone'da arka planda bildirim alabilmek için bu ekranı ana ekrana ekleyin: Safari'de <b>Paylaş</b> → <b>Ana Ekrana Ekle</b>.</span><button id="dismissIosHint">Tamam</button>`;
  document.body.prepend(el);
  document.getElementById('dismissIosHint').onclick = () => {
    el.remove();
    try { localStorage.setItem('gks-ios-hint-dismissed', '1'); } catch {}
  };
}
maybeShowIosHint();

/* Gercek uctan uca test - yerel/sahte bir bildirim DEGIL, sunucuya istek atip
   ORADAN gercek bir push gonderttirir (push.js -> web-push -> Google/Mozilla push
   servisi -> telefon). Boylece "acaba gercekten calisiyor mu" sorusu bir siparis
   kacmadan ONCE, tek tikla yanitlanir. */
async function sendTestPush() {
  const statusEl = document.getElementById('testPushStatus');
  statusEl.textContent = 'Gönderiliyor…';
  try {
    const result = await api('/api/push/test', { method: 'POST' });
    statusEl.textContent = `Gönderildi (${result.subscriptionCount} cihaza) - birkaç saniye içinde bildirim gelmeli. Gelmezse yukarıdaki pil uyarısına bakın.`;
  } catch (error) {
    statusEl.textContent = `Hata: ${error.message}`;
  }
}

/* Abonelik sessizce gecersiz kalabilir (tarayici verisi temizlenmis, izin geri
   alinmis, cok uzun sure kullanilmamis vb.) - kurye bunu fark etmeden gunlerce
   "aktif" sanabilir. Normal 8sn'lik pollinge hafif bir yuk binmesin diye cok
   daha seyrek (10 dakikada bir) kontrol edilir; abonelik yoksa VE izin zaten
   verilmisse sessizce yeniden kurulur. */
async function checkPushHealth() {
  try {
    if (!('serviceWorker' in navigator) || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) { await subscribePush(); return; }
    // Sunucu tarafinda da hala kayitli mi (orn. 410/404 sonrasi sunucu silmis olabilir) - varsa dokunma, yoksa yeniden gonder.
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) }).catch(() => {});
  } catch { /* sessizce gec - kritik olmayan bir bakim islemi */ }
}
/* Giriste, izin ZATEN verilmisse sessizce yeniden abone ol (sayfa yenilenmis/tekrar
   acilmis olabilir) - izin hic sorulmamissa/reddedilmisse burada DOKUNULMAZ, cunku bu
   akis bir kullanici jesti (tiklama) DEGIL - tarayici izin istegini engeller/yoksayar. */
async function setupPushIfPermitted() {
  try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') await subscribePush(); } catch {}
}

/* "uygulama arka plan izinlerini alsın, konum paylaşımı falan herşeyi alsın" (kullanıcı
   isteği, 15.09.2026) - GERÇEK giriş tıklaması bir kullanıcı jestidir, bu yüzden SADECE
   burada (login() içinde) izin isteği DOĞRUDAN, "zaten verilmiş mi" kontrolü olmadan
   tetiklenir - konum zaten startPolling()->startLocationSharing() ile ayrıca istenir.
   DÜRÜST SINIR: web'de "arka planda sınırsız çalışma" diye bir izin YOK (mobil
   işletim sistemleri native uygulamaları bile pil optimizasyonuyla kısıtlar) - burada
   istenebilecek en fazlası: bildirim izni (push) + kalıcı depolama (tarayıcı, site
   verisini/önbelleği agresif şekilde silmesin diye). */
async function requestAllPermissions() {
  await subscribePush().catch(() => {});
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
}

document.getElementById('loginBtn').onclick = login;
document.getElementById('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
document.getElementById('logoutBtn').onclick = logout;
document.getElementById('tabUnassigned').onclick = () => switchTab('unassigned');
document.getElementById('tabMine').onclick = () => switchTab('mine');
document.getElementById('tabDeliveries').onclick = () => switchTab('deliveries');
document.getElementById('tabEod').onclick = () => switchTab('eod');
document.getElementById('closeContentSheet').onclick = () => { document.getElementById('contentSheet').hidden = true; };
document.getElementById('closePaySheet').onclick = () => { document.getElementById('paySheet').hidden = true; };
document.getElementById('noPaymentBtn').onclick = () => { if (confirm('Ödeme alınmadan teslim edilsin mi? Adisyon açık kalacak.')) confirmDeliver(true); };
document.getElementById('confirmDeliverBtn').onclick = () => confirmDeliver(false);

document.getElementById('themeBtn').onclick = () => { document.getElementById('settingsSheet').hidden = false; refreshSettingsUI(); };
document.getElementById('settingsBtn').onclick = () => { document.getElementById('settingsSheet').hidden = false; refreshSettingsUI(); };
document.getElementById('closeSettingsSheet').onclick = () => { document.getElementById('settingsSheet').hidden = true; };
document.querySelectorAll('#themeSeg [data-theme-opt]').forEach(b => b.onclick = () => { gksTheme.set(b.dataset.themeOpt); refreshSettingsUI(); });
document.getElementById('volumeRange').oninput = e => GksAlarm.settings.set({ volume: Number(e.target.value) / 100 });
document.querySelectorAll('#repeatSeg [data-repeat-opt]').forEach(b => b.onclick = () => { GksAlarm.settings.set({ repeat: b.dataset.repeatOpt }); refreshSettingsUI(); });
document.querySelectorAll('#typeSeg [data-type-opt]').forEach(b => b.onclick = () => { GksAlarm.settings.set({ type: b.dataset.typeOpt }); refreshSettingsUI(); });
document.querySelectorAll('#pendingAlarmSeg [data-pending-opt]').forEach(b => b.onclick = async () => {
  const enabled = b.dataset.pendingOpt === 'on';
  GksAlarm.settings.set({ pendingAlarmEnabled: enabled });
  serverNotifyEnabled = enabled;
  refreshSettingsUI();
  try { await api('/api/courier/settings', { method: 'POST', body: JSON.stringify({ notifyEnabled: enabled }) }); } catch {}
});
document.getElementById('testAlarmBtn').onclick = () => GksAlarm.play('bekleyen');
document.getElementById('enablePushBtn').onclick = subscribePush;
document.getElementById('testPushBtn').onclick = sendTestPush;
document.getElementById('tenderInput').addEventListener('input', updateChangePreview);
document.getElementById('faOkBtn').onclick = () => { hideFullscreenAlert(true); switchTab('unassigned'); };
document.getElementById('faSnoozeBtn').onclick = snoozeAlarm;
/* Hazır ayarlar: kullanıcının önerdiği Normal/Yüksek/Çok Yüksek/Tekrarlı Alarm
   kısayolları - altta zaten var olan ses seviyesi + tekrar ayarlarını tek dokunuşla
   ayarlar, ince ayar isteyen yine kaydırıcı/segmentleri elle değiştirebilir. */
const ALARM_PRESETS = {
  normal: { volume: 0.55, repeat: 'x3', type: 'sound-vibrate' },
  high: { volume: 0.8, repeat: 'x3', type: 'sound-vibrate' },
  max: { volume: 1, repeat: 'x3', type: 'sound-vibrate' },
  repeat: { volume: 1, repeat: 'until-dismissed', type: 'sound-vibrate' }
};
document.querySelectorAll('#presetSeg [data-preset-opt]').forEach(b => b.onclick = () => { GksAlarm.settings.set(ALARM_PRESETS[b.dataset.presetOpt]); refreshSettingsUI(); });

document.body.addEventListener('click', e => {
  const claimId = e.target.dataset && e.target.dataset.claim;
  const deliverId = e.target.dataset && e.target.dataset.deliver;
  const contentId = e.target.dataset && e.target.dataset.content;
  if (claimId) claimPackage(claimId);
  if (deliverId) openPaySheet(deliverId, e.target.dataset.remaining);
  if (contentId) openContent(contentId);
});

// Zaten oturum aciksa (cerez varsa) direkt ana ekrana gec.
api('/api/me').then(me => {
  if (me.role !== 'courier') return;
  document.getElementById('courierName').textContent = me.courierName || '';
  document.getElementById('loginView').hidden = true;
  document.getElementById('mainView').hidden = false;
  startPolling();
  setupPushIfPermitted();
}).catch(() => {});
