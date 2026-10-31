package com.jetmedia.agent;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.AlertDialog;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.app.PendingIntent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.UserManager;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Киоск: блокирует планшет (если агент — владелец устройства) и показывает веб-страницу.
 * Конфиг приходит от provision.ps1: am start ... --es config <base64 JSON>.
 * Сервисное меню: 7 быстрых касаний в левом верхнем углу → PIN.
 */
public class MainActivity extends Activity {
    private static final String[] RESTRICTIONS = {
            UserManager.DISALLOW_FACTORY_RESET, UserManager.DISALLOW_SAFE_BOOT, UserManager.DISALLOW_ADD_USER };
    private static final String[] HIDDEN_APPS = {
            "com.android.vending", "com.google.android.youtube", "com.android.chrome" };

    private static final String DEFAULT_SERVER = "https://api.jetmedia.dev";
    private static final String DEFAULT_APK =
            "https://github.com/ph001player1-lab/JetMediaRestaurant/releases/download/agent-latest/jet-agent.apk";
    private static final long POLL_MS = 15000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Runnable retryLoad = this::load;
    private long offlineSince, lastPreferCheck;
    private boolean showingOffline, resumed;
    private TextToSpeech tts;
    private DevicePolicyManager dpm;
    private ComponentName admin;
    private SharedPreferences prefs;
    private WebView web;
    private int taps;
    private long lastTap;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Любая ошибка в коде — не окно «Приложение остановлено», а тихий перезапуск через 2 секунды
        Thread.setDefaultUncaughtExceptionHandler((thread, e) -> {
            Watchdog.note(this, "приложение упало: " + String.valueOf(e).replace('\n', ' ') + " — перезапущено");
            Watchdog.restartSoon(this);
            android.os.Process.killProcess(android.os.Process.myPid());
            System.exit(10);
        });
        dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
        admin = new ComponentName(this, AdminReceiver.class);
        prefs = getSharedPreferences("jet", MODE_PRIVATE);
        readConfig(getIntent());
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() {
            // Страница не загрузилась (нет сети при включении) — показываем заглушку и пробуем снова через 10 секунд
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                showingOffline = true;
                view.loadDataWithBaseURL(null, offlinePage(), "text/html", "utf-8", null);
                handler.removeCallbacks(retryLoad);
                handler.postDelayed(retryLoad, 10000);
            }

