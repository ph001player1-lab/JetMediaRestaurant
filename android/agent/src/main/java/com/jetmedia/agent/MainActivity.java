package com.jetmedia.agent;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.AlertDialog;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.app.admin.DevicePolicyManager;
import android.content.BroadcastReceiver;
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
import android.os.PowerManager;
import android.os.StatFs;
import android.os.SystemClock;
import android.os.UserManager;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
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
import java.security.MessageDigest;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.SSLException;

/**
 * Киоск: блокирует планшет (если агент — владелец устройства) и показывает веб-страницу.
 * Конфиг приходит от provision.ps1: am start ... --es config <base64 JSON>.
 * Сервисное меню: 7 быстрых касаний в самом левом верхнем углу (квадрат 36 dp) → PIN.
 */
public class MainActivity extends Activity {
    private static final String[] RESTRICTIONS = {
            UserManager.DISALLOW_FACTORY_RESET, UserManager.DISALLOW_SAFE_BOOT, UserManager.DISALLOW_ADD_USER };
    private static final String[] HIDDEN_APPS = {
            "com.android.vending", "com.google.android.youtube", "com.android.chrome" };

    private static final String DEFAULT_SERVER = "https://api.jetmedia.dev";
    private static final String DEFAULT_APK =
            "https://github.com/ph001player1-lab/JetMediaRestaurant/releases/download/agent-latest/jet-agent.apk";
    // опрос сервера — раз в 15 с; сервер не ответил — через 5 с (обрыв замечаем и чиним быстрее)
    private static final long POLL_MS = 15000, FAST_POLL_MS = 5000, TICK_MS = 5000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Runnable retryLoad = this::load;
    private long lastServerOk = System.currentTimeMillis();
    private boolean showingOffline, resumed, ttsReady;
    private volatile boolean polling, fastPoll;
    private volatile long lastPollEnd;
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
        keepWifiAwake();

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
        tts = new TextToSpeech(this, status -> ttsReady = status == TextToSpeech.SUCCESS);
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
        // Маленький квадрат в самом углу: рядом, у края экрана, — кнопка стола («О системе»), касания по ней не перехватываем
        int cornerPx = Math.round(36 * getResources().getDisplayMetrics().density);
        root.addView(corner, new FrameLayout.LayoutParams(cornerPx, cornerPx, Gravity.TOP | Gravity.START));
        setContentView(root);

