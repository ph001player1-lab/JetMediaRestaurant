package com.jetmedia.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/** После обновления агента запускаем киоск заново. Установка не прошла — причина уходит на сервер (портал, повтор). */
public class UpdateReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            context.startActivity(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return;
        }
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Integer.MIN_VALUE);
        if (status == Integer.MIN_VALUE || status == PackageInstaller.STATUS_SUCCESS) return;
        String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        MainActivity.updResult(context, "fail", "установка отклонена: " + why(status) + (msg != null ? " (" + msg + ")" : ""));
    }

    private static String why(int status) {
        switch (status) {
            case PackageInstaller.STATUS_FAILURE_STORAGE: return "мало памяти";
            case PackageInstaller.STATUS_FAILURE_BLOCKED: return "заблокировано Android";
            case PackageInstaller.STATUS_FAILURE_CONFLICT: return "конфликт с установленной версией";
            case PackageInstaller.STATUS_FAILURE_INCOMPATIBLE: return "несовместимо с планшетом";
            case PackageInstaller.STATUS_FAILURE_INVALID: return "файл повреждён";
            case PackageInstaller.STATUS_FAILURE_ABORTED: return "прервано";
            case PackageInstaller.STATUS_PENDING_USER_ACTION: return "Android просит подтверждение — агент не владелец устройства?";
            default: return "ошибка " + status;
        }
    }
}
