package com.jetmedia.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** После обновления агента запускаем киоск заново; статус установки просто игнорируем. */
public class UpdateReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            context.startActivity(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
    }
}
