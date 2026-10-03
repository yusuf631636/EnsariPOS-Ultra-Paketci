; Ultra Paketci - Inno Setup 6 ile kurulum programi uretir.
; Gelismis Kurye Sistemi'nin genisletilmis/premium surumu - mevcut "Gelismis Kurye
; Sistemi" kurulumundan TAMAMEN AYRI bir uygulamadir - ayni bilgisayara kurulursa
; bile FARKLI klasor, FARKLI Windows servisi, FARKLI port (4099) kullanir; var olan
; sisteme HICBIR sekilde dokunmaz, yaninda calisir. Ayni gkActivationKey mekanizmasini
; kullanir (musteri tarafinda ayri bir urun/lisans alani GEREKMEZ - Gelismis Kurye
; icin zaten aktif olan musteriler bu anahtarla Ultra Paketci'yi de kurabilir).
#define AppName "Ultra Gelişmiş Kurye"
#define AppVersion "1.0.0"
#define AppPublisher "AlfaPOS"
#define AppExeName "UltraPaketci"

[Setup]
AppId={{B7E1F2A3-9C4D-4E5F-A6B7-ULTRAPAKET01}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\AlfaPOS\UltraPaketci
OutputDir=dist
OutputBaseFilename=UltraPaketciSetup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
SetupIconFile=assets\alfapos.ico
UninstallDisplayIcon={app}\assets\alfapos.ico

[Files]
Source: "server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "sql.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "sambapos.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "auth.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "db.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "ws.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "push.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "license.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "tunnel.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "updater.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "package-lock.json"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "nssm.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-requirements.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-services.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "remove-services.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "config.example.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "node_modules\*"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autodesktop}\Ultra Gelişmiş Kurye - Kurye Ekranı"; Filename: "http://127.0.0.1:{code:GetPort}/courier"; IconFilename: "{app}\assets\alfapos.ico"
Name: "{autodesktop}\Ultra Gelişmiş Kurye - Restoran Ekranı"; Filename: "http://127.0.0.1:{code:GetPort}/restoran"; IconFilename: "{app}\assets\alfapos.ico"
Name: "{group}\Kurye Ekranı"; Filename: "http://127.0.0.1:{code:GetPort}/courier"; IconFilename: "{app}\assets\alfapos.ico"
Name: "{group}\Restoran Ekranı"; Filename: "http://127.0.0.1:{code:GetPort}/restoran"; IconFilename: "{app}\assets\alfapos.ico"
Name: "{group}\Servisi Yeniden Kur"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install-services.ps1"""; IconFilename: "{app}\assets\alfapos.ico"
Name: "{group}\Servisi Durdur"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\remove-services.ps1"""; IconFilename: "{app}\assets\alfapos.ico"

[Run]
Filename: "netsh.exe"; Parameters: "advfirewall firewall add rule name=""Ultra Gelişmiş Kurye"" dir=in action=allow protocol=TCP localport={code:GetPort}"; Flags: runhidden; StatusMsg: "Güvenlik duvarı kuralı ekleniyor (telefonlardan erişim için)..."
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install-requirements.ps1"""; StatusMsg: "Gereksinimler kuruluyor (Node.js, sqlcmd)..."; Flags: waituntilterminated runhidden
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install-services.ps1"""; StatusMsg: "Servis kuruluyor ve başlatılıyor..."; Flags: waituntilterminated
Filename: "http://127.0.0.1:{code:GetPort}/restoran"; Description: "Restoran ekranını aç"; Flags: postinstall shellexec skipifsilent nowait

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\remove-services.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveServices"
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Ultra Gelişmiş Kurye"""; Flags: runhidden; RunOnceId: "DelFwRule"

[Code]
var
  DBPage: TInputQueryWizardPage;
  KeyPage: TInputQueryWizardPage;
  OldBindHostLine: String;

function GetPort(Param: String): String;
begin
  Result := '4099';
end;

function GetActivationKey(): String;
begin
  Result := Trim(KeyPage.Values[0]);
  if Result = '' then
    Result := Trim(ExpandConstant('{param:ACTIVATIONKEY|}'));
end;

function ExtractJsonValue(const Json, Key: String): String;
var
  SearchStr, S: String;
  P, Q: Integer;
begin
  Result := '';
  SearchStr := '"' + Key + '"';
  P := Pos(SearchStr, Json);
  if P = 0 then Exit;
  S := Copy(Json, P + Length(SearchStr), Length(Json) - (P + Length(SearchStr)) + 1);
  P := Pos(':', S);
  if P = 0 then Exit;
  S := Copy(S, P + 1, Length(S) - P);
  while (Length(S) > 0) and ((S[1] = ' ') or (S[1] = #9) or (S[1] = #13) or (S[1] = #10)) do
    S := Copy(S, 2, Length(S) - 1);
  if (Length(S) = 0) or (S[1] <> '"') then Exit;
  S := Copy(S, 2, Length(S) - 1);
  Q := Pos('"', S);
  if Q = 0 then Exit;
  Result := Copy(S, 1, Q - 1);
end;

function JsonEscape(S: String): String;
begin
  StringChangeEx(S, '\', '\\', True);
  StringChangeEx(S, '"', '\"', True);
  Result := S;
end;

procedure InitializeWizard;
begin
  { --- Sayfa 1: SQL baglanti bilgileri (ust aciklama YOK - alanlar yukarida kalsin) --- }
  DBPage := CreateInputQueryPage(wpSelectDir,
    'SQL Server Bağlantısı', '', '');
  DBPage.Add('SQL Server adresi (ör: DESKTOP-ADI veya localhost):', False);
  DBPage.Add('Veritabanı adı:', False);
  DBPage.Add('SQL kullanıcı adı (boş = Windows kimlik doğrulama):', False);
  DBPage.Add('SQL şifresi:', True);

  DBPage.Values[0] := 'localhost';
  DBPage.Values[1] := 'SAMBAPOS5';

  { --- Sayfa 2: Ultra Gelismis Kurye aktivasyon anahtari (ust aciklama YOK) --- }
  KeyPage := CreateInputQueryPage(DBPage.ID,
    'Ultra Gelişmiş Kurye Aktivasyonu', '', '');
  KeyPage.Add('Ultra Gelişmiş Kurye aktivasyon anahtarı:', False);
  KeyPage.Values[0] := '';
end;

procedure CurPageChanged(CurPageID: Integer);
var
  ConfigPath, OldBindHost: String;
  OldJson: AnsiString;
begin
  if CurPageID = DBPage.ID then
  begin
    OldBindHostLine := '';

    ConfigPath := ExpandConstant('{app}\config.json');
    if FileExists(ConfigPath) and LoadStringFromFile(ConfigPath, OldJson) then
    begin
      if ExtractJsonValue(OldJson, 'server') <> '' then DBPage.Values[0] := ExtractJsonValue(OldJson, 'server');
      if ExtractJsonValue(OldJson, 'database') <> '' then DBPage.Values[1] := ExtractJsonValue(OldJson, 'database');
      DBPage.Values[2] := ExtractJsonValue(OldJson, 'user');
      DBPage.Values[3] := ExtractJsonValue(OldJson, 'password');
      KeyPage.Values[0] := ExtractJsonValue(OldJson, 'gkActivationKey');
      OldBindHost := ExtractJsonValue(OldJson, 'bindHost');
      if OldBindHost <> '' then
        OldBindHostLine := '  "bindHost": "' + JsonEscape(OldBindHost) + '",' + #13#10;
    end;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = DBPage.ID then
  begin
    if Trim(DBPage.Values[0]) = '' then
    begin
      MsgBox('SQL sunucu adresi boş bırakılamaz.', mbError, MB_OK);
      Result := False;
    end
    else if Trim(DBPage.Values[1]) = '' then
    begin
      MsgBox('Veritabanı adı boş bırakılamaz.', mbError, MB_OK);
      Result := False;
    end;
  end
  else if CurPageID = KeyPage.ID then
  begin
    if GetActivationKey() = '' then
    begin
      MsgBox('Ultra Gelişmiş Kurye aktivasyon anahtarı boş bırakılamaz.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigPath: String;
  JsonContent: String;
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
  begin
    Exec('net.exe', 'stop UltraPaketci', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -Command "' +
      'try { ' +
      '$conns = Get-NetTCPConnection -LocalPort 4099 -ErrorAction SilentlyContinue; ' +
      'foreach ($c in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) { ' +
      'if ($c -and $c -ne 0) { Stop-Process -Id $c -Force -ErrorAction SilentlyContinue } ' +
      '} ; Start-Sleep -Seconds 1 ' +
      '} catch {}"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
  if CurStep = ssPostInstall then
  begin
    ConfigPath := ExpandConstant('{app}\config.json');
    JsonContent :=
      '{' + #13#10 +
      '  "server": "' + JsonEscape(DBPage.Values[0]) + '",' + #13#10 +
      '  "database": "' + JsonEscape(DBPage.Values[1]) + '",' + #13#10 +
      '  "user": "' + JsonEscape(DBPage.Values[2]) + '",' + #13#10 +
      '  "password": "' + JsonEscape(DBPage.Values[3]) + '",' + #13#10 +
      '  "options": {' + #13#10 +
      '    "encrypt": false,' + #13#10 +
      '    "trustServerCertificate": true' + #13#10 +
      '  },' + #13#10 +
      '  "port": 4099,' + #13#10 +
      OldBindHostLine +
      '  "gkActivationKey": "' + JsonEscape(GetActivationKey()) + '",' + #13#10 +
      '  "cloudServerUrl": "https://app.ornek-alanadi.com"' + #13#10 +
      '}';
    SaveStringToFile(ConfigPath, JsonContent, False);
  end;
end;