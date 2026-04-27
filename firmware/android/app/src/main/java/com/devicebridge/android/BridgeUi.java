package com.devicebridge.android;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.text.method.ScrollingMovementMethod;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.Locale;

final class BridgeUi {
    private BridgeUi() {
    }

    static View screenShell(Context context, LinearLayout root) {
        return screenShell(context, root, false);
    }

    static View screenShellNoNav(Context context, LinearLayout root) {
        return screenShell(context, root, false);
    }

    private static View screenShell(Context context, LinearLayout root, boolean includeBottomBar) {
        LinearLayout shell = new LinearLayout(context);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(Color.parseColor("#eef3f8"));

        ScrollView scrollView = new ScrollView(context);
        scrollView.setFillViewport(true);
        scrollView.setBackgroundColor(Color.parseColor("#eef3f8"));
        scrollView.addView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        shell.addView(scrollView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
        ));
        if (includeBottomBar) {
            shell.addView(fixedBottomBar(context), new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
            ));
        }
        return shell;
    }

    static LinearLayout root(Context context) {
        LinearLayout root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(context, 14), dp(context, 14), dp(context, 14), dp(context, 20));
        root.setBackgroundColor(Color.parseColor("#eef3f8"));
        return root;
    }

    private static LinearLayout fixedBottomBar(Context context) {
        LinearLayout bar = new LinearLayout(context);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(context, 10), dp(context, 6), dp(context, 10), dp(context, 6));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setStroke(dp(context, 1), Color.parseColor("#e2e8f0"));
        bar.setBackground(bg);

        Activity activity = context instanceof Activity ? (Activity) context : null;
        String active = activeBottomTab(activity);
        addBottomItem(bar, context, "\u2302", "Home", "home".equals(active), activity, activity == null ? null : new Intent(activity, MainActivity.class), true);
        addBottomItem(bar, context, "\u25a4", "Logs", "logs".equals(active), activity, activity == null ? null : BridgeDashboardSectionActivity.createIntent(activity, BridgeDashboardSectionActivity.SECTION_CONSOLE), true);
        addBottomItem(bar, context, "\u2699", "Settings", "settings".equals(active), activity, activity == null ? null : new Intent(activity, SettingsActivity.class), true);
        addBottomItem(bar, context, "\u2665", "Health", "health".equals(active), activity, activity == null ? null : BridgeDashboardSectionActivity.createIntent(activity, BridgeDashboardSectionActivity.SECTION_HEALTH), false);
        return bar;
    }

    private static void addBottomItem(
            LinearLayout bar,
            Context context,
            String icon,
            String label,
            boolean active,
            Activity activity,
            Intent intent,
            boolean addSpacer
    ) {
        LinearLayout item = new LinearLayout(context);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER);
        item.setMinimumHeight(dp(context, 48));
        item.setPadding(dp(context, 4), dp(context, 3), dp(context, 4), dp(context, 3));

        GradientDrawable itemBg = new GradientDrawable();
        itemBg.setColor(Color.parseColor(active ? "#e2e8f0" : "#ffffff"));
        itemBg.setCornerRadius(dp(context, 14));
        itemBg.setStroke(dp(context, 1), Color.parseColor(active ? "#cbd5e1" : "#eef2f7"));
        item.setBackground(itemBg);
        item.setClickable(true);
        item.setFocusable(true);

        TextView iconView = new TextView(context);
        iconView.setText(icon);
        iconView.setTextSize(16);
        iconView.setTypeface(Typeface.DEFAULT_BOLD);
        iconView.setGravity(Gravity.CENTER);
        iconView.setTextColor(Color.parseColor("#0f172a"));
        item.addView(iconView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        TextView labelView = new TextView(context);
        labelView.setText(label);
        labelView.setTextSize(9);
        labelView.setTypeface(Typeface.DEFAULT_BOLD);
        labelView.setGravity(Gravity.CENTER);
        labelView.setTextColor(Color.parseColor("#0f172a"));
        item.addView(labelView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        if (activity != null && intent != null) {
            item.setOnClickListener(v -> activity.startActivity(intent));
        } else {
            item.setEnabled(false);
        }
        bar.addView(item, new LinearLayout.LayoutParams(0, dp(context, 46), 1f));
        if (addSpacer) {
            bar.addView(spacer(context));
        }
    }

    private static String activeBottomTab(Activity activity) {
        if (activity == null) {
            return "";
        }
        if (activity instanceof MainActivity) {
            return "home";
        }
        if (activity instanceof SettingsActivity) {
            return "settings";
        }
        if (activity instanceof BridgeDashboardSectionActivity) {
            String section = activity.getIntent() == null ? "" : activity.getIntent().getStringExtra("section");
            if (BridgeDashboardSectionActivity.SECTION_CONSOLE.equals(section)) {
                return "logs";
            }
            if (BridgeDashboardSectionActivity.SECTION_HEALTH.equals(section)) {
                return "health";
            }
        }
        if (activity instanceof PermissionFlowActivity) {
            return "health";
        }
        return "";
    }

    static View hero(Context context, String eyebrowText, String titleText, String copyText) {
        LinearLayout hero = new LinearLayout(context);
        hero.setOrientation(LinearLayout.VERTICAL);
        hero.setPadding(dp(context, 16), dp(context, 12), dp(context, 16), dp(context, 12));

        GradientDrawable background = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{Color.parseColor("#0b5ed7"), Color.parseColor("#0f766e")}
        );
        background.setCornerRadius(dp(context, 10));
        hero.setBackground(background);

        if (eyebrowText != null && !eyebrowText.isEmpty()) {
            TextView eyebrow = new TextView(context);
            eyebrow.setText(eyebrowText.toUpperCase(Locale.ROOT));
            eyebrow.setTextColor(Color.parseColor("#93c5fd"));
            eyebrow.setTextSize(10);
            eyebrow.setTypeface(Typeface.DEFAULT_BOLD);
            eyebrow.setLetterSpacing(0.06f);
            LinearLayout.LayoutParams ep = fullWidth(context);
            ep.bottomMargin = dp(context, 2);
            hero.addView(eyebrow, ep);
        }

        TextView title = new TextView(context);
        title.setText(titleText);
        title.setTextColor(Color.WHITE);
        title.setTextSize(18);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams tp = fullWidth(context);
        tp.bottomMargin = (copyText != null && !copyText.isEmpty()) ? dp(context, 3) : 0;
        hero.addView(title, tp);

        if (copyText != null && !copyText.isEmpty()) {
            TextView copy = new TextView(context);
            copy.setText(copyText);
            copy.setTextColor(Color.parseColor("#bfdbfe"));
            copy.setTextSize(11);
            copy.setLineSpacing(0f, 1.1f);
            LinearLayout.LayoutParams cp = fullWidth(context);
            cp.bottomMargin = 0;
            hero.addView(copy, cp);
        }

        return hero;
    }

    static LinearLayout sectionCard(Context context, String title, String subtitle) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(context, 12), dp(context, 12), dp(context, 12), dp(context, 12));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setCornerRadius(dp(context, 12));
        bg.setStroke(dp(context, 1), Color.parseColor("#e2e8f0"));
        card.setBackground(bg);

        if (title != null && !title.isEmpty()) {
            TextView titleView = new TextView(context);
            titleView.setText(title);
            titleView.setTextColor(Color.parseColor("#0f172a"));
            titleView.setTextSize(13);
            titleView.setTypeface(Typeface.DEFAULT_BOLD);
            LinearLayout.LayoutParams tp = fullWidth(context);
            tp.bottomMargin = (subtitle != null && !subtitle.isEmpty()) ? dp(context, 2) : dp(context, 8);
            card.addView(titleView, tp);
        }

        if (subtitle != null && !subtitle.isEmpty()) {
            TextView subtitleView = new TextView(context);
            subtitleView.setText(subtitle);
            subtitleView.setTextColor(Color.parseColor("#64748b"));
            subtitleView.setTextSize(11);
            subtitleView.setPadding(0, 0, 0, dp(context, 6));
            subtitleView.setLineSpacing(0f, 1.1f);
            card.addView(subtitleView, fullWidth(context));
        }

        return card;
    }

    static LinearLayout horizontalRow(Context context) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        return row;
    }

    static View spacer(Context context) {
        View spacer = new View(context);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(dp(context, 6), 1));
        return spacer;
    }

    static View sectionSpacing(Context context) {
        View spacer = new View(context);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(context, 8)
        ));
        return spacer;
    }

    static EditText input(Context context, String hint) {
        EditText editText = new EditText(context);
        editText.setHint(hint);
        editText.setSingleLine(true);
        editText.setTextSize(13);
        editText.setPadding(dp(context, 10), dp(context, 8), dp(context, 10), dp(context, 8));
        editText.setBackground(inputBackground(context));
        return editText;
    }

    static EditText passwordInput(Context context, String hint) {
        EditText editText = input(context, hint);
        editText.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        return editText;
    }

    static EditText multiLineInput(Context context, String hint) {
        EditText editText = input(context, hint);
        editText.setSingleLine(false);
        editText.setGravity(Gravity.TOP | Gravity.START);
        editText.setHorizontallyScrolling(false);
        editText.setMovementMethod(new ScrollingMovementMethod());
        return editText;
    }

    static GradientDrawable inputBackground(Context context) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.parseColor("#f8fafc"));
        background.setCornerRadius(dp(context, 8));
        background.setStroke(dp(context, 1), Color.parseColor("#cbd5e1"));
        return background;
    }

    static TextView label(Context context, String value) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextSize(11);
        view.setTextColor(Color.parseColor("#334155"));
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setAllCaps(true);
        view.setLetterSpacing(0.04f);
        view.setPadding(0, dp(context, 8), 0, dp(context, 3));
        return view;
    }

    static TextView textBlock(Context context, int sizeSp, boolean dark) {
        TextView view = new TextView(context);
        view.setTextSize(sizeSp);
        view.setTextColor(dark ? Color.parseColor("#0f172a") : Color.parseColor("#1e293b"));
        view.setLineSpacing(0f, 1.12f);
        return view;
    }

    static Button actionButton(Context context, String text, String backgroundColor, int textColor) {
        Button button = new Button(context);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextColor(textColor);
        button.setPadding(dp(context, 12), dp(context, 9), dp(context, 12), dp(context, 9));
        button.setBackground(buttonBackground(context, backgroundColor));
        return button;
    }

    static Button smallButton(Context context, String text, String backgroundColor, int textColor) {
        Button button = actionButton(context, text, backgroundColor, textColor);
        button.setTextSize(12);
        return button;
    }

    static Button tinyButton(Context context, String text, String backgroundColor, int textColor) {
        Button button = actionButton(context, text, backgroundColor, textColor);
        button.setTextSize(10);
        button.setPadding(dp(context, 9), dp(context, 6), dp(context, 9), dp(context, 6));
        return button;
    }

    static View menuButton(Context context, String title, String detail, String accentColor) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setClickable(true);
        row.setFocusable(true);
        row.setMinimumHeight(dp(context, 44));

        int r = dp(context, 10);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setCornerRadius(r);
        bg.setStroke(dp(context, 1), Color.parseColor("#e2e8f0"));
        row.setBackground(bg);

        View accent = new View(context);
        String colorHex = accentColor != null ? accentColor : "#0d6efd";
        GradientDrawable accentBg = new GradientDrawable();
        accentBg.setColor(Color.parseColor(colorHex));
        accentBg.setCornerRadii(new float[]{r, r, 0, 0, 0, 0, r, r});
        accent.setBackground(accentBg);
        row.addView(accent, new LinearLayout.LayoutParams(dp(context, 4), ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout textCol = new LinearLayout(context);
        textCol.setOrientation(LinearLayout.VERTICAL);
        textCol.setGravity(Gravity.CENTER_VERTICAL);
        textCol.setPadding(dp(context, 11), dp(context, 10), dp(context, 10), dp(context, 10));

        TextView titleView = new TextView(context);
        titleView.setText(title);
        titleView.setTextColor(Color.parseColor("#0f172a"));
        titleView.setTextSize(13);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        textCol.addView(titleView);

        if (detail != null && !detail.trim().isEmpty()) {
            TextView detailView = new TextView(context);
            detailView.setText(detail);
            detailView.setTextColor(Color.parseColor("#64748b"));
            detailView.setTextSize(11);
            detailView.setPadding(0, dp(context, 2), 0, 0);
            textCol.addView(detailView);
        }

        row.addView(textCol, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return row;
    }

    static TextView statusPill(Context context, String text, String bgColor, String textColor) {
        TextView view = new TextView(context);
        view.setText(text);
        view.setTextColor(Color.parseColor(textColor));
        view.setTextSize(11);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setPadding(dp(context, 8), dp(context, 4), dp(context, 8), dp(context, 4));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.parseColor(bgColor));
        background.setCornerRadius(dp(context, 999));
        view.setBackground(background);
        return view;
    }

    static GradientDrawable buttonBackground(Context context, String colorHex) {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(colorHex));
        bg.setCornerRadius(dp(context, 8));
        return bg;
    }

    static LinearLayout.LayoutParams fullWidth(Context context) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.bottomMargin = dp(context, 6);
        return params;
    }

    static LinearLayout.LayoutParams weightedWidth() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    }

    static int dp(Context context, int value) {
        return (int) (value * context.getResources().getDisplayMetrics().density);
    }
}


