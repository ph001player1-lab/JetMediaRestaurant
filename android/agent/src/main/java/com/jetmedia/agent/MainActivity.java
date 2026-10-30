package com.jetmedia.agent;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Bundle;
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

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Iterator;

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
                + "<p>Сервер: " + prefs.getString("server", "—") + "</p></body></html>";
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