            // Движок страницы упал или его выгрузили из-за памяти — перезапускаем приложение целиком
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                Watchdog.note(MainActivity.this, detail.didCrash() ? "страница (WebView) упала — перезапущено"
                        : "системе не хватило памяти для страницы — перезапущено");
                Watchdog.restartSoon(MainActivity.this);
                android.os.Process.killProcess(android.os.Process.myPid());
                return true;
            }
        });

        // Голос ИИ-персонажа: страница вызывает JetAgent.speak(...), по окончании фразы — jetSpeechDone()
        tts = new TextToSpeech(this, status -> { });
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { }
            @Override public void onDone(String id) { speechDone(); }
            @Override public void onError(String id) { speechDone(); }
        });
        web.addJavascriptInterface(new SpeechBridge(), "JetAgent");

        View corner = new View(this);
        corner.setOnClickListener(v -> onCornerTap());
        FrameLayout root = new FrameLayout(this);
        root.addView(web);
        root.addView(corner, new FrameLayout.LayoutParams(120, 120, Gravity.TOP | Gravity.START));
        setContentView(root);

        if (isOwner()) applyPolicies();
        collectEvents();
        Watchdog.schedule(this, 60_000);
        load();
        schedulePoll();
        // Сеть появилась, а на экране заглушка «Нет связи» — сразу загружаем страницу, не ждём повтора
        ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).registerDefaultNetworkCallback(
                new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                        handler.postDelayed(() -> { if (showingOffline) load(); }, 2000);
                    }
                });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (readConfig(intent)) load();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        Watchdog.beat(this);
        Watchdog.pause(this, 0);
        hideBars();
        if (isOwner()) startLockTask();
    }

    @Override
    protected void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideBars();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        super.onDestroy();
    }

    private void speechDone() {
        runOnUiThread(() -> web.evaluateJavascript("window.jetSpeechDone && jetSpeechDone()", null));
    }

    private class SpeechBridge {
        @JavascriptInterface
        public void speak(String text, String lang, double pitch, double rate) {
            tts.setLanguage(Locale.forLanguageTag(lang));
            tts.setPitch((float) pitch);
            tts.setSpeechRate((float) rate);
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "jet");
        }

        @JavascriptInterface
        public void stop() {
            tts.stop();
        }
    }

    private boolean isOwner() {
        return dpm.isDeviceOwnerApp(getPackageName());
    }

    private boolean readConfig(Intent intent) {
        String b64 = intent == null ? null : intent.getStringExtra("config");
        if (b64 == null) return false;
        try {
            JSONObject c = new JSONObject(new String(Base64.decode(b64, Base64.DEFAULT), StandardCharsets.UTF_8));
            SharedPreferences.Editor e = prefs.edit();
            for (Iterator<String> it = c.keys(); it.hasNext(); ) {
                String key = it.next();
                e.putString(key, c.optString(key));
            }
            e.apply();
            return true;
        } catch (Exception ex) {
            return false;
        }
    }

    private void load() {
        showingOffline = false;
        handler.removeCallbacks(retryLoad);
        String url = prefs.getString("url", "");
        if (url.isEmpty()) web.loadDataWithBaseURL(null, statusPage(), "text/html", "utf-8", null);
        else web.loadUrl(url);
    }

    private String statusPage() {
        return "<html><body style='margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;"
                + "justify-content:center;background:#111;color:#eee;font-family:sans-serif'>"
                + "<h1>JET MEDIA</h1><p>Агент " + BuildConfig.VERSION_NAME + "</p>"
                + "<p>Владелец устройства: " + (isOwner() ? "да" : "НЕТ") + "</p>"
                + "<p>Сервер: " + server() + "</p><p>ID: " + deviceId() + "</p></body></html>";
    }

    private String offlinePage() {
        return "<html><body style='margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;"
                + "justify-content:center;text-align:center;background:#1f1a17;color:#fff;font-family:sans-serif;font-size:22px;line-height:1.6'>"
                + "<h1>📶</h1><p>Нет связи — восстанавливаем подключение<br>No connection — reconnecting<br>"
                + "ไม่มีการเชื่อมต่อ — กำลังเชื่อมต่อใหม่<br>网络中断——正在重新连接</p>"
                + "<p style='opacity:.7'>Пожалуйста, позовите официанта жестом · Please wave to the waiter</p></body></html>";
    }

    private String server() { return server(prefs); }

    private String deviceId() { return deviceId(this, prefs); }

    static String server(SharedPreferences prefs) {
        String s = prefs.getString("server", "");
        return s.isEmpty() ? DEFAULT_SERVER : s;
    }

    // Серийный номер передаёт provision.ps1; если его нет — ANDROID_ID
    static String deviceId(Context c, SharedPreferences prefs) {
        String id = prefs.getString("serial", "");
        return id.isEmpty() ? Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ANDROID_ID) : id;
    }

    // Что случилось до этого запуска: записи сторожа и причины завершения из Android 11+.
    // Уходят на сервер со следующим опросом, сервер пишет администратору в Telegram.
    private void collectEvents() {
        try {
            JSONArray events = new JSONArray(prefs.getString("events", "[]"));
            File note = new File(getFilesDir(), "note");
            if (note.exists()) {
                for (String line : new String(Files.readAllBytes(note.toPath()), StandardCharsets.UTF_8).split("\n")) {
                    if (!line.isEmpty()) events.put(line);
                }
                note.delete();
            }
            if (Build.VERSION.SDK_INT >= 30) {
                long seen = prefs.getLong("exitSeen", 0);
                for (ApplicationExitInfo x : getSystemService(ActivityManager.class).getHistoricalProcessExitReasons(null, 0, 5)) {
                    String why = exitReason(x.getReason());
                    if (why == null || x.getTimestamp() <= seen || !getPackageName().equals(x.getProcessName())) continue;
                    events.put(why + (x.getDescription() != null ? ": " + x.getDescription() : ""));
                }
                prefs.edit().putLong("exitSeen", System.currentTimeMillis()).apply();
            }
            prefs.edit().putString("events", events.toString()).apply();
        } catch (Exception ignored) { }
    }

    private static String exitReason(int reason) {
        switch (reason) {
            case ApplicationExitInfo.REASON_ANR: return "приложение зависло (ANR)";
            case ApplicationExitInfo.REASON_CRASH: return "приложение упало";
            case ApplicationExitInfo.REASON_CRASH_NATIVE: return "приложение упало (native)";
            case ApplicationExitInfo.REASON_LOW_MEMORY: return "системе не хватило памяти — приложение выгружено";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE: return "ошибка запуска приложения";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: return "приложение перегрузило планшет";
            default: return null;
        }
    }

    // Раз в 15 секунд: отправить телеметрию, получить и выполнить команды
    private void schedulePoll() {
        if (resumed) Watchdog.beat(this); // отметка для сторожа: киоск на экране и главный поток жив
        io.execute(this::pollServer);
        handler.postDelayed(this::schedulePoll, POLL_MS);
    }

    private void pollServer() {
        checkWifi();
        try {
            JSONObject t = new JSONObject();
            WifiInfo wifiInfo = wifi().getConnectionInfo();
            if (wifiInfo != null && wifiInfo.getNetworkId() != -1) {
                t.put("wifi", wifiInfo.getSSID().replace("\"", "")).put("rssi", wifiInfo.getRssi());
            }
            Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery != null) {
                int scale = Math.max(1, battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100));
                t.put("battery", battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) * 100 / scale);
                t.put("charging", battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0);
            }
            t.put("version", BuildConfig.VERSION_NAME).put("model", Build.MODEL)
                    .put("android", Build.VERSION.RELEASE).put("owner", isOwner())
                    .put("url", prefs.getString("url", ""));
            String events = prefs.getString("events", "[]");
            JSONObject body = new JSONObject().put("id", deviceId()).put("key", prefs.getString("enroll", ""))
                    .put("telemetry", t).put("events", new JSONArray(events));

            HttpURLConnection c = (HttpURLConnection) new URL(server() + "/api/device/poll").openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.getOutputStream().write(body.toString().getBytes(StandardCharsets.UTF_8));
            JSONArray commands = new JSONObject(read(c.getInputStream())).optJSONArray("commands");
            if (events.equals(prefs.getString("events", "[]"))) prefs.edit().remove("events").apply();
            for (int i = 0; commands != null && i < commands.length(); i++) {
                JSONObject cmd = commands.getJSONObject(i);
                runOnUiThread(() -> execute(cmd));
            }
        } catch (Exception ignored) {
            // нет сети или сервера — попробуем в следующий раз
        }
    }

    private WifiManager wifi() {
        return (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
    }

    // Интернета нет дольше минуты — подключаемся к сохранённой сети, а если её не видно — к самой сильной открытой.
    // Владельцу устройства Android разрешает управлять Wi-Fi напрямую.
    private void checkWifi() {
        try {
            preferSavedWifi();
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            NetworkCapabilities caps = cm.getNetworkCapabilities(cm.getActiveNetwork());
            if (caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                offlineSince = 0;
                return;
            }
            long now = System.currentTimeMillis();
            if (offlineSince == 0) offlineSince = now;
            if (now - offlineSince < 60000 || !isOwner()) return;
            offlineSince = now; // следующая попытка — через минуту

            WifiManager wifi = wifi();
            if (!wifi.isWifiEnabled()) {
                wifi.setWifiEnabled(true);
                return;
            }
            wifi.startScan();
            String current = wifi.getConnectionInfo().getSSID();
            List<WifiConfiguration> saved = wifi.getConfiguredNetworks();
            ScanResult bestSaved = null, bestOpen = null;
            int savedId = -1;
            for (ScanResult s : wifi.getScanResults()) {
                if (s.SSID == null || s.SSID.isEmpty()) continue;
                String quoted = "\"" + s.SSID + "\"";
                if (quoted.equals(current)) continue; // текущая сеть без интернета — ищем другую
                for (WifiConfiguration c : saved) {
                    if (quoted.equals(c.SSID) && (bestSaved == null || s.level > bestSaved.level)) {
                        bestSaved = s;
                        savedId = c.networkId;
                    }
                }
                boolean open = !s.capabilities.matches(".*(WEP|PSK|EAP|SAE|OWE).*");
                if (open && (bestOpen == null || s.level > bestOpen.level)) bestOpen = s;
            }
            if (bestSaved != null) {
                wifi.enableNetwork(savedId, true);
            } else if (bestOpen != null) {
                WifiConfiguration c = new WifiConfiguration();
                c.SSID = "\"" + bestOpen.SSID + "\"";
                c.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
                int id = wifi.addNetwork(c);
                if (id != -1) wifi.enableNetwork(id, true);
            }
            wifi.reconnect();
        } catch (Exception ignored) {
            // нет прав или Wi-Fi выключен политикой — попробуем позже
        }
    }

    // Сидим на открытой сети, а рядом снова видна сохранённая сеть с паролем — раз в минуту проверяем
    // и возвращаемся на неё; открытые запасные сети удаляем, чтобы Android сам не перескакивал на них обратно.
    private void preferSavedWifi() {
        long now = System.currentTimeMillis();
        if (now - lastPreferCheck < 60000 || !isOwner()) return;
        lastPreferCheck = now;
        WifiManager wifi = wifi();
        WifiInfo info = wifi.getConnectionInfo();
        if (info == null || info.getNetworkId() == -1) return;
        List<WifiConfiguration> saved = wifi.getConfiguredNetworks();
        WifiConfiguration current = null;
        for (WifiConfiguration c : saved) if (c.networkId == info.getNetworkId()) current = c;
        if (current == null || !isOpen(current)) return; // уже на сети с паролем
        wifi.startScan();
        ScanResult best = null;
        int bestId = -1;
        for (ScanResult s : wifi.getScanResults()) {
            if (s.level < -85) continue; // слишком слабый сигнал — не меняем шило на мыло
            for (WifiConfiguration c : saved) {
                if (!isOpen(c) && ("\"" + s.SSID + "\"").equals(c.SSID) && (best == null || s.level > best.level)) {
                    best = s;
                    bestId = c.networkId;
                }
            }
        }
        if (best == null) return;
        for (WifiConfiguration c : saved) if (isOpen(c)) wifi.removeNetwork(c.networkId);
        wifi.enableNetwork(bestId, true);
        wifi.reconnect();
    }

    private static boolean isOpen(WifiConfiguration c) {
        boolean noKeyMgmt = c.allowedKeyManagement.isEmpty() || c.allowedKeyManagement.get(WifiConfiguration.KeyMgmt.NONE);
        return noKeyMgmt && (c.wepKeys == null || c.wepKeys[0] == null);
    }

    private void execute(JSONObject cmd) {
        switch (cmd.optString("type")) {
            case "url":
                prefs.edit().putString("url", cmd.optString("url")).apply();
                load();
                break;
            case "reload":
                load();
                break;
            case "reboot":
                if (isOwner()) dpm.reboot(admin);
                break;
            case "update":
                io.execute(() -> installUpdate(cmd.optString("url", DEFAULT_APK)));
                break;
        }
    }

    // Тихая установка новой версии агента: владельцу устройства подтверждение не нужно
    private void installUpdate(String apkUrl) {
        try {
            PackageInstaller installer = getPackageManager().getPackageInstaller();
            int id = installer.createSession(
                    new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL));
            PackageInstaller.Session session = installer.openSession(id);
            try (InputStream in = new URL(apkUrl).openStream();
                 OutputStream out = session.openWrite("agent.apk", 0, -1)) {
                byte[] buf = new byte[65536];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                session.fsync(out);
            }
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            Intent done = new Intent(this, UpdateReceiver.class);
            session.commit(PendingIntent.getBroadcast(this, id, done, flags).getIntentSender());
            session.close();
        } catch (Exception ignored) { }
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    private void applyPolicies() {
        dpm.setLockTaskPackages(admin, new String[] { getPackageName() });
        IntentFilter home = new IntentFilter(Intent.ACTION_MAIN);
        home.addCategory(Intent.CATEGORY_HOME);
        home.addCategory(Intent.CATEGORY_DEFAULT);
        dpm.addPersistentPreferredActivity(admin, home, new ComponentName(this, MainActivity.class));
        dpm.setStatusBarDisabled(admin, true);
        dpm.setKeyguardDisabled(admin, true);
        dpm.setPermissionPolicy(admin, DevicePolicyManager.PERMISSION_POLICY_AUTO_GRANT);
        dpm.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "7");
        for (String r : RESTRICTIONS) dpm.addUserRestriction(admin, r);
        setAppsHidden(true);
        // Для выбора Wi-Fi нужны список сетей и имя текущей — это требует доступа к геолокации
        dpm.setPermissionGrantState(admin, getPackageName(), Manifest.permission.ACCESS_FINE_LOCATION,
                DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
        if (Build.VERSION.SDK_INT >= 30) dpm.setLocationEnabled(admin, true);
    }

    // Chrome не прячем, если он и есть движок WebView на этой прошивке
    private void setAppsHidden(boolean hidden) {
        PackageInfo webview = WebView.getCurrentWebViewPackage();
        for (String app : HIDDEN_APPS) {
            if (webview != null && app.equals(webview.packageName)) continue;
            try { dpm.setApplicationHidden(admin, app, hidden); } catch (Exception ignored) { }
        }
    }

    private void hideBars() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    private void onCornerTap() {
        long now = SystemClock.uptimeMillis();
        taps = now - lastTap < 1000 ? taps + 1 : 1;
        lastTap = now;
        if (taps >= 7) {
            taps = 0;
            askPin();
        }
    }

    private void askPin() {
        EditText pin = new EditText(this);
        pin.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        new AlertDialog.Builder(this).setTitle("Сервис: PIN").setView(pin)
                .setPositiveButton("OK", (d, w) -> {
                    if (pin.getText().toString().equals(prefs.getString("pin", "1234"))) serviceMenu();
                })
                .show();
    }

    private void serviceMenu() {
        String[] items = { "Открыть настройки", "Перезагрузить страницу", "Снять владельца устройства" };
        new AlertDialog.Builder(this).setTitle("JET MEDIA — сервис").setItems(items, (d, which) -> {
            if (which == 0) {
                Watchdog.pause(this, 15); // сторож не вернёт киоск, пока техник в настройках
                stopLockTask();
                startActivity(new Intent(Settings.ACTION_SETTINGS));
            } else if (which == 1) {
                load();
            } else {
                removeOwner();
            }
        }).show();
    }

    // Возвращает планшет в обычный режим без сброса к заводским
    private void removeOwner() {
        stopLockTask();
        dpm.clearPackagePersistentPreferredActivities(admin, getPackageName());
        dpm.setStatusBarDisabled(admin, false);
        dpm.setKeyguardDisabled(admin, false);
        for (String r : RESTRICTIONS) dpm.clearUserRestriction(admin, r);
        setAppsHidden(false);
        dpm.clearDeviceOwnerApp(getPackageName());
        finish();
    }
}
