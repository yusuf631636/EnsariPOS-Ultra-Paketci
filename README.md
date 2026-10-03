# EnsariPOS Ultra Paketçi — SambaPOS / AlfaPOS Paket Servis

SambaPOS / AlfaPOS paket servis ve kurye yönetimi (delivery management) — Ultra Paketçi. Node.js + C#.

> 🇬🇧 Delivery & courier management for SambaPOS / AlfaPOS (Node.js + C#).

> EnsariPOS ürünlerinden biridir · Tüm ürünler: https://github.com/yusuf631636/EnsariPOS

## Özellikler

- Paket servis siparişlerini yönetme
- Kurye atama ve takibi
- SambaPOS adisyon entegrasyonu
- Bulut üzerinden dışarıdan erişim

## Gereksinimler

- **Windows 10/11** veya Windows Server — SambaPOS'un kurulu olduğu bilgisayar ya da aynı ağdaki bir bilgisayar.
- **SambaPOS V5** veya **AlfaPOS** (SambaPOS tabanlı), SQL Server (Express) veritabanıyla.
- **SambaPOS Mesaj Sunucusu** açık ve erişilebilir (varsayılan port `9000`; Windows Güvenlik Duvarı'nda izinli).
- SambaPOS'ta **`EnsariGarson`** GraphQL istemci kaydı (ürünün kurulum paketi / hazırlık aracı otomatik ekler).
- SambaPOS'ta **Yönetici (Admin)** rolünde bir bağlantı kullanıcısı; kullanıcının **Şifre** alanı dolu olmalı (PIN değil).
- **C# sürümü** için: .NET Framework 4.7.2 veya üstü (Windows 10/11'de hazır gelir). Visual Studio gerekmez; derleme `csc.exe` ile yapılır.
- **Node.js sürümü** için: Node.js 18 LTS veya üstü. Node.js sürümleri SambaPOS'un SQL Server veritabanına da doğrudan bağlanır; SQL Server adresi/kullanıcısı `config.json`'a yazılır.
- **Kurulum paketi (setup.exe)** üretmek için: Inno Setup 6.

## Kurulum paketi

Hazır kurulum exe'si için önce ürünü derleyin, sonra depodaki `*.iss` betiğini **Inno Setup 6** ile derleyin.

## Kaynak koddan çalıştırma

```
git clone https://github.com/yusuf631636/EnsariPOS-Ultra-Paketci.git
cd EnsariPOS-Ultra-Paketci
```

**Node.js** (`nodejs`):

```
cd nodejs
npm install
copy config.example.json config.json     # kendi bilgilerinizi girin; bu dosya depoya EKLENMEZ
node server.js
```

**C# / .NET Framework 4.x** (`csharp\Ultra-Paketci-CSharp`) — Visual Studio gerekmez, Windows'un kendi derleyicisi (`csc.exe`) kullanılır:

```
cd csharp\Ultra-Paketci-CSharp
powershell -ExecutionPolicy Bypass -File derle.ps1      # UltraPaketciSrv.exe üretir (..\ortak\*.cs dahil)
UltraPaketciSrv.exe /console                                 # servis olarak değil, konsolda çalıştırır
```

**Kurulum paketi**: `*.iss` dosyaları Inno Setup betikleridir.

## Klasörler
| Klasör | İçerik |
|---|---|
| `nodejs` | Node.js sürümü |
| `csharp/Ultra-Paketci-CSharp` | C# sürümü |
| `csharp/ortak` | C# ürünlerinin paylaştığı kütüphane |

## Sık karşılaşılan sorunlar

**"Authorization is required … getUser"** — Bağlantı kullanıcısı SambaPOS'ta Yönetici rolünde değil. Kullanıcıyı Yönetici rolüne alın.

**"invalid_client" / "uygulama kaydı yok"** — SambaPOS'ta `EnsariGarson` istemci kaydı eksik. Ürünün hazırlık aracını SambaPOS bilgisayarında bir kez çalıştırın.

**"Bağlantı kullanıcısı adı/şifresi hatalı"** — SambaPOS kullanıcısının **Şifre** alanını yazın, PIN'i değil.

**"SambaPOS mesaj sunucusuna ulaşılamadı"** — SambaPOS ve Mesaj Sunucusu açık mı, port `9000` güvenlik duvarında açık mı, adres doğru mu kontrol edin.

**"Terminal kaydı alınamadı"** — Ayarlardaki departman / adisyon tipi / terminal adı SambaPOS'takiyle birebir aynı olmalı.

## Güvenlik

`config.json`, veritabanları, loglar, imza anahtarları ve müşteri verileri depoya eklenmez (`.gitignore`); örnek ayarlar `config.example.json` dosyalarındadır. Güvenlik açığı bildirimi: [SECURITY.md](SECURITY.md).

## Katkı

Katkılar Pull Request ile gelir ve proje sahibi onaylayınca birleştirilir — bkz. [CONTRIBUTING.md](CONTRIBUTING.md).

## Lisans

MIT — bkz. [LICENSE](LICENSE).
