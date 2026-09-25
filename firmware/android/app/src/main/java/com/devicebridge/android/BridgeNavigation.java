package com.devicebridge.android;

import android.app.Activity;
import android.content.Intent;
import android.view.Menu;
import android.view.View;
import android.widget.PopupMenu;

final class BridgeNavigation {
    private BridgeNavigation() {
    }

    static void showMenu(Activity activity, View anchor) {
        PopupMenu menu = new PopupMenu(activity, anchor);
        Menu popup = menu.getMenu();
        popup.add(0, 1, 1, "Home");
        popup.add(0, 2, 2, "Phone");
        popup.add(0, 3, 3, "Contacts");
        popup.add(0, 4, 4, "Logs");
        popup.add(0, 5, 5, "Settings");
        popup.add(0, 6, 6, "Health");

        menu.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case 1:  open(activity, MainActivity.class); return true;
                case 2:  open(activity, HomeActivity.createPhoneIntent(activity)); return true;
                case 3:  open(activity, HomeActivity.createContactsIntent(activity)); return true;
                case 4:  open(activity, BridgeDashboardSectionActivity.createIntent(activity, BridgeDashboardSectionActivity.SECTION_CONSOLE)); return true;
                case 5:  open(activity, SettingsActivity.class); return true;
                case 6:  open(activity, BridgeDashboardSectionActivity.createIntent(activity, BridgeDashboardSectionActivity.SECTION_HEALTH)); return true;
                default: return false;
            }
        });
        menu.show();
    }

    static void open(Activity activity, Class<?> target) {
        if (activity.getClass().equals(target)) {
            return;
        }
        activity.startActivity(new Intent(activity, target));
    }

    static void open(Activity activity, Intent intent) {
        if (intent == null) {
            return;
        }
        activity.startActivity(intent);
    }
}


