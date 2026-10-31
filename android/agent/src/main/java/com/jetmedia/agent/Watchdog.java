package com.jetmedia.agent;

import android.app.ActivityManager;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.admin.DevicePolicyManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.PowerManager;
import android.os.Process;
import android.os.SystemClock;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Сторож: раз в минуту, в отдельном процессе (:watchdog), проверяет, что киоск на экране и отвечает.
 * Киоск отмечается каждые 15 секунд (файл heartbeat). Отметки нет 45 секунд — приложение упало,
 * зависло или закрыто: сторож завершает его и запускает заново. Три неудачи подряд — сообщает на сервер,
 * сервер пишет администратору в Telegram.
 */
public class Watchdog extends BroadcastReceiver {
    private static final long EVERY = 60_000, STALE = 45_000;

    static void schedule(Context c, long delay) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        PendingIntent pi = PendingIntent.getBroadcast(c, 0, new Intent(c, Watchdog.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.setRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + delay, EVERY, pi);
    }

    static void beat(Context c) { write(c, "heartbeat", String.valueOf(System.currentTimeMillis())); }

    /** Не трогать приложение minutes минут: техник открыл настройки из сервисного меню. 0 — снять паузу. */
    static void pause(Context c, int minutes) { write(c, "pause", String.valueOf(System.currentTimeMillis() + minutes * 60_000L)); }

    /** Запись о сбое: киоск отправит её на сервер после перезапуска. */
    static void note(Context c, String text) {
        try (FileOutputStream out = new FileOutputStream(new File(c.getFilesDir(), "note"), true)) {
            out.write((text + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { }
    }

    /** Приложение сейчас завершится — поднять его через 2 секунды. */
    static void restartSoon(Context c) {
        write(c, "heartbeat", "0");
        schedule(c, 2000);
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            schedule(c, EVERY);
            return;
        }
        DevicePolicyManager dpm = c.getSystemService(DevicePolicyManager.class);
        long now = System.currentTimeMillis();
        SharedPreferences state = c.getSharedPreferences("watchdog", 0);
        int fails = state.getInt("fails", 0);
        if (!dpm.isDeviceOwnerApp(c.getPackageName()) || !c.getSystemService(PowerManager.class).isInteractive()
                || now < read(c, "pause")) return;
        if (now - read(c, "heartbeat") < STALE) {
            if (fails > 0) state.edit().putInt("fails", 0).apply();
            return;
        }
        boolean killed = false;
        for (ActivityManager.RunningAppProcessInfo p : c.getSystemService(ActivityManager.class).getRunningAppProcesses()) {
            if (p.processName.equals(c.getPackageName())) {
                Process.killProcess(p.pid);
                killed = true;
            }
        }
        if (killed) {
            note(c, "приложение не отвечало или было закрыто — перезапущено");
            SystemClock.sleep(1000);
        }
        c.startActivity(new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        state.edit().putInt("fails", fails + 1).apply();
        if (fails + 1 == 3) report(c, "приложение не запускается: три попытки перезапуска подряд не помогли. "
                + "Перезагрузите планшет (долгое нажатие кнопки питания → «Перезапуск»).", goAsync());
    }

    private static void report(Context c, String text, PendingResult done) {
        new Thread(() -> {
            try {
                SharedPreferences prefs = c.getSharedPreferences("jet", 0);
                HttpURLConnection http = (HttpURLConnection) new URL(MainActivity.server(prefs) + "/api/device/alert").openConnection();
                http.setConnectTimeout(8000);
                http.setReadTimeout(8000);
                http.setDoOutput(true);
                http.setRequestProperty("Content-Type", "application/json");
                http.getOutputStream().write(new JSONObject().put("id", MainActivity.deviceId(c, prefs)).put("text", text)
                        .toString().getBytes(StandardCharsets.UTF_8));
                http.getResponseCode();
            } catch (Exception ignored) {
                // нет сети — сервер всё равно заметит, что устройство пропало, и напишет сам
            }
            done.finish();
        }).start();
    }

    private static void write(Context c, String name, String value) {
        try {
            Files.write(new File(c.getFilesDir(), name).toPath(), value.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { }
    }

    private static long read(Context c, String name) {
        try {
            return Long.parseLong(new String(Files.readAllBytes(new File(c.getFilesDir(), name).toPath()), StandardCharsets.UTF_8).trim());
        } catch (Exception e) {
            return 0;
        }
    }
}
