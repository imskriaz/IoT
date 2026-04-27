package com.devicebridge.android;

import java.util.ArrayList;
import java.util.List;

final class BridgeFeatureCatalog {
    static final class FeatureItem {
        final String title;
        final String status;
        final String dashboardTarget;
        final String detail;

        FeatureItem(String title, String status, String dashboardTarget, String detail) {
            this.title = title;
            this.status = status;
            this.dashboardTarget = dashboardTarget;
            this.detail = detail;
        }
    }

    static final class FeatureSection {
        final String title;
        final String subtitle;
        final List<FeatureItem> items;

        FeatureSection(String title, String subtitle, List<FeatureItem> items) {
            this.title = title;
            this.subtitle = subtitle;
            this.items = items;
        }
    }

    private BridgeFeatureCatalog() {
    }

    static List<FeatureSection> buildSections() {
        List<FeatureSection> sections = new ArrayList<>();

        sections.add(new FeatureSection(
                "Communication",
                "Android-fed communication features the dashboard can use directly or expand next.",
                items(
                        new FeatureItem("SMS relay and delivery events", "Live", "SMS, Queue Manager, user/package limits", "Outgoing messages can be picked up by the bridge and delivery/sent events can return to the dashboard."),
                        new FeatureItem("Incoming SMS ingestion", "Live", "SMS inbox and conversation threads", "Incoming messages can be posted to the dashboard for threaded conversation rendering."),
                        new FeatureItem("Complete call/live-talk module", "Incomplete", "Calls page", "Dashboard calls stay hidden until dial, answer/end, status feed, and live talk are all available."),
                        new FeatureItem("Contact sync", "Possible Next", "Contacts page", "Push phone contacts or selected contacts to the dashboard for operator workflows."),
                        new FeatureItem("USSD execution and result feed", "Live", "USSD Services", "Run carrier codes from the dashboard and sync the response back into history.")
                )
        ));

        sections.add(new FeatureSection(
                "Connectivity",
                "Runtime and transport capabilities the Android bridge can surface now.",
                items(
                        new FeatureItem("Realtime channel", "Live", "Dashboard status, command plane", "Real-time status and outbound commands use the live channel when available."),
                        new FeatureItem("Dashboard HTTP fallback", "Conditional", "HTTP bridge adapter, queued pickup", "HTTP is used only for features that explicitly need it and only when the dashboard URL is reachable."),
                        new FeatureItem("Battery, Wi-Fi, operator, storage, queue depth", "Live", "Dashboard status panel and home metrics", "Operational health fields already fit the dashboard status model."),
                        new FeatureItem("Dual-SIM routing and signal detail", "Possible Next", "Internet, SMS routing, device detail", "Expose per-slot signal, operator, and preferred send path."),
                        new FeatureItem("Network self-heal and fallback rules", "Innovative", "Automation and device health", "App can choose the best dashboard path when one connection degrades.")
                )
        ));

        sections.add(new FeatureSection(
                "Modules",
                "Phone hardware and app modules that can become dashboard surfaces.",
                items(
                        new FeatureItem("Location snapshots", "Possible Next", "GPS Location", "Foreground or scheduled GPS fixes can be shared to dashboard maps."),
                        new FeatureItem("Camera capture and upload", "Possible Next", "Camera / Intercom", "Capture stills or stream-oriented health checks for device supervision."),
                        new FeatureItem("Notification relay", "Innovative", "Logs / events / automation", "Important phone notifications can become dashboard events for monitoring."),
                        new FeatureItem("Storage and media health", "Live", "Storage Manager", "Mounted/free/used bytes and queue buffering can feed dashboard storage UI."),
                        new FeatureItem("NFC, RFID, external input modules", "Possible Next", "NFC / RFID / Touch / Keyboard", "Expose phone-side scans or connected accessory events into dashboard tools.")
                )
        ));

        sections.add(new FeatureSection(
                "Operations",
                "Bridge lifecycle, onboarding, recovery, and support tooling.",
                items(
                        new FeatureItem("Compressed QR onboarding", "Live", "Onboarding and recovery", "Dashboard QR opens the app onboarding flow directly without exposing raw credentials."),
                        new FeatureItem("Separate settings surface", "Live", "Device Settings parity", "Dashboard access and diagnostics live in a dedicated settings screen."),
                        new FeatureItem("Foreground service controls", "Live", "Dashboard-like control surface", "Start/stop and readiness controls are available in the app home."),
                        new FeatureItem("Support bundle export", "Innovative", "Support and troubleshooting", "Safe summary, readiness score, and logs can be copied without exposing secrets."),
                        new FeatureItem("Incident recovery handoff", "Innovative", "Device recovery workflow", "Recovery actions can guide the operator back into onboarding and settings quickly.")
                )
        ));

        sections.add(new FeatureSection(
                "Innovation Lab",
                "App-first ideas that make the bridge easier to operate than a plain config form.",
                items(
                        new FeatureItem("Readiness score", "Live", "Support workflow", "A simple production readiness score helps operators see if permissions, config, and runtime are good enough."),
                        new FeatureItem("Feature map mirror", "Live", "Dashboard parity planning", "One screen lists what Android can already feed into dashboard modules and what is next."),
            new FeatureItem("Recovery-first deep links", "Live", "QR handoff", "Scanning or opening a setup code sends the user straight into guided onboarding."),
                        new FeatureItem("Health pulse cards", "Possible Next", "Dashboard status sync", "Summarize transport, permission drift, queue pressure, and recovery suggestions in one strip."),
                        new FeatureItem("Smart automation suggestions", "Possible Next", "Automation", "App can recommend transport mode, retry policy, or permission fixes based on local state.")
                )
        ));

        return sections;
    }

    static String buildCatalogText() {
        StringBuilder builder = new StringBuilder("Device Bridge Android -> Dashboard Feature Map");
        for (FeatureSection section : buildSections()) {
            builder.append("\n\n").append(section.title).append("\n").append(section.subtitle);
            for (FeatureItem item : section.items) {
                builder.append("\n- ").append(item.title)
                        .append(" [").append(item.status).append("]")
                        .append(" -> ").append(item.dashboardTarget)
                        .append(": ").append(item.detail);
            }
        }
        return builder.toString();
    }

    private static List<FeatureItem> items(FeatureItem... items) {
        List<FeatureItem> list = new ArrayList<>();
        for (FeatureItem item : items) {
            list.add(item);
        }
        return list;
    }
}


