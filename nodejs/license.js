/* Bulut lisans dogrulamasi - Ultra Paketci'nin KENDI aktivasyon anahtariyla
   (config.json'daki alan adi hala "gkActivationKey" - Gelismis Kurye Sistemi'nden
   koklendigi icin, ama DEGERI artik farkli: admin panelde ayrica uretilen
   ultra_activation_key), C:\toplu (AlfaPOS Bulut) admin panelinden acilip
   acilmadigini kontrol eder. product=ultra_paketci ile sorgulanir - Gelismis
   Kurye Sistemi'nin (product=gelismis_kurye) LISANSINDAN VE TUNELINDEN (bkz.
   tunnel.js, /ultra-tunnel) TAMAMEN BAGIMSIZ, ayni restoranda ikisi asla
   birbirinin yerini almaz (15.09.2026, canli bir tunel-cakismasi sonrasi ayrildi).
   Baslangicta VE her 30 dakikada bir sorar.

   Gecici ag kesintisinde musteri DISARIDA BIRAKILMAZ: bulut sunucusuna hic
   erisilemezse en son BASARILI (ok:true) sonuc bellekte kalir. Ama bulut sunucusu
   ERISILEBILIR ve acikca "lisans yok/suresi gecti" diyorsa bu HER ZAMAN gecerlidir
   (eski basarili sonucu asla ezmez/gormezden gelmez) - admin lisansi kapattiginda
   bir sonraki kontrolde gercekten kapanmali. */
const https = require('https');
const { config } = require('./sql');

const CLOUD_URL = (config.cloudServerUrl || 'https://app.ornek-alanadi.com').replace(/\/+$/, '');
const GK_KEY = String(config.gkActivationKey || config.activationKey || '').trim();
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

let lastResult = { ok: false, error: 'Lisans henüz doğrulanmadı.' };
let hasEverSucceeded = false;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Lisans sunucusundan geçersiz yanıt.')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Lisans sunucusuna erişilemedi (zaman aşımı).')); });
  });
}
function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Lisans sunucusundan geçersiz yanıt.')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Lisans sunucusuna erişilemedi (zaman aşımı).')); });
    req.end(body);
  });
}

/* Admin panelde "Bağlı/Bağlı değil" gorunsun diye - Kurye Bulut ajaninin 6 saniyelik
   senkron nabzinin cok daha seyrek/basit bir esdegeri. Basarisiz olursa sessizce
   yoksayilir (hata firlatmaz) - bu ozellik OLMASA da uygulama calismaya devam eder. */
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
function sendHeartbeatOnce() {
  if (!GK_KEY) return;
  try {
    const url = new URL(`${CLOUD_URL}/api/agent/heartbeat`);
    const payload = JSON.stringify({ activationKey: GK_KEY, product: 'ultra_paketci' });
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 10000
    }, res => { res.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(payload);
  } catch { /* URL parse gibi beklenmeyen bir hata - sessizce gec */ }
}

async function checkOnce() {
  /* SADECE C:\kuryetest (izole yerel test kopyasi) icin: gkActivationKey BILEREK
     bos birakildi ki bu kopya GERCEK musteri/uretim bulutuna asla erisemesin
     ("mevcuda karisma once local testler yapalim" - kullanici istegi, 15.09.2026).
     Bu yuzden bos anahtar burada "lisanssiz/kapali" degil, "bulut bagimliligi
     olmadan YEREL test modu" anlamina gelir - GERCEK urunde (gelismis-kurye-sistemi,
     musteriye giden kurulum) bu davranis YOK, orada bos anahtar hala lisanssiz sayilir. */
  if (!GK_KEY) {
    lastResult = { ok: true };
    hasEverSucceeded = true;
    return lastResult;
  }
  const url = `${CLOUD_URL}/api/agent/license-check?key=${encodeURIComponent(GK_KEY)}&product=ultra_paketci`;
  try {
    const parsed = await fetchJson(url);
    lastResult = parsed.ok ? { ok: true } : { ok: false, error: parsed.error || 'Lisans doğrulanamadı.' };
    if (parsed.ok) hasEverSucceeded = true;
  } catch (error) {
    if (!hasEverSucceeded) lastResult = { ok: false, error: 'Lisans sunucusuna erişilemedi. İnternet bağlantınızı kontrol edin.' };
    // else: onceki basarili sonuc korunur - gecici kesinti musteriyi disarida birakmaz.
  }
  return lastResult;
}

function isLicensed() { return lastResult.ok; }
function licenseError() { return lastResult.error; }
function gkActivationKey() { return GK_KEY; }

/* Restoran/admin girisinin 1. ADIMI: e-posta/telefon + bulut panel SIFRESI (musterinin
   diger panellerde de kullandigi gercek sifre, customers.password_hash'e karsi
   dogrulanir - eskiden sadece "eslesiyor mu" bakiliyordu, sifre HIC kontrol
   edilmiyordu). Basarili olursa 2. adimda SambaPOS PIN'i istenir (bkz. server.js). */
async function verifyPassword(identifier, password) {
  /* C:\kuryetest YEREL TEST MODU (bkz. checkOnce yukarida - GERCEK urunde YOK):
     bulut bagimliligi olmadan admin ekranini da test edebilmek icin 1. adim
     (bulut sifresi) burada atlanir, dogrudan basarili sayilir - GERCEK yetkilendirme
     zaten 2. adimda (SambaPOS admin PIN'i, dogrudan SQL'den) yapiliyor. */
  if (!GK_KEY) return { ok: true };
  try {
    return await postJson(`${CLOUD_URL}/api/agent/verify-password`, { key: GK_KEY, product: 'ultra_paketci', identifier, password });
  } catch (error) {
    return { ok: false, error: 'Lisans sunucusuna erişilemedi. İnternet bağlantınızı kontrol edin.' };
  }
}

checkOnce();
setInterval(checkOnce, CHECK_INTERVAL_MS);
sendHeartbeatOnce();
setInterval(sendHeartbeatOnce, HEARTBEAT_INTERVAL_MS);

module.exports = { isLicensed, licenseError, checkOnce, verifyPassword, gkActivationKey, CLOUD_URL };