        if (isOwner()) applyPolicies();
        listenShutdown();
        collectEvents();
        Watchdog.schedule(this, 60_000);
        load();
        schedulePoll();
        // агент перезапустился, стоя на точке, к которой привязался из-за обрывов, — привязку снимаем: Android выбирает сам
        if (isOwner()) io.execute(() -> { if (pinned()) unpin(false, "агент перезапустился — снимаю привязку к точке, Android выбирает сам"); });
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
        lockTask();
    }

    // Режим киоска. Если окно ещё не на переднем плане (включился экран, сверху системное окно),
    // Android бросает «Invalid task, not in foreground» — не падаем, а повторяем, когда окно получит фокус
    private void lockTask() {
        if (!isOwner()) return;
        if (getSystemService(ActivityManager.class).getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE) return;
        try {
            startLockTask();
        } catch (IllegalArgumentException | IllegalStateException e) {
            // повторим в onWindowFocusChanged
        }
    }

    @Override
    protected void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideBars();
            lockTask();
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        if (wifiLock != null) wifiLock.release();
        if (wifiLockFast != null) wifiLockFast.release();
        super.onDestroy();
    }

    // Планшет выключают кнопкой (или садится аккумулятор) — успеваем сказать серверу: это не обрыв связи,
    // тревоги в Telegram не будет, а по включениям и выключениям сервер узнаёт часы работы ресторана
    private void listenShutdown() {
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                int level = batteryLevel();
                Thread t = new Thread(() -> sayBye(level >= 0 && level <= 5 ? "battery" : "shutdown", level));
                t.start();
                try { t.join(3000); } catch (InterruptedException ignored) { }
            }
        };
        IntentFilter f = new IntentFilter(Intent.ACTION_SHUTDOWN);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(r, f, Context.RECEIVER_EXPORTED);
        else registerReceiver(r, f);

        // Экран погасили кнопкой — планшет засыпает: сразу говорим серверу «выключен» (без тревоги).
        // Экран включили — сразу на связь, не ждём очередного опроса; это не обрыв, а пробуждение
        BroadcastReceiver screen = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                if (Intent.ACTION_SCREEN_OFF.equals(i.getAction())) {
                    getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jet:bye").acquire(6000);
                    int level = batteryLevel();
                    new Thread(() -> sayBye("screen", level)).start();
                } else {
                    io.execute(() -> { lastServerOk = System.currentTimeMillis(); everOk = false; outageStart = 0; outageFails = 0; step = 0; });
                    for (long d : new long[] { 500, 4000, 9000 }) handler.postDelayed(() -> io.execute(MainActivity.this::pollServer), d);
                }
            }
        };
        IntentFilter sf = new IntentFilter(Intent.ACTION_SCREEN_OFF);
        sf.addAction(Intent.ACTION_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screen, sf, Context.RECEIVER_EXPORTED);
        else registerReceiver(screen, sf);
    }

    private boolean screenOn() {
        try { return getSystemService(PowerManager.class).isInteractive(); } catch (Exception e) { return true; }
    }

    private int batteryLevel() {
        Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (battery == null) return -1;
        return battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) * 100 / Math.max(1, battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100));
    }

    private void sayBye(String reason, int level) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(server() + "/api/device/bye").openConnection();
            c.setConnectTimeout(2500);
            c.setReadTimeout(2500);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.getOutputStream().write(new JSONObject().put("id", deviceId()).put("key", prefs.getString("enroll", ""))
                    .put("reason", reason).put("battery", level).toString().getBytes(StandardCharsets.UTF_8));
            c.getResponseCode();
        } catch (Exception ignored) {
            // не успели — сервер решит по часам работы, тревожить ли
        }
    }

    private void speechDone() {
        runOnUiThread(() -> web.evaluateJavascript("window.jetSpeechDone && jetSpeechDone()", null));
    }

    private class SpeechBridge {
        // Страница стола: гость трогает экран или в корзине есть блюда — обновление агента подождёт
        @JavascriptInterface
        public void activity(int cartItems) {
            lastGuestActivity = System.currentTimeMillis();
            guestCart = cartItems;
        }

        @JavascriptInterface
        public void speak(String text, String lang, double pitch, double rate) {
            say(text, lang, "", pitch, rate);
        }

        // Голос персонажа выбирается в портале по имени (например, мужской ru-ru-x-…); нет такого — голос языка по умолчанию
        @JavascriptInterface
        public void speakWith(String text, String lang, double pitch, double rate, String voice) {
            say(text, lang, voice, pitch, rate);
        }

        @JavascriptInterface
        public void stop() {
            tts.stop();
        }
    }

    private void say(String text, String lang, String voiceName, double pitch, double rate) {
        Voice voice = null;
        try {
            for (Voice v : tts.getVoices()) if (v.getName().equals(voiceName)) voice = v;
        } catch (Exception ignored) { }
        if (voice != null) tts.setVoice(voice);
        else tts.setLanguage(Locale.forLanguageTag(lang));
        tts.setPitch((float) pitch);
        tts.setSpeechRate((float) rate);
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "jet");
    }

    // Голоса синтеза для языков гостя — сервер показывает их в портале для выбора голоса персонажа
    private JSONArray voiceList() {
        JSONArray out = new JSONArray();
        if (!ttsReady) return out;
        try {
            for (Voice v : tts.getVoices()) {
                String l = v.getLocale().getLanguage();
                if (l.equals("en") || l.equals("ru") || l.equals("th") || l.equals("zh")) out.put(v.getName());
            }
        } catch (Exception ignored) { }
        return out;
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
                if (key.equals("wifi")) continue;
                e.putString(key, c.optString(key));
            }
            // сети «для всех планшетов» из админки, которые взял загрузчик: сохраним сразу, без связи с сервером
            JSONObject w = c.optJSONObject("wifi");
            if (w != null && w.optJSONArray("nets") != null && w.optJSONArray("nets").length() > 0) {
                e.putString("wifiCfg", w.toString()).putString("wifiV", "prov").putString("wifiIdxMap", "{}");
                restCfgNew = true;
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

    // Каждые 5 с — отметка для сторожа; опрос сервера (телеметрия, команды) — раз в 15 с, а когда сервер не ответил —
    // через 5 с. Опросы не наслаиваются: следующий — только после окончания предыдущего
    private void schedulePoll() {
        if (resumed) Watchdog.beat(this); // отметка для сторожа: киоск на экране и главный поток жив
        long now = SystemClock.elapsedRealtime();
        if (!polling && now - lastPollEnd >= (fastPoll ? FAST_POLL_MS : POLL_MS)) {
            polling = true;
            io.execute(() -> {
                try { pollServer(); } finally { lastPollEnd = SystemClock.elapsedRealtime(); polling = false; }
            });
        }
        handler.postDelayed(this::schedulePoll, TICK_MS);
    }

    private void pollServer() {
        boolean ok = false, reached = false;
        String err = "";
        final int to = fastPoll ? 6000 : 10000; // во время обрыва ждём ответа меньше — проверяем чаще
        try {
            JSONObject t = new JSONObject();
            WifiInfo wifiInfo = wifi().getConnectionInfo();
            if (wifiInfo != null && wifiInfo.getNetworkId() != -1) {
                t.put("wifi", wifiInfo.getSSID().replace("\"", "")).put("rssi", wifiInfo.getRssi())
                        .put("bssid", String.valueOf(wifiInfo.getBSSID())).put("freq", wifiInfo.getFrequency())
                        .put("link", wifiInfo.getLinkSpeed());
            }
            Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery != null) {
                int scale = Math.max(1, battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100));
                t.put("battery", battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) * 100 / scale);
                t.put("charging", battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0);
            }
            t.put("version", BuildConfig.VERSION_NAME).put("model", Build.MODEL)
                    .put("android", Build.VERSION.RELEASE).put("owner", isOwner())
                    .put("uptime", SystemClock.elapsedRealtime()).put("allowOpen", prefs.getBoolean("allowOpen", false))
                    .put("screen", screenOn()).put("freeMb", freeMb())
                    .put("wifiV", prefs.getString("wifiV", "")).put("authFail", authFail == null ? JSONObject.NULL : authFail).put("nets", netsTelemetry())
                    .put("backup", backupId != -1 && curId() == backupId
                            ? new JSONObject().put("ssid", curSsid()).put("since", backupSince) : JSONObject.NULL)
                    .put("url", prefs.getString("url", "")).put("voices", voiceList())
                    .put("pin", pinned() ? pinTelemetry() : JSONObject.NULL)
                    // какой PIN сервисного меню у планшета (первые 8 знаков отпечатка) — портал показывает, кто уже получил новый
                    .put("pin", prefs.getString("pinHash", "").length() >= 8 ? prefs.getString("pinHash", "").substring(0, 8) : "");
            String events = prefs.getString("events", "[]");
            // смена сети, которую сделал сам Android (не агент), — тоже в журнал
            String ssidNow = t.optString("wifi", "");
            String ssidWas = prefs.getString("lastSsid", "");
            if (!ssidNow.isEmpty() && !ssidNow.equals(ssidWas)) {
                if (!ssidWas.isEmpty()) netLog(ssidWas, ssidNow, "переключился сам Android");
                prefs.edit().putString("lastSsid", ssidNow).apply();
            }
            String netlog = prefs.getString("netlog", "[]");
            JSONObject body = new JSONObject().put("id", deviceId()).put("key", prefs.getString("enroll", ""))
                    .put("telemetry", t).put("events", new JSONArray(events)).put("netlog", new JSONArray(netlog));
            // обрыв, который сейчас заканчивается (2+ неудачных опроса подряд): причина, сеть, сигнал, что делали.
            // Сеть ещё не поднялась после включения планшета — это не обрыв
            if (outageStart != 0 && outageFails >= 2 && everOk) body.put("outage", outageJson());
            String scan = prefs.getString("scan", "");
            if (!scan.isEmpty()) body.put("scan", new JSONObject(scan));
            String upd = prefs.getString("upd", "");
            if (!upd.isEmpty()) body.put("update", new JSONObject(upd));

            HttpURLConnection c = (HttpURLConnection) new URL(server() + "/api/device/poll").openConnection();
            c.setConnectTimeout(to);
            c.setReadTimeout(to);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.getOutputStream().write(body.toString().getBytes(StandardCharsets.UTF_8));
            int code = c.getResponseCode();
            reached = true; // сервер ответил — сеть в порядке, даже если ответ — ошибка
            if (code != 200) throw new java.io.IOException("HTTP " + code);
            JSONObject resp = new JSONObject(read(c.getInputStream()));
            ok = true; // сервер ответил — связь есть, что бы ни думал Android
            if (netlog.equals(prefs.getString("netlog", "[]"))) prefs.edit().remove("netlog").apply();
            if (!scan.isEmpty() && scan.equals(prefs.getString("scan", ""))) prefs.edit().remove("scan").apply();
            if (!upd.isEmpty() && upd.equals(prefs.getString("upd", ""))) prefs.edit().remove("upd").apply();
            // сеть ресторана из админки (имя, пароль, новый пароль) — приходит, когда изменилась
            JSONObject wcfg = resp.optJSONObject("wifi");
            if (wcfg != null && !wcfg.optString("v").equals(prefs.getString("wifiV", ""))) {
                prefs.edit().putString("wifiCfg", wcfg.toString()).putString("wifiV", wcfg.optString("v")).putString("wifiIdxMap", "{}").apply();
                restCfgNew = true;
            }
            // разрешены ли чужие открытые сети как запасные (включается в админке, по умолчанию — нет)
            prefs.edit().putBoolean("allowOpen", resp.optBoolean("allowOpenWifi", false)).apply();
            JSONArray commands = resp.optJSONArray("commands");
            // PIN сервисного меню из админки: храним только отпечаток sha256(соль + PIN)
            JSONObject pin = resp.optJSONObject("pin");
            if (pin != null && pin.optString("hash").length() == 64 && !pin.optString("hash").equals(prefs.getString("pinHash", ""))) {
                prefs.edit().putString("pinSalt", pin.optString("salt")).putString("pinHash", pin.optString("hash")).apply();
            }
            if (events.equals(prefs.getString("events", "[]"))) prefs.edit().remove("events").apply();
            for (int i = 0; commands != null && i < commands.length(); i++) {
                JSONObject cmd = commands.getJSONObject(i);
                runOnUiThread(() -> execute(cmd));
            }
        } catch (Exception e) {
            err = reached ? "сервер ответил ошибкой (" + e.getMessage() + ")" : describe(e, to);
        }
        network(ok, reached, err);
    }

    private WifiManager wifi() {
        return (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
    }

    // ---------- Связь: восстановление по шагам
    // Связь пропала = наш сервер не отвечает (отметка Android «нет интернета» не в счёт). Тогда по шагам:
    //   2 неудачных опроса (~25 с) — переподключиться к той же сети; 1,5 мин — выключить и включить Wi-Fi (роутер заново выдаст адрес —
    //   помогает, когда адреса заняты гостями); 3 мин — другая сеть рядом: сохранённая, а чужая открытая — только если
    //   разрешено в админке. Запасную сеть сначала проверяем: наш сервер должен ответить за 40 с, иначе уходим и час
    //   её не пробуем (у сетей кафе и отелей бывает страница входа без интернета). Других сетей нет — повторяем
    //   переподключение и выкл/вкл Wi-Fi каждые 3 минуты.
    // На проверенной запасной сети стоим минимум 25 минут (без «пинг-понга»), потом пробуем основную: не ответила
    // за минуту — назад на запасную. Сеть, добавленную людьми, не удаляем никогда; каждое действие — в журнал.
    // шаг 1 — через 8 с после первого неудачного опроса (и второй неудачный), шаг 2 — минута без связи
    private static final long STEP1_MS = 8_000, STEP2_MS = 60_000, STEP3_MS = 180_000, STEP_GAP_MS = 30_000;
    private static final long TRIAL_MS = 40_000, MAIN_TRIAL_MS = 60_000, BACKUP_STAY_MS = 25 * 60_000, BAN_MS = 60 * 60_000;
    private WifiManager.WifiLock wifiLock, wifiLockFast;
    private int step, outageFails, trialId = -1, backupId = -1, mainTrialBack = -1, trialLevel;
    private boolean everOk; // сервер хоть раз ответил после запуска — до этого сеть просто поднимается после включения
    private boolean restCfgNew;
    private JSONObject authFail; // сеть из админки видна, но не пускает (похоже, сменили пароль)
    private String pickInfo = "";
    private long lastStepAt, outageStart, trialUntil, backupSince, mainTrialUntil;
    private boolean trialOurs;
    private String outageErr = "", outageLastErr = "", outageSteps = "", trialSsid = "";
    private JSONObject outageWifi, outageProbe;
    private long lastFailStat;
    private final Map<String, Long> banned = new HashMap<>();

    private static final class Candidate {
        int id, level;
        final String ssid;
        final boolean ours;
        Candidate(int id, String ssid, int level, boolean ours) { this.id = id; this.ssid = ssid; this.level = level; this.ours = ours; }
    }

    // Wi-Fi не засыпает, пока киоск на экране: энергосбережение Wi-Fi на дешёвых планшетах рвёт связь
    private void keepWifiAwake() {
        try {
            WifiManager wm = wifi();
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "jet:kiosk");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
            if (Build.VERSION.SDK_INT >= 29) {
                wifiLockFast = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "jet:kiosk-fast");
                wifiLockFast.setReferenceCounted(false);
                wifiLockFast.acquire();
            }
        } catch (Exception ignored) {
            // нет разрешения — работаем как раньше
        }
    }

    private static String describe(Exception e) { return describe(e, 0); }

    // Почему не дошли до сервера; соединение не установилось и «соединились, но ответа нет» — разные причины
    private static String describe(Exception e, int timeoutMs) {
        if (e instanceof UnknownHostException) return "не находится адрес сервера (DNS)";
        if (e instanceof SocketTimeoutException) {
            String in = timeoutMs > 0 ? " за " + timeoutMs / 1000 + " с" : "";
            return String.valueOf(e.getMessage()).toLowerCase(Locale.ROOT).contains("connect") ? "не соединился с сервером" + in : "сервер не ответил" + in;
        }
        if (e instanceof ConnectException || e instanceof NoRouteToHostException) return "нет пути до сервера";
        if (e instanceof SSLException) return "соединение подменено (страница входа сети?)";
        return e.getClass().getSimpleName();
    }

    private String curSsid() {
        try {
            WifiInfo i = wifi().getConnectionInfo();
            if (i == null || i.getNetworkId() == -1) return "";
            return i.getSSID().replace("\"", "");
        } catch (Exception e) {
            return "";
        }
    }

    private int curId() {
        try {
            WifiInfo i = wifi().getConnectionInfo();
            return i == null ? -1 : i.getNetworkId();
        } catch (Exception e) {
            return -1;
        }
    }

    // Состояние Wi-Fi в момент обрыва — по нему видно причину: нет сети, нет адреса, слабый сигнал, другая точка доступа
    private JSONObject wifiState() {
        JSONObject w = new JSONObject();
        try {
            WifiManager wm = wifi();
            w.put("on", wm.isWifiEnabled());
            WifiInfo i = wm.getConnectionInfo();
            boolean conn = i != null && i.getNetworkId() != -1;
            w.put("connected", conn);
            if (conn) {
                w.put("ssid", i.getSSID().replace("\"", "")).put("bssid", String.valueOf(i.getBSSID()))
                        .put("rssi", i.getRssi()).put("freq", i.getFrequency()).put("link", i.getLinkSpeed())
                        .put("ip", i.getIpAddress() != 0);
            }
            ConnectivityManager cm = getSystemService(ConnectivityManager.class);
            NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
            w.put("internet", nc != null && nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
        } catch (Exception ignored) { }
        return w;
    }

    private JSONObject outageJson() throws Exception {
        return new JSONObject().put("start", outageStart).put("dur", System.currentTimeMillis() - outageStart)
                .put("fails", outageFails).put("err", outageErr).put("lastErr", outageLastErr)
                .put("wifi", outageWifi == null ? new JSONObject() : outageWifi).put("steps", outageSteps)
                .put("probe", outageProbe == null ? JSONObject.NULL : outageProbe);
    }

    private boolean isOurs(int id) {
        return id != -1 && ("," + prefs.getString("addedOpen", "") + ",").contains("," + id + ",");
    }

    // Убрать запасные открытые сети, которые добавил сам агент (кроме той, на которой стоим)
    private void dropBackups() {
        String added = prefs.getString("addedOpen", "");
        if (added.isEmpty()) return;
        WifiManager wm = wifi();
        int cur = curId();
        String keep = "";
        for (String id : added.split(",")) {
            if (id.isEmpty()) continue;
            int n = Integer.parseInt(id);
            if (n == cur) keep += "," + n;
            else wm.removeNetwork(n);
        }
        prefs.edit().putString("addedOpen", keep).apply();
    }

    private void enableAll() {
        WifiManager wm = wifi();
        List<WifiConfiguration> saved = wm.getConfiguredNetworks();
        if (saved != null) for (WifiConfiguration w : saved) wm.enableNetwork(w.networkId, false);
    }

    private void network(boolean ok, boolean reached, String err) {
        try {
            long now = System.currentTimeMillis();
            WifiManager wm = wifi();
            if (isOwner() && !wm.isWifiEnabled()) {
                wm.setWifiEnabled(true);
                netLog("", "", "Wi-Fi был выключен — включил");
            }
            recordStat(ok, now);
            if (restCfgNew && isOwner() && screenOn() && trialId == -1 && mainTrialBack == -1) {
                restCfgNew = false;
                applyAdminCfg(now, ok);
            }
            if (!pendingRemove.isEmpty()) {
                String cs = curSsid();
                for (String ssid : new java.util.ArrayList<>(pendingRemove)) if (!ssid.equals(cs)) { forget(ssid); pendingRemove.remove(ssid); }
            }
            int cur = curId();
            if (ok) {
                boolean counted = everOk && outageFails >= 2 && outageWifi != null; // обрыв (не подъём сети после включения)
                lastServerOk = now;
                everOk = true;
                fastPoll = false;
                if (counted) {
                    recordOutage(outageWifi.optString("ssid"), outageStart); // — на счёт той сети
                    noteApOutage(outageWifi.optString("bssid"), now); // и той точки доступа
                }
                outageStart = 0;
                outageFails = 0;
                outageSteps = "";
                step = 0;
                if (trialId != -1) {
                    if (cur == trialId) {
                        netLog(curSsid(), curSsid(), "запасная сеть: сервер отвечает — остаюсь на ней");
                        if (trialOurs) { backupId = trialId; backupSince = now; }
                    }
                    trialId = -1;
                }
                if (mainTrialBack != -1) {
                    boolean on = curSsid().equals(switchTarget);
                    if (!on && now < mainTrialUntil) return; // Android ещё переключается — ждём до конца минуты
                    boolean wasBackup = isOurs(mainTrialBack);
                    mainTrialBack = -1;
                    if (on) {
                        if (wasBackup) { backupId = -1; dropBackups(); }
                        netLog(curSsid(), curSsid(), "«" + switchTarget + "»: сервер отвечает — остаюсь" + (wasBackup ? ", запасные убрал" : ""));
                    } else {
                        switchBan.put(switchTarget, now + 20 * 60_000);
                        netLog(curSsid(), curSsid(), "к «" + switchTarget + "» не подключился — Android вернул на «" + curSsid() + "», 20 мин её не пробую");
                    }
                } else if (backupId == -1 && isOurs(cur)) {
                    backupId = cur; // агент перезапустился, стоя на запасной сети
                    backupSince = now;
                } else if (backupId != -1 && cur != -1 && cur != backupId) {
                    backupId = -1; // Android сам перешёл на другую сеть, и она работает
                    dropBackups();
                } else if (backupId != -1 && cur == backupId && now - backupSince >= BACKUP_STAY_MS && isOwner()) {
                    Candidate main = pick(false, true);
                    if (main == null) {
                        backupSince = now; // основной сети рядом не видно — ещё 25 минут на запасной
                    } else {
                        switchTo(main.ssid, main.id, now, "25 мин на запасной сети — пробую вернуться на «" + main.ssid + "»");
                    }
                }
                checkPin(now);
                steer(now);
                return;
            }

            if (!screenOn()) { // планшет спит — сеть и не должна работать
                outageStart = 0;
                outageFails = 0;
                step = 0;
                lastServerOk = now;
                return;
            }
            if (outageStart == 0) {
                outageStart = now;
                outageErr = err;
                outageWifi = wifiState();
                outageProbe = reached ? null : probe(); // где рвётся: точка Wi-Fi, интернет ресторана или путь до сервера
            }
            fastPoll = true;
            outageFails++;
            outageLastErr = err;
            if (!isOwner()) return;
            if (trialId != -1) {
                String why = trialProblem(err);
                // страницу входа Android распознаёт сам — тогда не ждём 40 с
                if (now < trialUntil && !why.startsWith("страница входа")) return; // сеть подключается и получает адрес — ждём
                JSONObject an = adminNet(trialSsid);
                boolean noJoin = why.startsWith("не подключилась");
                // сеть из админки не пускает: есть «новый пароль» — пробуем его сразу
                if (an != null && noJoin && !an.optString("pass2").isEmpty() && idxOf(trialSsid) == 0) {
                    int id = writeNet(an, 1);
                    if (id != -1) {
                        wm.enableNetwork(id, true);
                        trialId = id;
                        trialUntil = now + TRIAL_MS;
                        netLog(trialSsid, trialSsid, "сеть «" + trialSsid + "» не пускает — пробую новый пароль из админки");
                        return;
                    }
                }
                if (an != null && noJoin && trialLevel >= -75) {
                    if (idxOf(trialSsid) == 1) writeNet(an, 0); // и новый не подошёл — возвращаем прежний
                    authBad.put(trialSsid, now);
                    try { authFail = new JSONObject().put("ssid", trialSsid).put("at", now).put("level", trialLevel); } catch (Exception ignored) { }
                    netLog(trialSsid, "", "сеть «" + trialSsid + "» видна (сигнал " + trialLevel + " dBm), но не пускает — похоже, сменили пароль");
                }
                banned.put(trialSsid, now + (an != null ? 10 * 60_000 : BAN_MS)); // свою сеть пробуем снова через 10 минут
                if (trialOurs) {
                    wm.removeNetwork(trialId);
                    String keep = ("," + prefs.getString("addedOpen", "") + ",").replace("," + trialId + ",", ",");
                    prefs.edit().putString("addedOpen", keep.replaceAll("^,+|,+$", "")).apply();
                }
                netLog(trialSsid, "", "запасная сеть (сигнал " + trialLevel + " dBm): " + why + " — ушёл, час её не пробую");
                trialId = -1;
                enableAll();
                wm.reconnect();
                lastStepAt = now;
                return;
            }
            if (mainTrialBack != -1) {
                if (now < mainTrialUntil) return;
                netLog(curSsid(), "", "«" + switchTarget + "» не дала связи за минуту — вернулся обратно, 20 мин её не пробую");
                switchBan.put(switchTarget, now + 20 * 60_000);
                wm.enableNetwork(mainTrialBack, true);
                if (isOurs(mainTrialBack)) { backupId = mainTrialBack; backupSince = now; }
                mainTrialBack = -1;
                lastStepAt = now;
                return;
            }
            if (reached) return; // сервер ответил ошибкой — Wi-Fi тут ни при чём
            long down = now - lastServerOk;
            if (step > 0 && now - lastStepAt < STEP_GAP_MS) return; // новый обрыв — первый шаг сразу, без паузы
            String did;
            // стоим на точке, к которой привязались из-за частых обрывов, — и тут нет связи: сначала снимаем привязку
            if (step == 0 && outageFails >= 2 && now - outageStart >= STEP1_MS) did = pinned()
                    ? unpin(true, "нет связи на точке …" + tail(prefs.getString("pinBssid", "")) + " — снимаю привязку, 2 ч её не пробую") : reconnect(down);
            else if (step == 1 && down >= STEP2_MS) did = toggle(down);
            else if (step >= 2 && down >= STEP3_MS * (step - 1)) {
                did = tryBackup(now);
                if (did == null && step == 2) netLog(curSsid(), curSsid(), "запасной сети нет: " + pickInfo);
                if (did == null) did = step % 2 == 0 ? reconnect(down) : toggle(down);
            } else return;
            step++;
            lastStepAt = System.currentTimeMillis();
            outageSteps += (outageSteps.isEmpty() ? "" : "; ") + did + " на " + fmtDown(down);
        } catch (Exception ignored) {
            // нет прав или Wi-Fi выключен политикой — попробуем на следующем опросе
        }
    }

    private static String fmtDown(long ms) {
        long s = ms / 1000;
        return s < 60 ? s + " с" : (s / 60) + " мин" + (s % 60 >= 30 ? " 30 с" : "");
    }

    // Переподключиться к той же сети (просто reconnect() у подключённого Wi-Fi ничего не делает)
    private String reconnect(long down) {
        WifiManager wm = wifi();
        String ssid = curSsid();
        wm.disconnect();
        SystemClock.sleep(1000);
        wm.reconnect();
        netLog(ssid, ssid, "нет связи с сервером " + fmtDown(down) + " — переподключился к сети");
        return "переподключение";
    }

    // Выключить и включить Wi-Fi: заново подключиться и получить адрес у роутера
    private String toggle(long down) {
        WifiManager wm = wifi();
        String ssid = curSsid();
        boolean off = wm.setWifiEnabled(false);
        SystemClock.sleep(3000);
        boolean on = wm.setWifiEnabled(true);
        for (int i = 0; i < 3 && !wm.isWifiEnabled(); i++) {
            SystemClock.sleep(1000);
            on = wm.setWifiEnabled(true);
        }
        netLog(ssid, ssid, "нет связи с сервером " + fmtDown(down) + " — выключил и включил Wi-Fi" + (off && on ? "" : " (Android не дал)"));
        return "Wi-Fi выкл/вкл";
    }

    // ---------- Где рвётся связь: один раз в начале обрыва — отвечает ли роутер (шлюз сети) и есть ли интернет
    // (страница проверки Google). Роутер молчит — точка Wi-Fi не пропускает данные к планшету; роутер отвечает, интернета
    // нет — пропал интернет ресторана; всё есть — не отвечает только путь до нашего сервера
    private JSONObject probe() {
        JSONObject p = new JSONObject();
        long t0 = System.currentTimeMillis();
        try {
            int gw = wifi().getDhcpInfo().gateway;
            if (gw != 0) {
                String ip = (gw & 0xff) + "." + ((gw >> 8) & 0xff) + "." + ((gw >> 16) & 0xff) + "." + ((gw >>> 24) & 0xff);
                p.put("gw", reach(ip, 53, 2000) || reach(ip, 80, 1500));
            }
            p.put("net", internetCheck());
            p.put("ms", System.currentTimeMillis() - t0);
        } catch (Exception ignored) { }
        return p;
    }

    // Роутер на связи: соединение с ним установилось или он сам отказал (тоже ответ); молчание — не на связи
    private static boolean reach(String ip, int port, int ms) {
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress(ip, port), ms);
            return true;
        } catch (ConnectException e) {
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // Интернет есть: страница проверки Google ответила «204». Другой ответ — сеть подменяет страницы (страница входа)
    private static Object internetCheck() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://connectivitycheck.gstatic.com/generate_204").openConnection();
            c.setConnectTimeout(3000);
            c.setReadTimeout(3000);
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            return c.getResponseCode() == 204 ? (Object) Boolean.TRUE : "portal";
        } catch (Exception e) {
            return Boolean.FALSE;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ---------- Частые обрывы на одной точке доступа: другая точка или диапазон той же сети (2,4 / 5 ГГц).
    // 3 обрыва за 15 минут на точке — привязываемся к другой точке этой же сети (сначала — другой диапазон) на 30 минут.
    // Там спокойно (не больше одного обрыва) — остаёмся ещё на 2 часа, потом Android снова выбирает сам. Там тоже обрывы
    // или нет связи — привязку снимаем сразу, эту точку 2 часа не пробуем. Перезапуск агента — привязку снимаем
    private static final long AP_WINDOW_MS = 15 * 60_000, PIN_MS = 30 * 60_000, PIN_LONG_MS = 2 * 3_600_000L, AP_BAN_MS = 2 * 3_600_000L;
    private final Map<String, java.util.ArrayList<Long>> apOutages = new HashMap<>();
    private final Map<String, Long> apBan = new HashMap<>();

    private static String tail(String bssid) {
        return bssid == null || bssid.length() < 5 ? String.valueOf(bssid) : bssid.substring(bssid.length() - 5);
    }

    private static String band(int freq) {
        return freq <= 0 ? "?" : freq < 3000 ? "2.4 ГГц" : freq < 5925 ? "5 ГГц" : "6 ГГц";
    }

    private void noteApOutage(String bssid, long at) {
        if (bssid == null || bssid.isEmpty() || "null".equals(bssid)) return;
        String b = bssid.toLowerCase(Locale.ROOT);
        java.util.ArrayList<Long> l = apOutages.get(b);
        if (l == null) { l = new java.util.ArrayList<>(); apOutages.put(b, l); }
        l.add(at);
        while (!l.isEmpty() && l.get(0) < at - PIN_LONG_MS) l.remove(0);
    }

    private int apCount(String bssid, long since) {
        java.util.ArrayList<Long> l = apOutages.get(String.valueOf(bssid).toLowerCase(Locale.ROOT));
        int n = 0;
        if (l != null) for (long t : l) if (t >= since) n++;
        return n;
    }

    private boolean pinned() { return !prefs.getString("pinBssid", "").isEmpty(); }

    private WifiConfiguration configOf(int id) {
        List<WifiConfiguration> saved = wifi().getConfiguredNetworks();
        if (saved != null) for (WifiConfiguration w : saved) if (w.networkId == id) return w;
        return null;
    }

    private JSONObject pinTelemetry() {
        try {
            return new JSONObject().put("bssid", prefs.getString("pinBssid", "")).put("band", prefs.getString("pinBand", ""))
                    .put("from", prefs.getString("pinFrom", "")).put("fromBand", prefs.getString("pinFromBand", ""))
                    .put("since", prefs.getLong("pinSince", 0)).put("until", prefs.getLong("pinUntil", 0));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private void checkPin(long now) {
        try {
            if (!isOwner() || !screenOn()) return;
            WifiManager wm = wifi();
            WifiInfo i = wm.getConnectionInfo();
            if (i == null || i.getNetworkId() == -1) return;
            String ssid = curSsid(), bssid = String.valueOf(i.getBSSID()).toLowerCase(Locale.ROOT);
            String pin = prefs.getString("pinBssid", "");
            if (!pin.isEmpty()) {
                if (i.getNetworkId() != prefs.getInt("pinId", -1)) { unpin(false, "планшет перешёл на другую сеть — снимаю привязку к точке …" + tail(pin)); return; }
                if (now < prefs.getLong("pinUntil", 0)) return;
                int n = apCount(pin, prefs.getLong("pinSince", now));
                if (n <= 1 && !prefs.getBoolean("pinLong", false)) {
                    prefs.edit().putLong("pinUntil", now + PIN_LONG_MS).putBoolean("pinLong", true).apply();
                    netLog(ssid, ssid, "точка …" + tail(pin) + " (" + prefs.getString("pinBand", "") + "): за 30 мин обрывов " + n + " — устойчивее, остаюсь на ней ещё 2 ч");
                    return;
                }
                unpin(false, n <= 1 ? "2 ч на точке …" + tail(pin) + " без частых обрывов — снимаю привязку, Android выбирает сам"
                        : "на точке …" + tail(pin) + " тоже обрывы (" + n + ") — снимаю привязку");
                return;
            }
            int n = apCount(bssid, now - AP_WINDOW_MS);
            if (n < 3 || now - prefs.getLong("pinTriedAt", 0) < AP_WINDOW_MS) return;
            prefs.edit().putLong("pinTriedAt", now).apply();
            int freq = i.getFrequency();
            boolean five = freq >= 4000;
            ScanResult best = null;
            long nowUs = SystemClock.elapsedRealtime() * 1000;
            List<ScanResult> scan = wm.getScanResults();
            if (scan != null) for (ScanResult s : scan) {
                String b = String.valueOf(s.BSSID).toLowerCase(Locale.ROOT);
                if (!ssid.equals(s.SSID) || b.equals(bssid) || s.level < -72 || nowUs - s.timestamp > 10 * 60_000_000L) continue;
                Long ban = apBan.get(b);
                if (ban != null && ban > now) continue;
                boolean other = (s.frequency >= 4000) != five, bestOther = best != null && (best.frequency >= 4000) != five;
                if (best == null || (other && !bestOther) || (other == bestOther && s.level > best.level)) best = s;
            }
            wm.startScan(); // на следующий раз — свежий список сетей
            String here = "частые обрывы на точке …" + tail(bssid) + " (" + band(freq) + "): " + n + " за 15 мин";
            if (best == null) { netLog(ssid, ssid, here + "; другой точки или диапазона этой сети рядом нет (сигнал от -72 dBm)"); return; }
            WifiConfiguration conf = configOf(i.getNetworkId());
            if (conf == null) return;
            String to = String.valueOf(best.BSSID).toLowerCase(Locale.ROOT);
            conf.BSSID = to;
            if (wm.updateNetwork(conf) == -1) { netLog(ssid, ssid, here + "; привязаться к точке …" + tail(to) + " Android не дал"); return; }
            prefs.edit().putString("pinBssid", to).putString("pinBand", band(best.frequency)).putString("pinFrom", bssid).putString("pinFromBand", band(freq))
                    .putInt("pinId", i.getNetworkId()).putLong("pinSince", now).putLong("pinUntil", now + PIN_MS).putBoolean("pinLong", false).apply();
            wm.enableNetwork(i.getNetworkId(), true);
            wm.disconnect();
            SystemClock.sleep(500);
            wm.reconnect();
            netLog(ssid, ssid, here + " → точка …" + tail(to) + " (" + band(best.frequency) + ", сигнал " + best.level + " dBm) на 30 мин");
        } catch (Exception ignored) { }
    }

    // Снять привязку к точке: Android снова выбирает точку и диапазон сам. bad — точка не помогла: 2 часа её не пробуем
    private String unpin(boolean bad, String why) {
        WifiManager wm = wifi();
        String pin = prefs.getString("pinBssid", "");
        int id = prefs.getInt("pinId", -1);
        prefs.edit().remove("pinBssid").remove("pinBand").remove("pinFrom").remove("pinFromBand").remove("pinId")
                .remove("pinSince").remove("pinUntil").remove("pinLong").apply();
        if (bad && !pin.isEmpty()) apBan.put(pin, System.currentTimeMillis() + AP_BAN_MS);
        boolean done = false;
        String ssid = curSsid();
        try {
            WifiConfiguration conf = configOf(id);
            if (conf == null) done = true; // сети уже нет — и привязки нет
            else {
                String name = String.valueOf(conf.SSID).replace("\"", "");
                conf.BSSID = "any"; // «любая точка» — так Android снимает привязку
                done = wm.updateNetwork(conf) != -1;
                JSONObject an = done ? null : adminNet(name);
                if (an != null) { // не дал снять — сеть из админки сохраняем заново, уже без привязки
                    wm.removeNetwork(id);
                    id = writeNet(an, 0);
                    done = id != -1;
                }
                if (bad || an != null) { if (id != -1) wm.enableNetwork(id, true); wm.disconnect(); SystemClock.sleep(500); wm.reconnect(); }
            }
        } catch (Exception ignored) { }
        netLog(ssid, ssid, why + (done ? "" : " (Android не дал снять привязку)"));
        return "снял привязку к точке …" + tail(pin);
    }

    // Другая сеть рядом: сохранённая, или чужая открытая (если разрешено в админке). Подключаемся на проверку
    private String tryBackup(long now) {
        Candidate c = pick(prefs.getBoolean("allowOpen", false), false);
        if (c == null) return null;
        WifiManager wm = wifi();
        String from = curSsid();
        boolean open = c.id == -1;
        if (open) {
            WifiConfiguration conf = new WifiConfiguration();
            conf.SSID = "\"" + c.ssid + "\"";
            conf.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
            c.id = wm.addNetwork(conf);
            if (c.id == -1) return null;
            String added = prefs.getString("addedOpen", "");
            prefs.edit().putString("addedOpen", (added.isEmpty() ? "" : added + ",") + c.id).apply();
        }
        wm.enableNetwork(c.id, true);
        trialId = c.id;
        trialSsid = c.ssid;
        trialOurs = open || c.ours;
        trialUntil = now + TRIAL_MS;
        trialLevel = c.level;
        netLog(from, c.ssid, "нет связи с сервером " + fmtDown(now - lastServerOk) + " → "
                + (trialOurs ? "открытая сеть (разрешено в админке)" : "сохранённая сеть") + ", сигнал " + c.level + " dBm, проверяю, отвечает ли сервер");
        return "запасная сеть «" + c.ssid + "»";
    }

    // Порядок при обрыве: основная из админки, другие сохранённые, открытые
    private int rank(Candidate c) {
        return c.ours ? 2 : c.ssid.equals(primarySsid()) ? 0 : 1;
    }

    // Лучшая сеть рядом (кроме текущей и тех, что не прошли проверку за последний час). mainOnly — только
    // сохранённые людьми (основные), иначе сначала сохранённые, потом открытые; среди равных — по силе сигнала
    private Candidate pick(boolean allowOpen, boolean mainOnly) {
        WifiManager wm = wifi();
        wm.startScan();
        String current = String.valueOf(wm.getConnectionInfo().getSSID());
        List<WifiConfiguration> saved = wm.getConfiguredNetworks();
        long now = System.currentTimeMillis();
        Candidate best = null;
        int seen = 0, open = 0, bannedN = 0, bestOpen = -200;
        for (ScanResult s : wm.getScanResults()) {
            if (s.SSID == null || s.SSID.isEmpty()) continue;
            String q = "\"" + s.SSID + "\"";
            Long ban = banned.get(s.SSID);
            boolean isOpen = !s.capabilities.matches(".*(WEP|PSK|EAP|SAE|OWE).*");
            if (!q.equals(current)) {
                seen++;
                if (isOpen) { open++; bestOpen = Math.max(bestOpen, s.level); }
                if (ban != null && ban > now) bannedN++;
            }
            if (s.level < -85) continue; // слишком слабый сигнал — не меняем шило на мыло
            if (q.equals(current) || (ban != null && ban > now)) continue;
            Candidate c = null;
            if (authBad.containsKey(s.SSID)) continue; // пароль не подходит — не тратим время
            if (saved != null) for (WifiConfiguration w : saved) {
                if (q.equals(w.SSID)) { c = new Candidate(w.networkId, s.SSID, s.level, isOurs(w.networkId)); break; }
            }
            if (c == null && allowOpen && !mainOnly && !s.capabilities.matches(".*(WEP|PSK|EAP|SAE|OWE).*")) c = new Candidate(-1, s.SSID, s.level, true);
            if (c == null || (mainOnly && c.ours)) continue;
            boolean better = best == null || rank(c) < rank(best) || (rank(c) == rank(best) && c.level > best.level);
            if (better) best = c;
        }
        pickInfo = "рядом других сетей " + seen + ", открытых " + open
                + (open > 0 ? ", самая сильная открытая " + bestOpen + " dBm" + (bestOpen < -85 ? " (слишком слабая)" : "") : "")
                + (bannedN > 0 ? ", не прошли проверку за последний час: " + bannedN : "")
                + (allowOpen ? "" : "; открытые сети запрещены в админке");
        return best;
    }

    // ---------- Сети из админки: для всех планшетов, ресторана и этого планшета — сервер присылает итоговый список.
    // Сохраняем их сами (в сервисное меню лезть не нужно); удалённые в админке — забываем (ту, через которую сейчас
    // есть связь, — когда перейдём на другую). «Основная» — держимся её, когда она видна. Основной нет — выбираем сами:
    // переходим на другую сеть из списка, только если она явно лучше по сигналу и стабильности (счёт за сутки).
    // Пароль сменили: есть «новый пароль» — пробуем его; нет — «не пускает» (сервер напишет в Telegram), а связь держим
    // через открытую сеть рядом, пока в админке не впишут новый пароль — он придёт через неё
    private final Map<String, Long> authBad = new HashMap<>(), switchBan = new HashMap<>();
    private final java.util.Set<String> pendingRemove = new java.util.HashSet<>();
    private long lastSteer, lastSwitchAt, lastScanAt, lastStatsSave;
    private String switchTarget = "";
    private JSONObject stats;

    private JSONObject adminCfg() {
        try {
            String s = prefs.getString("wifiCfg", "");
            return s.isEmpty() ? null : new JSONObject(s);
        } catch (Exception e) {
            return null;
        }
    }

    // Список сетей; старый формат (одна сеть ssid / pass / pass2) — как список из одной
    private JSONArray adminNets() {
        JSONObject c = adminCfg();
        if (c == null) return new JSONArray();
        JSONArray nets = c.optJSONArray("nets");
        if (nets != null) return nets;
        JSONArray one = new JSONArray();
        try { if (!c.optString("ssid").isEmpty()) one.put(new JSONObject().put("ssid", c.optString("ssid")).put("pass", c.optString("pass")).put("pass2", c.optString("pass2"))); } catch (Exception ignored) { }
        return one;
    }

    private JSONObject adminNet(String ssid) {
        JSONArray nets = adminNets();
        for (int i = 0; i < nets.length(); i++) if (ssid.equals(nets.optJSONObject(i).optString("ssid"))) return nets.optJSONObject(i);
        return null;
    }

    private String primarySsid() {
        JSONObject c = adminCfg();
        return c == null ? "" : c.optString("primary");
    }

    private WifiConfiguration findConf(String ssid) {
        List<WifiConfiguration> saved = wifi().getConfiguredNetworks();
        if (saved != null) for (WifiConfiguration w : saved) if (("\"" + ssid + "\"").equals(w.SSID) && !isOurs(w.networkId)) return w;
        return null;
    }

    private static void setKey(WifiConfiguration c, String pass) {
        c.allowedKeyManagement.clear();
        if (pass.isEmpty()) {
            c.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
        } else {
            c.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK);
            c.preSharedKey = "\"" + pass + "\"";
        }
    }

    // Каким паролем записана сеть: 0 — «пароль», 1 — «новый пароль»
    private int idxOf(String ssid) {
        try { return new JSONObject(prefs.getString("wifiIdxMap", "{}")).optInt(ssid, 0); } catch (Exception e) { return 0; }
    }

    // Записать сеть из админки с паролем номер idx. Возвращает id сети или -1
    private int writeNet(JSONObject n, int idx) {
        WifiManager wm = wifi();
        String ssid = n.optString("ssid"), pass = n.optString(idx == 0 ? "pass" : "pass2");
        WifiConfiguration c = findConf(ssid);
        int id;
        if (c == null) {
            c = new WifiConfiguration();
            c.SSID = "\"" + ssid + "\"";
            setKey(c, pass);
            id = wm.addNetwork(c);
        } else {
            setKey(c, pass);
            id = wm.updateNetwork(c);
            if (id == -1 && !ssid.equals(curSsid())) { // чужую запись Android не дал изменить — пересоздаём (мы к ней не подключены)
                wm.removeNetwork(c.networkId);
                c.networkId = -1;
                id = wm.addNetwork(c);
            }
        }
        if (id != -1) wm.enableNetwork(id, false);
        try { prefs.edit().putString("wifiIdxMap", new JSONObject(prefs.getString("wifiIdxMap", "{}")).put(ssid, idx).toString()).apply(); } catch (Exception ignored) { }
        return id;
    }

    private void forget(String ssid) {
        WifiConfiguration c = findConf(ssid);
        if (c != null) wifi().removeNetwork(c.networkId);
    }

    // Новые данные из админки: сохранить сети, забыть удалённые; стоим на запасной открытой — сразу пробуем сеть из списка
    private void applyAdminCfg(long now, boolean ok) {
        JSONArray nets = adminNets();
        String cur = curSsid();
        java.util.Set<String> want = new java.util.LinkedHashSet<>();
        for (int i = 0; i < nets.length(); i++) {
            JSONObject n = nets.optJSONObject(i);
            String ssid = n.optString("ssid");
            if (ssid.isEmpty()) continue;
            want.add(ssid);
            banned.remove(ssid);
            if (cur.equals(ssid) && ok) continue; // подключены и связь есть — текущий пароль годится, ничего не трогаем
            writeNet(n, 0);
        }
        try {
            JSONArray had = new JSONArray(prefs.getString("adminSsids", "[]"));
            for (int i = 0; i < had.length(); i++) {
                String ssid = had.optString(i);
                if (want.contains(ssid)) continue;
                if (ssid.equals(cur) && ok) pendingRemove.add(ssid); else forget(ssid);
            }
        } catch (Exception ignored) { }
        prefs.edit().putString("adminSsids", new JSONArray(want).toString()).apply();
        authBad.clear();
        switchBan.clear();
        boolean hadFail = authFail != null;
        authFail = null;
        String primary = primarySsid();
        netLog(cur, cur, (hadFail ? "новые данные Wi-Fi из админки (пароль обновлён): " : "сети из админки: ")
                + (want.isEmpty() ? "нет" : String.join(", ", want)) + (primary.isEmpty() ? ", основной нет — выбираю сам" : ", основная «" + primary + "»"));
        if (backupId != -1 && curId() == backupId) {
            Candidate c = pick(false, true);
            if (c != null) switchTo(c.ssid, c.id, now, "сеть «" + c.ssid + "» из админки рядом — ухожу с запасной открытой");
        }
    }

    // Переход на другую сеть с проверкой: минута, чтобы сервер ответил, иначе назад и 20 минут её не пробуем
    private void switchTo(String ssid, int id, long now, String why) {
        mainTrialBack = curId();
        mainTrialUntil = now + MAIN_TRIAL_MS;
        lastSwitchAt = now;
        switchTarget = ssid;
        netLog(curSsid(), ssid, why);
        wifi().enableNetwork(id, true);
    }

    // Раз в минуту, пока связь есть: держимся основной; без основной — переходим, только если другая сеть явно лучше
    private void steer(long now) {
        if (!isOwner() || !screenOn() || trialId != -1 || mainTrialBack != -1 || now - lastSteer < 60_000) return;
        lastSteer = now;
        JSONArray nets = adminNets();
        if (nets.length() == 0) return;
        int curId = curId();
        if (backupId != -1 && curId == backupId) return; // на запасной открытой — возвратом занимается своя проверка
        WifiManager wm = wifi();
        if (now - lastScanAt > 120_000) { wm.startScan(); lastScanAt = now; }
        Map<String, Integer> vis = new HashMap<>();
        for (ScanResult r : wm.getScanResults()) {
            if (r.SSID == null || adminNet(r.SSID) == null) continue;
            Integer was = vis.get(r.SSID);
            if (was == null || r.level > was) vis.put(r.SSID, r.level);
        }
        String cur = curSsid(), primary = primarySsid();
        if (!primary.isEmpty()) {
            Integer lv = vis.get(primary);
            Long ban = switchBan.get(primary);
            if (cur.equals(primary) || lv == null || lv < -72 || (ban != null && ban > now) || authBad.containsKey(primary) || now - lastSwitchAt < 5 * 60_000) return;
            WifiConfiguration c = findConf(primary);
            if (c != null) switchTo(primary, c.networkId, now, "основная сеть «" + primary + "» видна (сигнал " + lv + " dBm) — перехожу на неё");
            return;
        }
        if (now - lastSwitchAt < 20 * 60_000) return;
        WifiInfo info = wm.getConnectionInfo();
        int rssi = info == null ? -100 : info.getRssi();
        int out30 = outages(cur, now - 30 * 60_000);
        if (out30 < 2 && rssi >= -75) return; // текущая сеть в порядке
        String best = null;
        int bestLv = -200, bestAvail = -1;
        for (Map.Entry<String, Integer> e : vis.entrySet()) {
            String ssid = e.getKey();
            int lv = e.getValue(), av = avail(ssid);
            Long ban = switchBan.get(ssid);
            if (ssid.equals(cur) || lv < -70 || (ban != null && ban > now) || authBad.containsKey(ssid)) continue;
            if (!(lv >= rssi + 10 || lv >= -65) || (av >= 0 && av < 95) || outages(ssid, now - 30 * 60_000) > 0) continue;
            if (best == null || av > bestAvail || (av == bestAvail && lv > bestLv)) { best = ssid; bestLv = lv; bestAvail = av; }
        }
        if (best == null) return;
        WifiConfiguration c = findConf(best);
        if (c != null) switchTo(best, c.networkId, now, "на «" + cur + "» " + (out30 >= 2 ? out30 + " обрыва за 30 мин" : "слабый сигнал " + rssi + " dBm")
                + " — пробую «" + best + "» (сигнал " + bestLv + " dBm" + (bestAvail >= 0 ? ", на связи " + bestAvail + " %" : "") + ")");
    }

    // ---------- Счёт сетей за сутки (по часам): удачные и неудачные опросы при включённом экране, обрывы, сигнал
    private JSONObject stats() {
        if (stats == null) {
            try { stats = new JSONObject(prefs.getString("netStats", "{}")); } catch (Exception e) { stats = new JSONObject(); }
        }
        return stats;
    }

    private JSONObject statOf(String ssid) throws Exception {
        JSONObject x = stats().optJSONObject(ssid);
        if (x == null) { x = new JSONObject().put("h", new JSONArray()).put("o", new JSONArray()).put("r", 0); stats().put(ssid, x); }
        return x;
    }

    private void recordStat(boolean ok, long now) {
        try {
            if (!screenOn()) return;
            // во время обрыва опрос идёт каждые 5 с — неудачи считаем не чаще раза в 15 с, как и удачные опросы
            if (!ok) { if (now - lastFailStat < 14_000) return; lastFailStat = now; }
            String ssid = curSsid();
            if (ssid.isEmpty()) return;
            JSONObject x = statOf(ssid);
            long hour = now / 3_600_000L;
            JSONArray h = x.getJSONArray("h"), keep = new JSONArray();
            JSONArray last = null;
            for (int i = 0; i < h.length(); i++) {
                JSONArray b = h.getJSONArray(i);
                if (b.getLong(0) < hour - 23) continue;
                keep.put(b);
                if (b.getLong(0) == hour) last = b;
            }
            if (last == null) { last = new JSONArray().put(hour).put(0).put(0); keep.put(last); }
            last.put(ok ? 1 : 2, last.getInt(ok ? 1 : 2) + 1);
            x.put("h", keep);
            WifiInfo info = wifi().getConnectionInfo();
            if (info != null && info.getRssi() > -127) {
                double r = x.optDouble("r", 0);
                x.put("r", r == 0 ? info.getRssi() : r * 0.9 + info.getRssi() * 0.1);
            }
            if (now - lastStatsSave > 5 * 60_000) { lastStatsSave = now; prefs.edit().putString("netStats", stats().toString()).apply(); }
        } catch (Exception ignored) { }
    }

    private void recordOutage(String ssid, long at) {
        try {
            if (ssid == null || ssid.isEmpty()) return;
            JSONArray o = statOf(ssid).getJSONArray("o"), keep = new JSONArray();
            for (int i = 0; i < o.length(); i++) if (o.getLong(i) > at - 24 * 3_600_000L) keep.put(o.getLong(i));
            keep.put(at);
            statOf(ssid).put("o", keep);
            prefs.edit().putString("netStats", stats().toString()).apply();
        } catch (Exception ignored) { }
    }

    // Доля удачных опросов за сутки, % (-1 — истории нет)
    private int avail(String ssid) {
        JSONObject x = stats().optJSONObject(ssid);
        if (x == null) return -1;
        long hourNow = System.currentTimeMillis() / 3_600_000L, ok = 0, all = 0;
        JSONArray h = x.optJSONArray("h");
        for (int i = 0; h != null && i < h.length(); i++) {
            JSONArray b = h.optJSONArray(i);
            if (b == null || b.optLong(0) < hourNow - 23) continue;
            ok += b.optInt(1);
            all += b.optInt(1) + b.optInt(2);
        }
        return all < 20 ? -1 : (int) (ok * 100 / all);
    }

    private int outages(String ssid, long since) {
        JSONObject x = stats().optJSONObject(ssid);
        JSONArray o = x == null ? null : x.optJSONArray("o");
        int n = 0;
        for (int i = 0; o != null && i < o.length(); i++) if (o.optLong(i) > since) n++;
        return n;
    }

    // Для админки: как работают сети из списка (и текущая) на этом планшете
    private JSONArray netsTelemetry() {
        JSONArray out = new JSONArray();
        try {
            java.util.Set<String> names = new java.util.LinkedHashSet<>();
            JSONArray nets = adminNets();
            for (int i = 0; i < nets.length(); i++) names.add(nets.optJSONObject(i).optString("ssid"));
            if (!curSsid().isEmpty()) names.add(curSsid());
            long day = System.currentTimeMillis() - 24 * 3_600_000L;
            for (String ssid : names) {
                JSONObject x = stats().optJSONObject(ssid);
                int a = avail(ssid);
                out.put(new JSONObject().put("ssid", ssid).put("avail", a < 0 ? JSONObject.NULL : a).put("out24", outages(ssid, day))
                        .put("rssi", x == null || x.optDouble("r", 0) == 0 ? JSONObject.NULL : (int) Math.round(x.optDouble("r"))));
            }
        } catch (Exception ignored) { }
        return out;
    }

    // Почему запасная сеть не подошла: не подключилась, не дала адрес, страница входа, нет интернета
    private String trialProblem(String err) {
        try {
            WifiInfo i = wifi().getConnectionInfo();
            if (i == null || i.getNetworkId() != trialId) return "не подключилась (Android не соединился с ней)";
            if (i.getIpAddress() == 0) return "не выдала адрес";
            NetworkCapabilities nc = wifiCaps();
            if (nc != null && nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL)) return "страница входа — без логина в браузере интернета нет";
            if (err.contains("подменено")) return "страница входа — соединение подменено";
            if (err.contains("DNS")) return "нет интернета (адрес сервера не находится)";
            return "интернет не отвечает (" + err + ")";
        } catch (Exception e) {
            return "сервер не ответил";
        }
    }

    private NetworkCapabilities wifiCaps() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities nc = cm.getNetworkCapabilities(n);
            if (nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return nc;
        }
        return null;
    }

    // «Сети рядом» из портала: что видит планшет — название, сигнал, частота, открыта ли, сохранена ли
    private void scanNow() {
        try {
            WifiManager wm = wifi();
            wm.startScan();
            SystemClock.sleep(4000);
            String current = curSsid();
            List<WifiConfiguration> saved = wm.getConfiguredNetworks();
            Map<String, ScanResult> best = new HashMap<>();
            for (ScanResult s : wm.getScanResults()) {
                if (s.SSID == null || s.SSID.isEmpty()) continue;
                ScanResult b = best.get(s.SSID);
                if (b == null || s.level > b.level) best.put(s.SSID, s);
            }
            List<ScanResult> list = new java.util.ArrayList<>(best.values());
            list.sort((a, b) -> b.level - a.level);
            JSONArray out = new JSONArray();
            for (ScanResult s : list) {
                if (out.length() >= 40) break;
                boolean isSaved = false;
                if (saved != null) for (WifiConfiguration w : saved) if (("\"" + s.SSID + "\"").equals(w.SSID)) isSaved = true;
                out.put(new JSONObject().put("ssid", s.SSID).put("level", s.level).put("freq", s.frequency)
                        .put("open", !s.capabilities.matches(".*(WEP|PSK|EAP|SAE|OWE).*")).put("saved", isSaved)
                        .put("current", s.SSID.equals(current)));
            }
            prefs.edit().putString("scan", new JSONObject().put("at", System.currentTimeMillis()).put("list", out).toString()).apply();
        } catch (Exception ignored) { }
        pollServer(); // отправить сразу, не ждать следующего опроса
    }

    // Журнал смен сети: уходит на сервер с ближайшим опросом, портал показывает его у устройства
    private void netLog(String from, String to, String why) {
        try {
            JSONArray log = new JSONArray(prefs.getString("netlog", "[]"));
            log.put(new JSONObject().put("at", System.currentTimeMillis()).put("from", from).put("to", to).put("why", why));
            while (log.length() > 20) log.remove(0);
            SharedPreferences.Editor e = prefs.edit().putString("netlog", log.toString());
            if (!to.isEmpty()) e.putString("lastSsid", to); // свою смену не записываем второй раз как «Android сам»
            e.apply();
        } catch (Exception ignored) {
            // журнал не важнее связи
        }
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
            case "scan":
                io.execute(this::scanNow);
                break;
            case "reboot":
                if (isOwner()) dpm.reboot(admin);
                break;
            case "update":
                if (!updScheduled) io.execute(() -> installUpdate(cmd.optString("url", DEFAULT_APK)));
                break;
            case "say": // «Прослушать» в портале: фраза выбранным голосом
                say(cmd.optString("text"), cmd.optString("lang", "en-US"), cmd.optString("voice"), cmd.optDouble("pitch", 1), cmd.optDouble("rate", 1));
                break;
        }
    }

    // Тихая установка новой версии агента: владельцу устройства подтверждение не нужно.
    // Скачиваем во временный файл (до 3 попыток), проверяем место и версию внутри файла. Итог — установлено,
    // уже последняя или ошибка с причиной — уходит на сервер: портал показывает, сервер повторяет команду
    private volatile long lastGuestActivity;
    private volatile int guestCart;
    private volatile boolean updScheduled;
    private long updWaitSince;

    // Гость пользуется планшетом (корзина не пуста или касался экрана последние 2 минуты) — установка перезапустит
    // приложение и прервёт его. Ждём, но не дольше 30 минут
    private boolean guestBusy() {
        return guestCart > 0 || System.currentTimeMillis() - lastGuestActivity < 120_000;
    }

    private void installUpdate(String apkUrl) {
        long nowMs = System.currentTimeMillis();
        if (guestBusy()) {
            if (updWaitSince == 0) updWaitSince = nowMs;
            if (nowMs - updWaitSince < 30 * 60_000) {
                updResult(this, "waiting", "жду, пока гость закончит с планшетом (корзина или касания)");
                updScheduled = true;
                handler.postDelayed(() -> { updScheduled = false; io.execute(() -> installUpdate(apkUrl)); }, 30_000);
                return;
            }
        }
        updWaitSince = 0;
        File apk = new File(getCacheDir(), "agent.apk");
        try {
            long free = freeMb();
            if (free >= 0 && free < 60) { updResult(this, "fail", "мало памяти на планшете: свободно " + free + " МБ"); return; }
            String err = null;
            for (int i = 1; i <= 3; i++) {
                try { download(apkUrl, apk); err = null; break; }
                catch (Exception e) { err = describe(e); SystemClock.sleep(5000L * i); }
            }
            if (err != null) { updResult(this, "fail", "не скачалось за 3 попытки: " + err); return; }
            PackageInfo info = getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
            if (info == null) { updResult(this, "fail", "скачанный файл повреждён"); return; }
            if (code(info) <= BuildConfig.VERSION_CODE) { updResult(this, "latest", "уже последняя версия " + BuildConfig.VERSION_NAME); return; }
            PackageInstaller installer = getPackageManager().getPackageInstaller();
            int id = installer.createSession(new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL));
            PackageInstaller.Session session = installer.openSession(id);
            try (InputStream in = new java.io.FileInputStream(apk); OutputStream out = session.openWrite("agent.apk", 0, apk.length())) {
                byte[] buf = new byte[65536];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                session.fsync(out);
            }
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            Intent done = new Intent(this, UpdateReceiver.class);
            updResult(this, "installing", "устанавливаю " + info.versionName);
            session.commit(PendingIntent.getBroadcast(this, id, done, flags).getIntentSender());
            session.close();
        } catch (Exception e) {
            updResult(this, "fail", "установка не началась: " + e.getClass().getSimpleName() + (e.getMessage() != null ? " " + e.getMessage() : ""));
        } finally {
            if (!apk.delete()) apk.deleteOnExit();
        }
    }

    private static long code(PackageInfo p) {
        return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
    }

    private static void download(String url, File to) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        int status = c.getResponseCode();
        if (status != 200) throw new java.io.IOException("HTTP " + status);
        long want = c.getContentLengthLong(), got = 0;
        try (InputStream in = c.getInputStream(); OutputStream out = new java.io.FileOutputStream(to)) {
            byte[] buf = new byte[65536];
            for (int n; (n = in.read(buf)) > 0; ) { out.write(buf, 0, n); got += n; }
        }
        if (want > 0 && got != want) throw new java.io.IOException("файл недокачан: " + got + " из " + want + " байт");
    }

    // Итог обновления — серверу с ближайшим опросом
    static void updResult(Context c, String status, String msg) {
        try {
            c.getSharedPreferences("jet", MODE_PRIVATE).edit().putString("upd", new JSONObject()
                    .put("at", System.currentTimeMillis()).put("status", status).put("msg", msg).toString()).apply();
        } catch (Exception ignored) { }
    }

    private long freeMb() {
        try { return new StatFs(getFilesDir().getPath()).getAvailableBytes() / 1048576; } catch (Exception e) { return -1; }
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
                    if (pinOk(pin.getText().toString())) serviceMenu();
                })
                .show();
    }

    // PIN из админки (отпечаток с сервера), а пока его не меняли — заданный при подготовке планшета (по умолчанию 1234)
    private boolean pinOk(String entered) {
        String hash = prefs.getString("pinHash", "");
        if (hash.isEmpty()) return entered.equals(prefs.getString("pin", "1234"));
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest((prefs.getString("pinSalt", "") + entered).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte x : d) hex.append(String.format("%02x", x));
            return hex.toString().equals(hash);
        } catch (Exception e) {
            return false;
        }
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
