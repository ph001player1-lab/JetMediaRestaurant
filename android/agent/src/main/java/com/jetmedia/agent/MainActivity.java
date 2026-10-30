package com.jetmedia.agent;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.app.PendingIntent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.UserManager;
import android.provider.Settings;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
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
    private DevicePolicyManager dpm;
    private ComponentName admin;
    private SharedPreferences prefs;
    private WebView web;
    private int taps;
    private long lastTap;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
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
        web.setWebViewClient(new WebViewClient());

        View corner = new View(this);
        corner.setOnClickListener(v -> onCornerTap());
        FrameLayout root = new FrameLayout(this);
        root.addView(web);
        root.addView(corner, new FrameLayout.LayoutParams(120, 120, Gravity.TOP | Gravity.START));
        setContentView(root);

        if (isOwner()) applyPolicies();
        load();
        schedulePoll();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (readConfig(intent)) load();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideBars();
        if (isOwner()) startLockTask();
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

    private String server() {
        String s = prefs.getString("server", "");
        return s.isEmpty() ? DEFAULT_SERVER : s;
    }

    // Серийный номер передаёт provision.ps1; если его нет — ANDROID_ID
    private String deviceId() {
        String id = prefs.getString("serial", "");
        return id.isEmpty() ? Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID) : id;
    }

    // Раз в 15 секунд: отправить телеметрию, получить и выполнить команды
    private void schedulePoll() {
        io.execute(this::pollServer);
        handler.postDelayed(this::schedulePoll, POLL_MS);
    }

    private void pollServer() {
        try {
            JSONObject t = new JSONObject();
            Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery != null) {
                int scale = Math.max(1, battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100));
                t.put("battery", battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) * 100 / scale);
                t.put("charging", battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0);
            }
            t.put("version", BuildConfig.VERSION_NAME).put("model", Build.MODEL)
                    .put("android", Build.VERSION.RELEASE).put("owner", isOwner())
                    .put("url", prefs.getString("url", ""));
            JSONObject body = new JSONObject().put("id", deviceId()).put("telemetry", t);

            HttpURLConnection c = (HttpURLConnection) new URL(server() + "/api/device/poll").openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.getOutputStream().write(body.toString().getBytes(StandardCharsets.UTF_8));
            JSONArray commands = new JSONObject(read(c.getInputStream())).optJSONArray("commands");
            for (int i = 0; commands != null && i < commands.length(); i++) {
                JSONObject cmd = commands.getJSONObject(i);
                runOnUiThread(() -> execute(cmd));
            }
        } catch (Exception ignored) {
            // нет сети или сервера — попробуем в следующий раз
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
