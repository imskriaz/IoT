import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const DeviceBridgeApp());
}

class DeviceBridgeApp extends StatelessWidget {
  const DeviceBridgeApp({super.key});

  @override
  Widget build(BuildContext context) {
    const ink = Color(0xFF0F172A);
    const canvas = Color(0xFFF2F5FA);
    return MaterialApp(
      title: 'Device Bridge',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF0B5ED7),
          brightness: Brightness.light,
        ).copyWith(surface: Colors.white, onSurface: ink),
        scaffoldBackgroundColor: canvas,
        cardTheme: const CardThemeData(
          color: Colors.white,
          elevation: 0,
          margin: EdgeInsets.zero,
        ),
        textTheme: Typography.blackMountainView.apply(
          bodyColor: ink,
          displayColor: ink,
        ),
      ),
      home: const DeviceBridgeHomePage(),
    );
  }
}

class DeviceBridgeHomePage extends StatefulWidget {
  const DeviceBridgeHomePage({super.key});

  @override
  State<DeviceBridgeHomePage> createState() => _DeviceBridgeHomePageState();
}

class _DeviceBridgeHomePageState extends State<DeviceBridgeHomePage>
    with WidgetsBindingObserver {
  static const _channel = MethodChannel('devicebridge/native');
  static const Duration _idleRefreshInterval = Duration(seconds: 6);
  static const Duration _activeCallRefreshInterval = Duration(seconds: 2);

  final TextEditingController _searchController = TextEditingController();
  final TextEditingController _setupCodeController = TextEditingController();
  Map<dynamic, dynamic>? _state;
  String _consoleFilter = 'all';
  String _consoleCategoryFilter = 'all';
  bool _loading = true;
  bool _busy = false;
  bool _checkedPendingSetupCode = false;
  bool _showSetupSurface = false;
  bool _connectingFromSetup = false;
  String? _setupStatus;
  String _setupProgress = 'Preparing bridge...';
  Timer? _refreshTimer;
  Timer? _setupPollTimer;
  Duration _refreshInterval = _idleRefreshInterval;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadState();
    _restartRefreshTimer();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_loadState(silent: true));
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _refreshTimer?.cancel();
    _setupPollTimer?.cancel();
    _searchController.dispose();
    _setupCodeController.dispose();
    super.dispose();
  }

  Future<void> _loadState({bool silent = false}) async {
    if (!silent) {
      setState(() => _loading = true);
    }
    try {
      final result = await _channel.invokeMethod<dynamic>('getDashboardState');
      if (!mounted) return;
      setState(() {
        _state = Map<dynamic, dynamic>.from(result as Map);
        if (_connectingFromSetup && _bool(_state?['online'])) {
          _connectingFromSetup = false;
          if (_bool(_state?['batteryOptimizationDisabled'])) {
            _showSetupSurface = false;
            _setupStatus = null;
          } else {
            _showSetupSurface = true;
            _setupStatus =
                'Disable battery optimization to finish onboarding.';
          }
        }
      });
      _syncRefreshInterval(_state);
      if (_bool(_state?['hasPendingSetupCode'])) {
        unawaited(_consumePendingSetupCodeIfNeeded(force: true));
      } else if (!_checkedPendingSetupCode) {
        unawaited(_consumePendingSetupCodeIfNeeded());
      }
    } on PlatformException catch (error) {
      if (!silent && mounted) {
        _showSnack(error.message ?? error.code);
      }
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  void _restartRefreshTimer() {
    _refreshTimer?.cancel();
    _refreshTimer = Timer.periodic(
      _refreshInterval,
      (_) => _loadState(silent: true),
    );
  }

  void _syncRefreshInterval(Map<dynamic, dynamic>? state) {
    final nextInterval = _isCallActive(state)
        ? _activeCallRefreshInterval
        : _idleRefreshInterval;
    if (nextInterval == _refreshInterval) {
      return;
    }
    _refreshInterval = nextInterval;
    _restartRefreshTimer();
  }

  bool _isCallActive(Map<dynamic, dynamic>? state) {
    final status = _string(state?['callStatus']).trim().toLowerCase();
    return const {'ringing', 'dialing', 'connected', 'answered'}.contains(
      status,
    );
  }

  Future<void> _consumePendingSetupCodeIfNeeded({bool force = false}) async {
    if (!force && _checkedPendingSetupCode) {
      return;
    }
    _checkedPendingSetupCode = true;
    try {
      final code = await _channel.invokeMethod<String>(
        'consumePendingSetupCode',
      );
      final normalized = (code ?? '').trim();
      if (!mounted || normalized.isEmpty) return;
      _setupCodeController.text = normalized;
      await _importSetupCode(normalized, progress: 'Importing secure code...');
    } on PlatformException {
      // Ignore pending-code bootstrap failures here; the visible onboarding
      // screen already exposes retry paths.
    }
  }

  Future<void> _startQrScan() async {
    if (_busy || _connectingFromSetup) return;
    try {
      final scanned = await _channel.invokeMethod<String>('launchQrScanner');
      final normalized = (scanned ?? '').trim();
      if (!mounted || normalized.isEmpty) {
        setState(() {
          _showSetupSurface = true;
          _setupStatus = 'QR scan cancelled.';
        });
        return;
      }
      _setupCodeController.text = normalized;
      await _importSetupCode(
        normalized,
        progress: 'Importing QR setup...',
        retryQrOnFailure: true,
      );
    } on PlatformException catch (error) {
      if (!mounted) return;
      _showSnack(error.message ?? 'Unable to open scanner.');
      setState(() {
        _showSetupSurface = true;
        _setupStatus = null;
      });
    }
  }

  Future<void> _importSetupCode(
    String code, {
    required String progress,
    bool retryQrOnFailure = false,
  }) async {
    final normalized = code.trim();
    if (normalized.isEmpty) {
      setState(() {
        _showSetupSurface = true;
        _setupStatus = 'Paste a valid setup code first.';
      });
      return;
    }

    _setupPollTimer?.cancel();
    setState(() {
      _showSetupSurface = true;
      _connectingFromSetup = true;
      _setupStatus = null;
      _setupProgress = progress;
    });

    try {
      final result = await _channel.invokeMethod<dynamic>('importSetupCode', {
        'code': normalized,
      });
      if (!mounted) return;
      setState(() {
        _state = Map<dynamic, dynamic>.from(result as Map);
        _setupProgress = 'Starting bridge...';
      });
      _startSetupPolling();
    } on PlatformException catch (error) {
      if (!mounted) return;
      final message = error.message ?? 'Invalid setup code.';
      setState(() {
        _connectingFromSetup = false;
        _showSetupSurface = true;
        _setupStatus = retryQrOnFailure ? null : message;
      });
      _showSnack(message);
      if (retryQrOnFailure) {
        Future.delayed(const Duration(milliseconds: 450), () {
          if (!mounted || _connectingFromSetup) return;
          _startQrScan();
        });
      }
    }
  }

  Future<bool> _requestFeatureAccess({
    required String method,
    required String stateKey,
    required String successMessage,
    String? deniedMessage,
  }) async {
    try {
      final result = await _channel.invokeMethod<dynamic>(method);
      if (!mounted) return false;
      if (result is Map) {
        setState(() => _state = Map<dynamic, dynamic>.from(result));
      }
      final ready = _bool((_state ?? const <dynamic, dynamic>{})[stateKey]);
      if (ready && successMessage.isNotEmpty) {
        _showSnack(successMessage);
      } else if (!ready && deniedMessage != null && deniedMessage.isNotEmpty) {
        _showSnack(deniedMessage);
      }
      return ready;
    } on PlatformException catch (error) {
      if (mounted) {
        _showSnack(error.message ?? error.code);
      }
      return false;
    }
  }

  Future<void> _activateCallFeature() async {
    await _requestFeatureAccess(
      method: 'requestCallFeaturePermissions',
      stateKey: 'callFeatureReady',
      successMessage: 'Call controls activated',
      deniedMessage: 'Call controls are still disabled.',
    );
  }

  Future<void> _activateWebcamFeature() async {
    await _requestFeatureAccess(
      method: 'requestWebcamFeaturePermissions',
      stateKey: 'webcamFeatureReady',
      successMessage: 'Webcam access activated',
      deniedMessage: 'Webcam access is still disabled.',
    );
  }

  Future<void> _activateIntercomFeature() async {
    await _requestFeatureAccess(
      method: 'requestIntercomFeaturePermissions',
      stateKey: 'intercomFeatureReady',
      successMessage: 'Intercom access activated',
      deniedMessage: 'Intercom access is still disabled.',
    );
  }

  Future<bool> _ensureQrFeatureReady() {
    return _requestFeatureAccess(
      method: 'requestQrFeaturePermissions',
      stateKey: 'qrFeatureReady',
      successMessage: 'QR scanner activated',
      deniedMessage: 'Camera access is needed for QR scan.',
    );
  }

  Future<void> _openQrScannerFlow() async {
    final ready = _bool((_state ?? const <dynamic, dynamic>{})['qrFeatureReady'])
        ? true
        : await _ensureQrFeatureReady();
    if (!ready) {
      return;
    }
    await _startQrScan();
  }

  Future<void> _requestDisableBatteryOptimization() async {
    try {
      final result = await _channel.invokeMethod<dynamic>(
        'requestDisableBatteryOptimization',
      );
      if (!mounted) return;
      if (result is Map) {
        setState(() => _state = Map<dynamic, dynamic>.from(result));
      }
      final disabled = _bool(
        (_state ?? const <dynamic, dynamic>{})['batteryOptimizationDisabled'],
      );
      _showSnack(
        disabled
            ? 'Battery optimization is already disabled'
            : 'Allow background protection in Android to keep the bridge alive.',
      );
    } on PlatformException catch (error) {
      if (!mounted) return;
      _showSnack(error.message ?? error.code);
    }
  }

  void _startSetupPolling() {
    _setupPollTimer?.cancel();
    var attempts = 0;
    _setupPollTimer = Timer.periodic(const Duration(milliseconds: 900), (
      timer,
    ) async {
      attempts += 1;
      await _loadState(silent: true);
      if (!mounted) {
        timer.cancel();
        return;
      }
      final state = _state ?? const <dynamic, dynamic>{};
      if (_bool(state['online'])) {
        timer.cancel();
        setState(() {
          _connectingFromSetup = false;
          if (_bool(state['batteryOptimizationDisabled'])) {
            _showSetupSurface = false;
            _setupStatus = null;
          } else {
            _showSetupSurface = true;
            _setupStatus =
                'Disable battery optimization to finish onboarding.';
          }
        });
        return;
      }
      if (attempts >= 18) {
        timer.cancel();
        setState(() {
          _connectingFromSetup = false;
          _showSetupSurface = true;
          _setupStatus = 'Still connecting. Check signal and retry.';
        });
      }
    });
  }

  Future<void> _showPasteCodeSheet() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) {
        return Padding(
          padding: EdgeInsets.only(
            left: 12,
            right: 12,
            top: 12,
            bottom: MediaQuery.of(context).viewInsets.bottom + 12,
          ),
          child: Container(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 18),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(24),
              boxShadow: const [
                BoxShadow(
                  color: Color(0x1F0F172A),
                  blurRadius: 24,
                  offset: Offset(0, 16),
                ),
              ],
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Paste code',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Paste the code from dashboard.',
                  style: TextStyle(fontSize: 12.5, color: Color(0xFF64748B)),
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: _setupCodeController,
                  maxLines: 4,
                  minLines: 3,
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12.8,
                  ),
                  decoration: InputDecoration(
                    hintText: 'Setup code',
                    filled: true,
                    fillColor: const Color(0xFFF8FAFC),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: const BorderSide(color: Color(0xFF1D4ED8)),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () async {
                          final data = await Clipboard.getData('text/plain');
                          if (!mounted) return;
                          _setupCodeController.text = data?.text?.trim() ?? '';
                        },
                        icon: const Icon(Icons.content_paste_rounded),
                        label: const Text('Paste'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: () async {
                          Navigator.of(context).pop();
                          await _importSetupCode(
                            _setupCodeController.text,
                            progress: 'Importing secure code...',
                          );
                        },
                        icon: const Icon(Icons.arrow_forward_rounded),
                        label: const Text('Connect'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _showSetupToolsSheet() async {
    final state = _state ?? const <dynamic, dynamic>{};
    final qrFeatureReady = _bool(state['qrFeatureReady']);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) {
        return Container(
          margin: EdgeInsets.only(
            left: 12,
            right: 12,
            top: 12,
            bottom: MediaQuery.of(context).viewInsets.bottom + 12,
          ),
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 18),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(28),
            boxShadow: const [
              BoxShadow(
                color: Color(0x1F0F172A),
                blurRadius: 28,
                offset: Offset(0, 18),
              ),
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Setup tools',
                style: TextStyle(fontSize: 19, fontWeight: FontWeight.w900),
              ),
              const SizedBox(height: 6),
              const Text(
                'Open QR onboarding or import a secure setup code when you need to provision the device.',
                style: TextStyle(fontSize: 12.8, color: Color(0xFF64748B)),
              ),
              const SizedBox(height: 14),
              _SettingsFeatureCard(
                icon: Icons.qr_code_scanner_rounded,
                accent: const Color(0xFF0B5ED7),
                title: 'QR scanner',
                detail: qrFeatureReady
                    ? 'Camera access is active. Scan a dashboard QR code.'
                    : 'Camera access stays off until you explicitly open QR setup.',
                statusLabel: qrFeatureReady ? 'Ready' : 'Camera off',
                statusColor: qrFeatureReady
                    ? const Color(0xFF16A34A)
                    : const Color(0xFFB45309),
                actionLabel: qrFeatureReady ? 'Open scanner' : 'Enable & scan',
                onTap: () async {
                  Navigator.of(context).pop();
                  await _openQrScannerFlow();
                },
              ),
              const SizedBox(height: 10),
              _SettingsFeatureCard(
                icon: Icons.password_rounded,
                accent: const Color(0xFF0F766E),
                title: 'Paste secure code',
                detail:
                    'Import the encoded setup token copied from the dashboard without using camera access.',
                statusLabel: 'Manual import',
                statusColor: const Color(0xFF0F766E),
                actionLabel: 'Paste code',
                onTap: () async {
                  Navigator.of(context).pop();
                  await _showPasteCodeSheet();
                },
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _runAction(String method) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await _channel.invokeMethod<dynamic>(method);
      await _loadState(silent: true);
      if (method == 'clearLog') {
        _showSnack('Console cleared');
      }
    } on PlatformException catch (error) {
      if (!mounted) return;
      _showSnack(error.message ?? error.code);
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  void _showSnack(String message) {
    final messenger = ScaffoldMessenger.of(context);
    messenger.clearSnackBars();
    messenger.showSnackBar(
      SnackBar(
        content: Text(message),
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 2),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = _state ?? const <dynamic, dynamic>{};
    final screenHeight = MediaQuery.of(context).size.height;
    final consoleBodyHeight = (screenHeight - 372).clamp(156.0, 420.0);
    final needsOnboarding = _bool(state['needsOnboarding']);
    final batteryOptimizationDisabled = _bool(
      state['batteryOptimizationDisabled'],
    );
    final showSetup =
        needsOnboarding || _showSetupSurface || !batteryOptimizationDisabled;
    final consoleEntries = _mapList(state['consoleEntries']);
    final bridgeRunning = _bridgeRunning(state);
    final online = _bool(state['online']);
    final permissionsReady = _bool(state['permissionsReady']);
    final callFeatureReady = _bool(state['callFeatureReady']);
    final webcamFeatureReady = _bool(state['webcamFeatureReady']);
    final intercomFeatureReady = _bool(state['intercomFeatureReady']);
    final qrFeatureReady = _bool(state['qrFeatureReady']);
    final bridgeState = _string(state['bridgeState'], fallback: 'Stopped');
    final transport = _string(state['transport'], fallback: 'MQTT');
    final retryLabel = _retryLabel(state);
    final bridgeToggleAction = bridgeRunning
        ? _MiniAction(
            label: 'Stop',
            icon: Icons.pause_rounded,
            onTap: () => _runAction('stopBridge'),
          )
        : _MiniAction(
            label: 'Start',
            icon: Icons.play_arrow_rounded,
            onTap: () => _runAction('startBridge'),
          );
    final resetAction = _MiniAction(
      label: 'Reset',
      icon: Icons.restart_alt_rounded,
      onTap: _confirmResetOnboarding,
    );
    final settingsAction = _MiniAction(
      label: 'Setting',
      icon: Icons.tune_rounded,
      onTap: _showSettingsSheet,
    );
    final consoleTypeOptions = _consoleTypeOptions(
      consoleEntries
          .where((entry) => _consoleMatches(entry, category: 'all'))
          .toList(growable: false),
    );
    final consoleLevelOptions = _consoleLevelOptions(
      consoleEntries
          .where((entry) => _consoleMatches(entry, level: 'all'))
          .toList(growable: false),
    );
    final filteredConsole = consoleEntries
        .where(_consoleMatches)
        .toList(growable: false);
    final actionMetrics = _actionDeliveryMetrics(state);
    final overviewActions = <_MiniAction>[
      bridgeToggleAction,
      settingsAction,
      resetAction,
    ];

    if (showSetup) {
      return Scaffold(
        body: Stack(
          children: [
            SafeArea(
              child: _loading && _state == null
                  ? const Center(child: CircularProgressIndicator())
                  : RefreshIndicator(
                      onRefresh: _loadState,
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(12, 10, 12, 16),
                        children: [
                          _SetupHero(
                            deviceId: _string(
                              state['deviceId'],
                              fallback: 'Ready for onboarding',
                            ),
                          ),
                          const SizedBox(height: 12),
                          if (_setupStatus != null &&
                              _setupStatus!.trim().isNotEmpty) ...[
                            _SetupStatusBanner(message: _setupStatus!),
                            const SizedBox(height: 12),
                          ],
                          if (_connectingFromSetup)
                            _SetupProgressCard(
                              title: 'Connecting',
                              detail: _setupProgress,
                              deviceId: _string(state['deviceId']),
                              target: _connectionTarget(state),
                            )
                          else ...[
                            _SetupMethodCard(
                              icon: Icons.tune_rounded,
                              eyebrow: 'Primary',
                              title: 'Open setup tools',
                              detail: qrFeatureReady
                                  ? 'QR scan and secure code import are available in one popup.'
                                  : 'Open one popup for QR scan or secure code import. Camera stays off until you choose QR.',
                              accent: const Color(0xFF0B5ED7),
                              onTap: _showSetupToolsSheet,
                            ),
                            const SizedBox(height: 12),
                            _SetupMethodCard(
                              icon: Icons.battery_charging_full_rounded,
                              eyebrow: batteryOptimizationDisabled
                                  ? 'Ready'
                                  : 'Required',
                              title: 'Disable battery optimization',
                              detail: batteryOptimizationDisabled
                                  ? 'Background protection is active for the bridge.'
                                  : 'Required during onboarding so Android does not pause the bridge in background.',
                              accent: const Color(0xFFCA8A04),
                              onTap: _requestDisableBatteryOptimization,
                            ),
                            const SizedBox(height: 12),
                            _SetupMethodCard(
                              icon: Icons.shield_outlined,
                              eyebrow: permissionsReady ? 'Ready' : 'Review',
                              title: 'Bridge setting',
                              detail:
                                  callFeatureReady ||
                                          webcamFeatureReady ||
                                          intercomFeatureReady
                                      ? 'Core bridge access is ready and optional call, webcam, or intercom modules are available when needed.'
                                      : 'Review bridge access and activate optional call, webcam, or intercom controls only when needed.',
                              accent: const Color(0xFF0F766E),
                              onTap: _showSettingsSheet,
                            ),
                            const SizedBox(height: 12),
                            const _SetupSafetyNote(),
                          ],
                        ],
                      ),
                    ),
            ),
            if (_busy) const _BusyBar(label: 'Working...'),
          ],
        ),
      );
    }

    return Scaffold(
      body: Stack(
        children: [
          SafeArea(
            child: _loading && _state == null
                ? const Center(child: CircularProgressIndicator())
                : RefreshIndicator(
                    onRefresh: _loadState,
                    child: ListView(
                      padding: const EdgeInsets.fromLTRB(12, 8, 12, 16),
                      children: [
                        const SizedBox(height: 58),
                        _OverviewPanel(
                          online: online,
                          bridgeState: bridgeState,
                          transport: transport,
                          callStatus: _string(state['callStatus']),
                          callDirection: _string(state['callDirection']),
                          callNumber: _string(state['callNumber']),
                          readinessScore: _int(state['readinessScore']),
                          readinessLabel: _string(
                            state['readinessLabel'],
                            fallback: 'Needs setup',
                          ),
                          retryLabel: retryLabel,
                          batteryLevel: state['batteryLevel'] == null
                              ? null
                              : _int(state['batteryLevel']),
                          batteryStatus: _string(
                            state['batteryStatus'],
                            fallback: 'Unknown',
                          ),
                          queueDepth: actionMetrics.pending,
                          publishSuccess: actionMetrics.success,
                          publishFailure: actionMetrics.failed,
                          onDeviceTap: () => _showConnectivityDialog(state),
                          onQueueTap: () => _showQueueDialog(state),
                          footerActions: overviewActions,
                        ),
                        const SizedBox(height: 12),
                        _ConsoleCard(
                          bodyHeight: consoleBodyHeight.toDouble(),
                          queryController: _searchController,
                          selectedCategory: _consoleCategoryFilter,
                          onCategoryChanged: (value) =>
                              setState(() => _consoleCategoryFilter = value),
                          categoryOptions: consoleTypeOptions,
                          selectedFilter: _consoleFilter,
                          onFilterChanged: (value) =>
                              setState(() => _consoleFilter = value),
                          levelOptions: consoleLevelOptions,
                          onChanged: (_) => setState(() {}),
                          onCopy: () => _copyText(
                            filteredConsole
                                .map((entry) => _string(entry['raw']))
                                .join('\n'),
                          ),
                          onClear: _confirmClearConsole,
                          entries: filteredConsole,
                          onTapEntry: (entry) => _showConsoleDetail(entry),
                        ),
                      ],
                    ),
                  ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
              child: Align(
                alignment: Alignment.topCenter,
                child: _PinnedTopBar(
                  title: 'Device Bridge',
                  deviceId: _string(
                    state['deviceId'],
                    fallback: 'Unconfigured device',
                  ),
                  onMenuPressed: _showSettingsSheet,
                  onRefreshPressed: () => _loadState(),
                ),
              ),
            ),
          ),
          if (_busy) const _BusyBar(label: 'Working...'),
        ],
      ),
    );
  }

  String _connectionTarget(Map<dynamic, dynamic> state) {
    final lines = _string(state['connectionSummary']).split('\n');
    for (final line in lines) {
      if (line.trim().startsWith('target')) {
        final parts = line.split('=');
        if (parts.length > 1) {
          return parts.sublist(1).join('=').trim();
        }
      }
    }
    return '';
  }

  String _retryLabel(Map<dynamic, dynamic> state) {
    final source = [
      _string(state['connectionSummary']),
      _string(state['connectionDetail']),
      _string(state['bridgeState']),
    ].join('\n');
    final retryMatch = RegExp(
      r'(?:retry|reconnect)[^0-9]{0,16}(\d+)\s*s',
      caseSensitive: false,
    ).firstMatch(source);
    if (retryMatch != null) {
      return '${retryMatch.group(1)}s';
    }
    return _bool(state['online'])
        ? '${_int(state['readinessScore'])}%'
        : 'wait';
  }

  String _sanitizeConnectivityText(String input) {
    final lines = input
        .split('\n')
        .map((line) => line.trim())
        .where((line) => line.isNotEmpty)
        .where((line) {
          final lower = line.toLowerCase();
          return !(lower.startsWith('target') ||
              lower.startsWith('server') ||
              lower.startsWith('broker') ||
              lower.startsWith('host') ||
              lower.startsWith('url') ||
              lower.startsWith('endpoint') ||
              lower.contains('://'));
        })
        .toList(growable: false);
    return lines.join('\n');
  }

  String _latestConsoleSummary(Map<dynamic, dynamic> state) {
    final entries = _userDrivenConsoleEntries(_mapList(state['consoleEntries']));
    if (entries.isEmpty) {
      return 'No recent device event';
    }
    final latest = entries.first;
    return _string(
      latest['summary'],
      fallback: _string(latest['message'], fallback: 'Recent device event'),
    );
  }

  Future<void> _confirmClearConsole() async {
    if (_busy) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Clear console?'),
        content: const Text(
          'This removes the local 24-hour console history from this app screen.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Clear'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await _runAction('clearLog');
    }
  }

  Future<void> _resetOnboarding() async {
    await _runAction('reopenOnboarding');
    if (!mounted) return;
    setState(() {
      _showSetupSurface = true;
      _connectingFromSetup = false;
      _setupStatus = 'Connection reset. Scan QR or paste setup code.';
    });
  }

  Future<void> _confirmResetOnboarding() async {
    if (_busy) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Reset bridge setup?'),
        content: const Text(
          'This clears the current device connection and sends you back to onboarding. Dashboard actions will stop until setup is completed again.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFFDC2626),
            ),
            child: const Text('Reset'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await _resetOnboarding();
    }
  }

  bool _consoleMatches(
    Map<dynamic, dynamic> entry, {
    String? category,
    String? level,
  }) {
    final query = _searchController.text.trim().toLowerCase();
    final entryLevel = _string(entry['level'], fallback: 'info').toLowerCase();
    final entryCategory = _consoleType(entry);
    final entrySource = _consoleSource(entry);
    final activeCategory = category ?? _consoleCategoryFilter;
    final activeLevel = level ?? _consoleFilter;
    if (activeCategory == 'all' && !_isUserDrivenConsoleEntry(entry)) {
      return false;
    }
    if (activeCategory != 'all' && entryCategory != activeCategory) {
      return false;
    }
    if (activeLevel != 'all' && entryLevel != activeLevel) {
      return false;
    }
    if (query.isEmpty) {
      return true;
    }
    final haystack =
        '$entryCategory $entrySource ${_string(entry['timestamp'])} ${_string(entry['summary'])} ${_string(entry['detail'])} ${_string(entry['raw'])}'
            .toLowerCase();
    return haystack.contains(query);
  }

  List<Map<dynamic, dynamic>> _userDrivenConsoleEntries(
    List<Map<dynamic, dynamic>> entries,
  ) {
    return entries.where(_isUserDrivenConsoleEntry).toList(growable: false);
  }

  bool _isUserDrivenConsoleEntry(Map<dynamic, dynamic> entry) {
    return _isActionConsoleEntry(entry);
  }

  String _consoleSource(Map<dynamic, dynamic> entry) {
    final explicit = _string(entry['source']).trim().toLowerCase();
    if (explicit.isNotEmpty) {
      return explicit;
    }
    return '';
  }

  String _consoleType(Map<dynamic, dynamic> entry) {
    final explicit = _string(entry['type']).trim().toLowerCase();
    if (explicit.isNotEmpty) {
      return explicit;
    }
    final source = _consoleSource(entry);
    if (source.isNotEmpty) {
      return source;
    }
    final text =
        '${_string(entry['summary'])} ${_string(entry['detail'])} ${_string(entry['raw'])}'
            .toLowerCase();
    if (text.contains('/status') ||
        text.contains('telemetry') ||
        text.contains('status push') ||
        text.contains('health pulse')) {
      return 'telemetry';
    }
    if (text.contains('mqtt')) {
      return 'mqtt';
    }
    if (text.contains('http')) {
      return 'http';
    }
    if (text.contains('ussd') || text.contains('send_ussd')) {
      return 'ussd';
    }
    if (text.contains('call') ||
        text.contains('dial') ||
        text.contains('ring') ||
        text.contains('answered') ||
        text.contains('make_call')) {
      return 'call';
    }
    if (text.contains('internet') ||
        text.contains('hotspot') ||
        text.contains('network session') ||
        text.contains('data mode')) {
      return 'internet';
    }
    if (text.contains('sms') ||
        text.contains('message') ||
        text.contains('send_sms') ||
        text.contains('incoming sms') ||
        text.contains('outgoing sms')) {
      return 'sms';
    }
    if (text.contains('queue') || text.contains('publish')) {
      return 'queue';
    }
    if (text.contains('setup') || text.contains('onboard')) {
      return 'setup';
    }
    return 'system';
  }

  Map<String, String> _consoleTypeOptions(List<Map<dynamic, dynamic>> entries) {
    final counts = <String, int>{};
    for (final entry in entries) {
      final type = _consoleType(entry);
      if (type.isNotEmpty) {
        counts[type] = (counts[type] ?? 0) + 1;
      }
    }
    if (_consoleCategoryFilter != 'all' &&
        !counts.containsKey(_consoleCategoryFilter)) {
      counts[_consoleCategoryFilter] = 0;
    }
    final sorted = counts.keys.toList()..sort();
    return {
      'all': 'All types',
      for (final key in sorted)
        key: _consoleTypeLabel(key),
    };
  }

  Map<String, String> _consoleLevelOptions(
    List<Map<dynamic, dynamic>> entries,
  ) {
    final counts = <String, int>{};
    for (final entry in entries) {
      final level = _string(entry['level'], fallback: 'info').toLowerCase();
      counts[level] = (counts[level] ?? 0) + 1;
    }
    if (_consoleFilter != 'all' && !counts.containsKey(_consoleFilter)) {
      counts[_consoleFilter] = 0;
    }
    final preferredOrder = ['info', 'warn', 'error'];
    final sorted = counts.keys.toList()
      ..sort((a, b) {
        final ai = preferredOrder.indexOf(a);
        final bi = preferredOrder.indexOf(b);
        if (ai >= 0 && bi >= 0) return ai.compareTo(bi);
        if (ai >= 0) return -1;
        if (bi >= 0) return 1;
        return a.compareTo(b);
      });
    return {
      'all': 'All levels',
      for (final key in sorted)
        key: _consoleLevelLabel(key),
    };
  }

  String _consoleLevelLabel(String level) {
    return switch (level.toLowerCase()) {
      'warn' => 'Warning',
      'error' => 'Error',
      'info' => 'Info',
      _ =>
        level.replaceAll('_', ' ').trim().isEmpty
            ? 'Info'
            : '${level.substring(0, 1).toUpperCase()}${level.substring(1).replaceAll('_', ' ')}',
    };
  }

  String _consoleTypeLabel(String type) {
    return switch (type.toLowerCase()) {
      'sms' => 'SMS',
      'ussd' => 'USSD',
      'mqtt' => 'MQTT',
      'http' => 'HTTP',
      'internet' => 'Internet',
      'telemetry' => 'Telemetry',
      'call' => 'Call',
      'queue' => 'Queue',
      'setup' => 'Setup',
      'system' => 'System',
      _ =>
        type.replaceAll('_', ' ').trim().isEmpty
            ? 'Other'
            : '${type.substring(0, 1).toUpperCase()}${type.substring(1).replaceAll('_', ' ')}',
    };
  }

  List<Map<dynamic, dynamic>> _mapList(dynamic input) {
    if (input is! List) {
      return const [];
    }
    return input
        .whereType<Map>()
        .map((item) => Map<dynamic, dynamic>.from(item))
        .toList(growable: false);
  }

  bool _bridgeRunning(Map<dynamic, dynamic> state) {
    final bridgeState = _string(state['bridgeState']).toLowerCase();
    return _bool(state['online']) ||
        bridgeState.contains('running') ||
        bridgeState.contains('online') ||
        bridgeState.contains('connected');
  }

  String _buildOverviewDeviceDetail(Map<dynamic, dynamic> state) {
    final batteryLevel = state['batteryLevel'] == null
        ? 'Unknown'
        : '${_int(state['batteryLevel'])}%';
    final batteryStatus = _string(state['batteryStatus'], fallback: 'Unknown');
    final connectionDetail = _sanitizeConnectivityText(
      _string(state['connectionSummary']),
    );
    final deviceLines = _string(state['deviceInfoDetail'])
        .split('\n')
        .where((line) {
          final trimmed = line.trim().toLowerCase();
          return trimmed.startsWith('manufacturer') ||
              trimmed.startsWith('model') ||
              trimmed.startsWith('android') ||
              trimmed.startsWith('operator') ||
              trimmed.startsWith('network_type') ||
              trimmed.startsWith('sim_state') ||
              trimmed.startsWith('sim_slots') ||
              trimmed.startsWith('slot_');
        })
        .join('\n');
    return 'link\n'
        'status         = ${_bool(state['online']) ? 'online' : 'offline'}\n'
        'transport      = ${_string(state['transport'], fallback: 'MQTT')}\n'
        'bridge_state   = ${_string(state['bridgeState'], fallback: 'Stopped')}\n'
        'readiness      = ${_string(state['readinessLabel'], fallback: 'Needs setup')}\n'
        'last_event     = ${_latestConsoleSummary(state)}\n\n'
        'power\n'
        'battery        = $batteryLevel\n'
        'charging       = $batteryStatus\n\n'
        'device\n'
        '${deviceLines.isEmpty ? 'No device detail yet.' : deviceLines}'
        '${connectionDetail.isEmpty ? '' : '\n\nlink_detail\n$connectionDetail'}';
  }

  bool _isActionConsoleEntry(Map<dynamic, dynamic> entry) {
    final type = _consoleType(entry);
    final source = _consoleSource(entry);
    if (!const {'sms', 'ussd', 'call', 'internet', 'http'}.contains(type)) {
      return false;
    }
    if (const {'telemetry', 'system', 'heartbeat'}.contains(source)) {
      return false;
    }
    final text =
        '$source ${_string(entry['summary'])} ${_string(entry['detail'])} ${_string(entry['raw'])}'
            .toLowerCase();
    return !(text.contains('/status') ||
        text.contains('telemetry') ||
        text.contains('heartbeat') ||
        text.contains('status push') ||
        text.contains('health pulse'));
  }

  _ActionDeliveryMetrics _actionDeliveryMetrics(Map<dynamic, dynamic> state) {
    final actionEntries = _userDrivenConsoleEntries(_mapList(state['consoleEntries']));
    final byActionId = <String, _ActionDeliveryStatus>{};
    var anonymousSuccess = 0;
    var anonymousPending = 0;
    var anonymousFailed = 0;

    for (final entry in actionEntries.reversed) {
      final status = _consoleDeliveryStatus(entry);
      if (status == null) {
        continue;
      }
      final actionId = _consoleActionId(entry);
      if (actionId.isEmpty) {
        switch (status) {
          case _ActionDeliveryStatus.success:
            anonymousSuccess += 1;
          case _ActionDeliveryStatus.pending:
            anonymousPending += 1;
          case _ActionDeliveryStatus.failed:
            anonymousFailed += 1;
        }
        continue;
      }
      byActionId[actionId] = status;
    }

    var success = anonymousSuccess;
    var pending = anonymousPending;
    var failed = anonymousFailed;
    for (final status in byActionId.values) {
      switch (status) {
        case _ActionDeliveryStatus.success:
          success += 1;
        case _ActionDeliveryStatus.pending:
          pending += 1;
        case _ActionDeliveryStatus.failed:
          failed += 1;
      }
    }
    return _ActionDeliveryMetrics(
      success: success,
      pending: pending,
      failed: failed,
      recentEntries: actionEntries,
    );
  }

  String _consoleActionId(Map<dynamic, dynamic> entry) {
    final candidates = [
      _firstConsoleValue(entry, const [
        'payload',
        'response',
        'raw',
        'detail',
        'summary',
      ]),
      _string(entry['raw']),
      _string(entry['detail']),
    ];
    final pattern = RegExp(
      r'(?:^|[\s,{])action_id["\s:=]+([A-Za-z0-9._:-]+)',
      caseSensitive: false,
    );
    for (final value in candidates) {
      final match = pattern.firstMatch(value);
      if (match != null) {
        return _string(match.group(1));
      }
    }
    return '';
  }

  _ActionDeliveryStatus? _consoleDeliveryStatus(Map<dynamic, dynamic> entry) {
    final text =
        '${_string(entry['summary'])} ${_string(entry['detail'])} ${_string(entry['raw'])} ${_firstConsoleValue(entry, const ['payload', 'response'])}'
            .toLowerCase();
    if (text.contains('failed') ||
        text.contains('rejected') ||
        text.contains('denied') ||
        text.contains('blocked') ||
        text.contains('timeout') ||
        text.contains('timed out') ||
        text.contains('unavailable') ||
        text.contains('error')) {
      return _ActionDeliveryStatus.failed;
    }
    if (text.contains('completed') ||
        text.contains('delivered') ||
        text.contains('response received') ||
        text.contains('connected') ||
        text.contains('answered') ||
        text.contains('success')) {
      return _ActionDeliveryStatus.success;
    }
    if (text.contains('accepted') ||
        text.contains('queued') ||
        text.contains('dialing') ||
        text.contains('sent') ||
        text.contains('requested') ||
        text.contains('pending') ||
        text.contains('starting')) {
      return _ActionDeliveryStatus.pending;
    }
    return null;
  }

  String _buildDeliveryActionDetail(Map<dynamic, dynamic> state) {
    final metrics = _actionDeliveryMetrics(state);
    final success = metrics.success;
    final failure = metrics.failed;
    final queueDepth = metrics.pending;
    final total = success + failure + queueDepth;
    final failureRate = total == 0 ? 0 : ((failure / total) * 100).round();
    final actionEntries = metrics.recentEntries.take(18).toList(growable: false);
    final logText = actionEntries
        .map((entry) {
          final type = _consoleTypeLabel(_consoleType(entry)).toUpperCase();
          final level = _string(entry['level'], fallback: 'info').toUpperCase();
          final summary = _string(entry['summary'], fallback: 'Event');
          final detail = _string(entry['detail']);
          final timestamp = _string(entry['timestamp'], fallback: '--');
          return '[$timestamp] $type/$level  $summary${detail.isEmpty ? '' : '\n  $detail'}';
        })
        .join('\n\n');
    return 'summary\n'
        'failed         = $failure/$total ($failureRate%)\n'
        'success        = $success\n'
        'pending        = $queueDepth\n'
        'latest_event   = ${_latestConsoleSummary(state)}\n\n'
        'recent_actions\n'
        '${logText.isEmpty ? 'No dashboard action logs yet.' : logText}';
  }

  Future<void> _copyText(String value) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    _showSnack('Copied');
  }

  Future<void> _showSettingsSheet() async {
    final state = _state ?? const <dynamic, dynamic>{};
    final bridgeRunning = _bridgeRunning(state);
    final online = _bool(state['online']);
    final permissionsReady = _bool(state['permissionsReady']);
    final callFeatureReady = _bool(state['callFeatureReady']);
    final webcamFeatureReady = _bool(state['webcamFeatureReady']);
    final intercomFeatureReady = _bool(state['intercomFeatureReady']);
    final batteryOptimizationDisabled = _bool(
      state['batteryOptimizationDisabled'],
    );
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) {
        return Container(
          margin: const EdgeInsets.all(12),
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 14),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(24),
            boxShadow: const [
              BoxShadow(
                color: Color(0x190F172A),
                blurRadius: 24,
                offset: Offset(0, 14),
              ),
            ],
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [Color(0xFFF8FBFF), Color(0xFFF7FAFC)],
                  ),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: const Color(0xFFE2E8F0)),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 38,
                      height: 38,
                      decoration: BoxDecoration(
                        color: online
                            ? const Color(0xFFDCFCE7)
                            : const Color(0xFFE2E8F0),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Icon(
                        Icons.tune_rounded,
                        color: online
                            ? const Color(0xFF15803D)
                            : const Color(0xFF475569),
                        size: 20,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Setting',
                            style: TextStyle(
                              fontWeight: FontWeight.w900,
                              fontSize: 15,
                            ),
                          ),
                          Text(
                            online
                                ? 'Live bridge with optional controls.'
                                : 'Bridge access and protection controls.',
                            style: const TextStyle(
                              color: Color(0xFF64748B),
                              fontSize: 11.4,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 10),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 7,
                      ),
                      decoration: BoxDecoration(
                        color: online
                            ? const Color(0xFFDCFCE7)
                            : const Color(0xFFFFF7ED),
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(
                          color: online
                              ? const Color(0xFFBBF7D0)
                              : const Color(0xFFFED7AA),
                        ),
                      ),
                      child: Text(
                        online ? 'Online' : 'Review',
                        style: const TextStyle(
                          fontSize: 10.2,
                          fontWeight: FontWeight.w900,
                          color: Color(0xFF334155),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              const _SettingsSectionHeader(
                title: 'Feature activation',
                detail:
                    'Optional controls stay off until you activate them here.',
              ),
              const SizedBox(height: 8),
              _SettingsCompactRow(
                icon: Icons.call_rounded,
                accent: const Color(0xFF0F766E),
                title: 'Call controls',
                detail: callFeatureReady
                    ? 'Dashboard call actions are active.'
                    : 'Enable when dashboard needs call access.',
                actionLabel: callFeatureReady ? 'Active' : 'Activate',
                onTap: callFeatureReady
                    ? null
                    : () async {
                        Navigator.of(context).pop();
                        await _activateCallFeature();
                      },
              ),
              const SizedBox(height: 8),
              _SettingsCompactRow(
                icon: Icons.videocam_rounded,
                accent: const Color(0xFF0B5ED7),
                title: 'Webcam',
                detail: webcamFeatureReady
                    ? 'Camera access is active for dashboard webcam features.'
                    : 'Enable when dashboard needs camera access beyond QR setup.',
                actionLabel: webcamFeatureReady ? 'Active' : 'Activate',
                onTap: webcamFeatureReady
                    ? null
                    : () async {
                        Navigator.of(context).pop();
                        await _activateWebcamFeature();
                      },
              ),
              const SizedBox(height: 8),
              _SettingsCompactRow(
                icon: Icons.mic_rounded,
                accent: const Color(0xFF7C3AED),
                title: 'Intercom',
                detail: intercomFeatureReady
                    ? 'Microphone access is active for intercom features.'
                    : 'Enable when dashboard needs intercom microphone access.',
                actionLabel: intercomFeatureReady ? 'Active' : 'Activate',
                onTap: intercomFeatureReady
                    ? null
                    : () async {
                        Navigator.of(context).pop();
                        await _activateIntercomFeature();
                      },
              ),
              const SizedBox(height: 12),
              const _SettingsSectionHeader(
                title: 'Background protection',
                detail:
                    'Required for onboarding so the bridge keeps running in the background.',
              ),
              const SizedBox(height: 8),
              _SettingsCompactRow(
                icon: Icons.battery_charging_full_rounded,
                accent: const Color(0xFFCA8A04),
                title: 'Battery optimization',
                detail: batteryOptimizationDisabled
                    ? 'Background protection is disabled.'
                    : 'Allow the app to ignore battery optimization.',
                actionLabel: batteryOptimizationDisabled
                    ? 'Protected'
                    : 'Disable',
                onTap: batteryOptimizationDisabled
                    ? null
                    : () async {
                        Navigator.of(context).pop();
                        await _requestDisableBatteryOptimization();
                      },
              ),
              const SizedBox(height: 12),
              const _SettingsSectionHeader(
                title: 'Bridge controls',
                detail: 'Runtime actions and recovery.',
              ),
              const SizedBox(height: 2),
              _sheetAction(
                bridgeRunning ? Icons.pause_rounded : Icons.play_arrow_rounded,
                bridgeRunning ? 'Stop bridge' : 'Start bridge',
                () => _runAction(bridgeRunning ? 'stopBridge' : 'startBridge'),
              ),
              _sheetAction(
                Icons.restart_alt_rounded,
                'Reset bridge',
                _confirmResetOnboarding,
              ),
              if (!permissionsReady) ...[
                const SizedBox(height: 12),
                const _SettingsSectionHeader(
                  title: 'Core bridge access',
                  detail: 'Required permissions for bridge messaging.',
                ),
                const SizedBox(height: 2),
                _sheetAction(
                  Icons.verified_user_rounded,
                  'Review bridge access',
                  () => _channel.invokeMethod<dynamic>('openPermissionFlow'),
                ),
              ],
              _sheetAction(
                Icons.settings_outlined,
                'Open app settings',
                () => _channel.invokeMethod<dynamic>('openSystemSettings'),
              ),
            ],
          ),
          ),
        );
      },
    );
  }

  Widget _sheetAction(
    IconData icon,
    String label,
    Future<dynamic> Function() onTap,
  ) {
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Container(
        width: 38,
        height: 38,
        decoration: BoxDecoration(
          color: const Color(0xFFF1F5F9),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Icon(icon, color: const Color(0xFF0F172A), size: 20),
      ),
      title: Text(label, style: const TextStyle(fontWeight: FontWeight.w700)),
      onTap: () async {
        Navigator.of(context).pop();
        await onTap();
      },
    );
  }

  Future<void> _showConnectivityDialog(Map<dynamic, dynamic> state) async {
    final batteryLevel = state['batteryLevel'] == null
        ? 'Unknown'
        : '${_int(state['batteryLevel'])}%';
    final batteryStatus = _string(state['batteryStatus'], fallback: 'Unknown');
    final connectivityLines = _sanitizeConnectivityText(
      _string(state['connectionDetail']).isEmpty
          ? _string(state['connectionSummary'])
          : _string(state['connectionDetail']),
    );
    final fullDeviceInfo = _string(state['deviceInfoDetail']);
    final simCards = _extractSimCards(fullDeviceInfo);
    final deviceLines = fullDeviceInfo
        .split('\n')
        .where((line) {
          final trimmed = line.trim().toLowerCase();
          return trimmed.startsWith('manufacturer') ||
              trimmed.startsWith('model') ||
              trimmed.startsWith('android') ||
              trimmed.startsWith('operator') ||
              trimmed.startsWith('network_type') ||
              trimmed.startsWith('sim_state') ||
              trimmed.startsWith('sim_slots') ||
              trimmed.startsWith('slot_');
        })
        .join('\n');
    final readiness = _int(state['readinessScore']);
    final online = _bool(state['online']);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      useSafeArea: true,
      builder: (context) => _TabbedInsightSheet(
        title: 'Connectivity & Device',
        badge: online ? 'Online' : _string(state['bridgeState']),
        badgeColor: online ? const Color(0xFF16A34A) : const Color(0xFFF59E0B),
        accent: const Color(0xFF0B5ED7),
        tabs: [
          _InsightTabData(
            label: 'Overview',
            child: Column(
              children: [
                Row(
                  children: [
                    Expanded(
                      child: _InsightStatCard(
                        label: 'Transport',
                        value: _string(state['transport'], fallback: 'MQTT'),
                        hint: _string(
                          state['bridgeState'],
                          fallback: 'Stopped',
                        ),
                        color: const Color(0xFF0B5ED7),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _InsightStatCard(
                        label: 'Battery',
                        value: batteryLevel,
                        hint: batteryStatus,
                        color: const Color(0xFF0F766E),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: _InsightStatCard(
                        label: 'Readiness',
                        value: '$readiness%',
                        hint: _string(
                          state['readinessLabel'],
                          fallback: 'Needs setup',
                        ),
                        color: const Color(0xFF1D4ED8),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _InsightStatCard(
                        label: 'Last event',
                        value: _latestConsoleSummary(state),
                        hint: 'Latest bridge signal',
                        color: const Color(0xFF7C3AED),
                      ),
                    ),
                  ],
                ),
                if (simCards.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  _InsightSimSummaryPanel(cards: simCards),
                ],
                const SizedBox(height: 10),
                _InsightGraphPanel(
                  title: 'Power & readiness',
                  bars: [
                    _InsightBarData(
                      label: 'Battery',
                      value: state['batteryLevel'] == null
                          ? 0
                          : _int(state['batteryLevel']),
                      color: const Color(0xFF0F766E),
                    ),
                    _InsightBarData(
                      label: 'Readiness',
                      value: readiness,
                      color: const Color(0xFF0B5ED7),
                    ),
                  ],
                ),
              ],
            ),
          ),
          _InsightTabData(
            label: 'Link',
            child: _InsightCodePanel(
              title: 'Link state',
              value: connectivityLines.isEmpty
                  ? 'No link detail yet.'
                  : connectivityLines,
            ),
          ),
          _InsightTabData(
            label: 'Device',
            child: Column(
              children: [
                if (simCards.isNotEmpty) ...[
                  _InsightSimCardGrid(cards: simCards),
                  const SizedBox(height: 10),
                ],
                _InsightCodePanel(
                  title: 'Device detail',
                  value: deviceLines.isEmpty ? fullDeviceInfo : deviceLines,
                ),
              ],
            ),
          ),
        ],
        onCopy: () => _copyText(_buildOverviewDeviceDetail(state)),
      ),
    );
  }

  Future<void> _showQueueDialog(Map<dynamic, dynamic> state) async {
    final metrics = _actionDeliveryMetrics(state);
    final success = metrics.success;
    final failure = metrics.failed;
    final pending = metrics.pending;
    final total = success + failure + pending;
    final failureRate = total == 0 ? 0 : ((failure / total) * 100).round();
    final actionEntries = metrics.recentEntries;
    final recentActions = actionEntries
        .take(20)
        .map((entry) {
          final type = _consoleTypeLabel(_consoleType(entry)).toUpperCase();
          final level = _string(entry['level'], fallback: 'info').toUpperCase();
          final summary = _string(entry['summary'], fallback: 'Event');
          final detail = _string(entry['detail']);
          final stamp = _string(entry['timestamp'], fallback: '--');
          return '[$stamp] $type/$level  $summary${detail.isEmpty ? '' : '\n  $detail'}';
        })
        .join('\n\n');
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      useSafeArea: true,
      builder: (context) => _TabbedInsightSheet(
        title: 'Queue & Delivery',
        badge: total == 0 ? 'Idle' : '$failureRate% fail',
        badgeColor: failure == 0
            ? const Color(0xFF1D4ED8)
            : const Color(0xFFDC2626),
        accent: const Color(0xFF1D4ED8),
        tabs: [
          _InsightTabData(
            label: 'Summary',
            child: Column(
              children: [
                Row(
                  children: [
                    Expanded(
                      child: _InsightStatCard(
                        label: 'Success',
                        value: '$success',
                        hint: 'Delivered/published',
                        color: const Color(0xFF16A34A),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _InsightStatCard(
                        label: 'Pending',
                        value: '$pending',
                        hint: 'Still queued',
                        color: const Color(0xFFF59E0B),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _InsightStatCard(
                        label: 'Failed',
                        value: '$failure',
                        hint: '$failureRate% of total',
                        color: const Color(0xFFDC2626),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                _InsightGraphPanel(
                  title: 'Action flow',
                  bars: [
                    _InsightBarData(
                      label: 'Success',
                      value: total == 0 ? 0 : ((success / total) * 100).round(),
                      color: const Color(0xFF16A34A),
                    ),
                    _InsightBarData(
                      label: 'Pending',
                      value: total == 0 ? 0 : ((pending / total) * 100).round(),
                      color: const Color(0xFFF59E0B),
                    ),
                    _InsightBarData(
                      label: 'Failed',
                      value: total == 0 ? 0 : ((failure / total) * 100).round(),
                      color: const Color(0xFFDC2626),
                    ),
                  ],
                ),
              ],
            ),
          ),
          _InsightTabData(
            label: 'Flow',
            child: _InsightCodePanel(
              title: 'Action summary',
              value: _buildDeliveryActionDetail(state),
            ),
          ),
          _InsightTabData(
            label: 'Actions',
            child: _InsightCodePanel(
              title: 'Recent action log',
              value: recentActions.isEmpty
                  ? 'No dashboard action logs yet.'
                  : recentActions,
            ),
          ),
        ],
        onCopy: () => _copyText(_buildDeliveryActionDetail(state)),
      ),
    );
  }

  Future<void> _showConsoleDetail(Map<dynamic, dynamic> entry) async {
    final level = _string(entry['level'], fallback: 'info').toUpperCase();
    final type = _consoleTypeLabel(_consoleType(entry)).toUpperCase();
    await showDialog<void>(
      context: context,
      builder: (context) => _ConsoleEntryDialog(
        title: '$type / $level',
        timestamp: _string(entry['timestamp'], fallback: 'unknown'),
        summary: _string(entry['summary'], fallback: 'Event'),
        detail: _string(entry['detail']),
        payload: _firstConsoleValue(entry, const [
          'payload',
          'request',
          'requestPayload',
          'mqttPayload',
          'httpPayload',
        ]),
        response: _firstConsoleValue(entry, const [
          'response',
          'resultPayload',
          'responsePayload',
          'mqttResponse',
          'httpResponse',
        ]),
        onCopy: () => _copyText(_buildConsoleEntryDetail(entry)),
      ),
    );
  }

  String _buildConsoleEntryDetail(Map<dynamic, dynamic> entry) {
    final level = _string(entry['level'], fallback: 'info');
    final timestamp = _string(entry['timestamp'], fallback: 'unknown');
    final summary = _string(entry['summary'], fallback: 'Event');
    final detail = _string(entry['detail'], fallback: 'No detail text');
    final payload = _formatConsoleData(
      _firstConsoleValue(entry, const [
        'payload',
        'request',
        'requestPayload',
        'mqttPayload',
        'httpPayload',
      ]),
    );
    final response = _formatConsoleData(
      _firstConsoleValue(entry, const [
        'response',
        'result',
        'responsePayload',
        'mqttResponse',
        'httpResponse',
      ]),
    );

    final lines = <String>[
      'level   = $level',
      'type    = ${_consoleType(entry)}',
      if (_consoleSource(entry).isNotEmpty) 'source  = ${_consoleSource(entry)}',
      'time    = $timestamp',
      'summary = $summary',
      if (detail.isNotEmpty) 'detail  = $detail',
      if (payload.isNotEmpty) '\npayload\n$payload',
      if (response.isNotEmpty) '\nresponse\n$response',
    ];
    return lines.join('\n');
  }

  String _firstConsoleValue(Map<dynamic, dynamic> entry, List<String> keys) {
    for (final key in keys) {
      final value = _string(entry[key]);
      if (value.isNotEmpty) return value;
    }
    return '';
  }
}

class _BusyBar extends StatelessWidget {
  const _BusyBar({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Positioned(
      left: 12,
      right: 12,
      top: MediaQuery.of(context).padding.top + 10,
      child: Material(
        color: Colors.transparent,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          decoration: BoxDecoration(
            color: const Color(0xEE0F172A),
            borderRadius: BorderRadius.circular(999),
            boxShadow: const [
              BoxShadow(
                color: Color(0x260F172A),
                blurRadius: 18,
                offset: Offset(0, 8),
              ),
            ],
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Colors.white,
                ),
              ),
              const SizedBox(width: 9),
              Text(
                label,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 12.2,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PinnedTopBar extends StatelessWidget {
  const _PinnedTopBar({
    required this.title,
    required this.deviceId,
    required this.onMenuPressed,
    required this.onRefreshPressed,
  });

  final String title;
  final String deviceId;
  final VoidCallback onMenuPressed;
  final VoidCallback onRefreshPressed;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.97),
        borderRadius: BorderRadius.circular(15),
        border: Border.all(color: const Color(0xFFE2E8F0)),
        boxShadow: const [
          BoxShadow(
            color: Color(0x120F172A),
            blurRadius: 20,
            offset: Offset(0, 8),
          ),
        ],
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 14.2,
                    fontWeight: FontWeight.w900,
                    color: Color(0xFF0F172A),
                  ),
                ),
                const SizedBox(height: 1),
                Text(
                  deviceId,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 10,
                    color: Color(0xFF64748B),
                  ),
                ),
              ],
            ),
          ),
          Container(
            width: 1,
            height: 24,
            margin: const EdgeInsets.symmetric(horizontal: 8),
            color: const Color(0xFFE2E8F0),
          ),
          const SizedBox(width: 8),
          _SurfaceIconButton(
            label: 'Refresh dashboard state',
            icon: Icons.refresh_rounded,
            onTap: onRefreshPressed,
          ),
          Container(
            width: 1,
            height: 18,
            margin: const EdgeInsets.symmetric(horizontal: 8),
            color: const Color(0xFFE2E8F0),
          ),
          _SurfaceIconButton(
            label: 'Open bridge controls',
            icon: Icons.grid_view_rounded,
            onTap: onMenuPressed,
          ),
        ],
      ),
    );
  }
}

class _SurfaceIconButton extends StatelessWidget {
  const _SurfaceIconButton({
    required this.label,
    required this.icon,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: label,
      child: Semantics(
        label: label,
        button: true,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(14),
            child: Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: const Color(0xFFF8FAFC),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: const Color(0xFFE2E8F0)),
              ),
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 180),
                switchInCurve: Curves.easeOutCubic,
                switchOutCurve: Curves.easeInCubic,
                child: Icon(
                  icon,
                  key: ValueKey(icon),
                  size: 18,
                  color: const Color(0xFF0F172A),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _QuickActionStrip extends StatelessWidget {
  const _QuickActionStrip({required this.actions});

  final List<_MiniAction> actions;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 41,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: const Color(0xFFF8FAFC),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0xFFE2E8F0)),
        ),
        child: ListView.separated(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
          scrollDirection: Axis.horizontal,
          itemCount: actions.length,
          separatorBuilder: (context, index) => const Center(
            child: SizedBox(
              width: 12,
              child: VerticalDivider(
                color: Color(0xFFE2E8F0),
                thickness: 1,
                width: 12,
                indent: 7,
                endIndent: 7,
              ),
            ),
          ),
          itemBuilder: (context, index) {
            final action = actions[index];
            return TweenAnimationBuilder<double>(
              tween: Tween(begin: 0.96, end: 1),
              duration: Duration(milliseconds: 180 + (index * 40)),
              curve: Curves.easeOutCubic,
              builder: (context, value, child) => Transform.scale(
                scale: value,
                child: Opacity(opacity: value.clamp(0.0, 1.0), child: child),
              ),
              child: InkWell(
                onTap: action.onTap,
                borderRadius: BorderRadius.circular(12),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0xFF0F172A),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: const Color(0xFF0F172A)),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(action.icon, size: 15, color: Colors.white),
                      const SizedBox(width: 6),
                      Text(
                        action.label,
                        style: const TextStyle(
                          fontWeight: FontWeight.w800,
                          fontSize: 10.8,
                          color: Colors.white,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _InsightTabData {
  const _InsightTabData({required this.label, required this.child});

  final String label;
  final Widget child;
}

class _InsightBarData {
  const _InsightBarData({
    required this.label,
    required this.value,
    required this.color,
  });

  final String label;
  final int value;
  final Color color;
}

class _TabbedInsightSheet extends StatelessWidget {
  const _TabbedInsightSheet({
    required this.title,
    required this.badge,
    required this.badgeColor,
    required this.accent,
    required this.tabs,
    required this.onCopy,
  });

  final String title;
  final String badge;
  final Color badgeColor;
  final Color accent;
  final List<_InsightTabData> tabs;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: tabs.length,
      child: FractionallySizedBox(
        heightFactor: 0.88,
        child: Container(
          margin: const EdgeInsets.fromLTRB(12, 12, 12, 8),
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 14),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(26),
            boxShadow: const [
              BoxShadow(
                color: Color(0x190F172A),
                blurRadius: 24,
                offset: Offset(0, 16),
              ),
            ],
          ),
          child: Column(
            children: [
              Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: const Color(0xFFE2E8F0),
                  borderRadius: BorderRadius.circular(999),
                ),
              ),
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [
                      accent.withValues(alpha: 0.16),
                      accent.withValues(alpha: 0.05),
                    ],
                  ),
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: accent.withValues(alpha: 0.24)),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                          const SizedBox(height: 2),
                          const Text(
                            'Grouped live detail for quick review.',
                            style: TextStyle(
                              fontSize: 10.8,
                              color: Color(0xFF475569),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 5,
                      ),
                      decoration: BoxDecoration(
                        color: badgeColor.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(
                          color: badgeColor.withValues(alpha: 0.3),
                        ),
                      ),
                      child: Text(
                        badge,
                        style: TextStyle(
                          color: badgeColor,
                          fontSize: 10.2,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                    const SizedBox(width: 4),
                    IconButton(
                      tooltip: 'Copy',
                      onPressed: onCopy,
                      icon: const Icon(Icons.copy_all_rounded),
                      visualDensity: VisualDensity.compact,
                    ),
                    IconButton(
                      tooltip: 'Close',
                      onPressed: () => Navigator.of(context).pop(),
                      icon: const Icon(Icons.close_rounded),
                      visualDensity: VisualDensity.compact,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerLeft,
                child: TabBar(
                  isScrollable: true,
                  tabAlignment: TabAlignment.start,
                  labelColor: accent,
                  unselectedLabelColor: const Color(0xFF64748B),
                  indicatorColor: accent,
                  indicatorWeight: 2.4,
                  labelStyle: const TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 11.4,
                  ),
                  tabs: [for (final tab in tabs) Tab(text: tab.label)],
                ),
              ),
              const SizedBox(height: 10),
              Expanded(
                child: TabBarView(
                  children: [
                    for (final tab in tabs)
                      SingleChildScrollView(child: tab.child),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _InsightSimCardData {
  const _InsightSimCardData({
    required this.slotLabel,
    required this.title,
    required this.number,
    required this.carrier,
    required this.state,
  });

  final String slotLabel;
  final String title;
  final String number;
  final String carrier;
  final String state;
}

class _InsightSimCardGrid extends StatelessWidget {
  const _InsightSimCardGrid({required this.cards});

  final List<_InsightSimCardData> cards;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [for (final card in cards) _InsightSimCard(card: card)],
    );
  }
}

class _InsightSimCard extends StatelessWidget {
  const _InsightSimCard({required this.card});

  final _InsightSimCardData card;

  @override
  Widget build(BuildContext context) {
    final width = (MediaQuery.of(context).size.width - 44) / 2;
    return Container(
      width: width < 152 ? double.infinity : width,
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                card.slotLabel,
                style: const TextStyle(
                  fontSize: 10.4,
                  fontWeight: FontWeight.w900,
                  color: Color(0xFF0B5ED7),
                ),
              ),
              const Spacer(),
              Text(
                card.state,
                style: const TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF64748B),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            card.number.isEmpty ? 'Number unavailable' : card.number,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 12.4,
              fontWeight: FontWeight.w900,
              color: Color(0xFF0F172A),
            ),
          ),
          const SizedBox(height: 3),
          Text(
            card.title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 10.4,
              fontWeight: FontWeight.w700,
              color: Color(0xFF334155),
            ),
          ),
          if (card.carrier.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(
              card.carrier,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 10.2, color: Color(0xFF64748B)),
            ),
          ],
        ],
      ),
    );
  }
}

class _InsightSimSummaryPanel extends StatelessWidget {
  const _InsightSimSummaryPanel({required this.cards});

  final List<_InsightSimCardData> cards;

  @override
  Widget build(BuildContext context) {
    final visibleCards = cards
        .where((card) => card.number.trim().isNotEmpty)
        .toList(growable: false);
    if (visibleCards.isEmpty) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: const Color(0xFFFFFBEB),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0xFFFDE68A)),
        ),
        child: const Text(
          'SIM numbers unavailable. Android may hide them for this carrier.',
          style: TextStyle(
            fontSize: 10.8,
            fontWeight: FontWeight.w700,
            color: Color(0xFF92400E),
          ),
        ),
      );
    }
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'SIM numbers',
            style: TextStyle(
              fontSize: 10.2,
              fontWeight: FontWeight.w900,
              color: Color(0xFF0B5ED7),
            ),
          ),
          const SizedBox(height: 7),
          Wrap(
            spacing: 7,
            runSpacing: 7,
            children: [
              for (final card in visibleCards)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 9,
                    vertical: 7,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: const Color(0xFFE2E8F0)),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        card.slotLabel,
                        style: const TextStyle(
                          fontSize: 9.8,
                          fontWeight: FontWeight.w900,
                          color: Color(0xFF64748B),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        card.number,
                        style: const TextStyle(
                          fontSize: 11.2,
                          fontWeight: FontWeight.w900,
                          color: Color(0xFF0F172A),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _InsightStatCard extends StatelessWidget {
  const _InsightStatCard({
    required this.label,
    required this.value,
    required this.hint,
    required this.color,
  });

  final String label;
  final String value;
  final String hint;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w800,
              color: color,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            value,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w900,
              color: Color(0xFF0F172A),
            ),
          ),
          const SizedBox(height: 3),
          Text(
            hint,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 10.1, color: Color(0xFF64748B)),
          ),
        ],
      ),
    );
  }
}

class _InsightGraphPanel extends StatelessWidget {
  const _InsightGraphPanel({required this.title, required this.bars});

  final String title;
  final List<_InsightBarData> bars;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF0B1220),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFF172033)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 12,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 10),
          for (var i = 0; i < bars.length; i++) ...[
            if (i > 0) const SizedBox(height: 8),
            _InsightGraphBar(data: bars[i]),
          ],
        ],
      ),
    );
  }
}

class _InsightGraphBar extends StatelessWidget {
  const _InsightGraphBar({required this.data});

  final _InsightBarData data;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                data.label,
                style: const TextStyle(
                  color: Color(0xFFCBD5E1),
                  fontSize: 10.4,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            Text(
              '${data.value}%',
              style: const TextStyle(
                color: Color(0xFFE2E8F0),
                fontSize: 10.4,
                fontWeight: FontWeight.w800,
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(99),
          child: LinearProgressIndicator(
            minHeight: 6,
            value: (data.value.clamp(0, 100)) / 100,
            backgroundColor: const Color(0xFF172033),
            valueColor: AlwaysStoppedAnimation<Color>(data.color),
          ),
        ),
      ],
    );
  }
}

class _InsightCodePanel extends StatelessWidget {
  const _InsightCodePanel({required this.title, required this.value});

  final String title;
  final String value;

  @override
  Widget build(BuildContext context) {
    return _ConsoleDetailBlock(
      title: title,
      value: value,
      scrollable: true,
      bodyHeight: MediaQuery.of(context).size.height * 0.46,
    );
  }
}

class _ConsoleEntryDialog extends StatelessWidget {
  const _ConsoleEntryDialog({
    required this.title,
    required this.timestamp,
    required this.summary,
    required this.detail,
    required this.payload,
    required this.response,
    required this.onCopy,
  });

  final String title;
  final String timestamp;
  final String summary;
  final String detail;
  final String payload;
  final String response;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    final formattedPayload = _formatConsoleData(payload);
    final formattedResponse = _formatConsoleData(response);
    final dialogMaxHeight = MediaQuery.of(context).size.height * 0.76;
    final detailBlockCount = [
      formattedPayload.trim(),
      formattedResponse.trim(),
    ].where((value) => value.isNotEmpty).length;
    final detailBlockHeight = detailBlockCount == 0
        ? 0.0
        : ((dialogMaxHeight - 210 - ((detailBlockCount - 1) * 8)) /
                  detailBlockCount)
              .clamp(132.0, 188.0)
              .toDouble();
    final blocks = <Widget>[
      _ConsoleDetailBlock(
        title: 'Event',
        value: [
          summary,
          if (detail.trim().isNotEmpty) detail.trim(),
          timestamp,
        ].join('\n'),
        scrollable: false,
      ),
      if (formattedPayload.trim().isNotEmpty)
        _ConsoleDetailBlock(
          title: 'Payload',
          value: formattedPayload,
          scrollable: true,
          bodyHeight: detailBlockHeight,
        ),
      if (formattedResponse.trim().isNotEmpty)
        _ConsoleDetailBlock(
          title: 'Response',
          value: formattedResponse,
          scrollable: true,
          bodyHeight: detailBlockHeight,
        ),
    ];
    return Dialog(
      insetPadding: const EdgeInsets.all(18),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.76,
        ),
        child: Padding(
          padding: const EdgeInsets.all(15),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Copy event',
                    onPressed: onCopy,
                    icon: const Icon(Icons.copy_all_rounded),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Flexible(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (var index = 0; index < blocks.length; index++) ...[
                      if (index > 0) const SizedBox(height: 8),
                      blocks[index],
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ConsoleDetailBlock extends StatefulWidget {
  const _ConsoleDetailBlock({
    required this.title,
    required this.value,
    required this.scrollable,
    this.bodyHeight,
  });

  final String title;
  final String value;
  final bool scrollable;
  final double? bodyHeight;

  @override
  State<_ConsoleDetailBlock> createState() => _ConsoleDetailBlockState();
}

class _ConsoleDetailBlockState extends State<_ConsoleDetailBlock> {
  late final ScrollController _scrollController;

  @override
  void initState() {
    super.initState();
    _scrollController = ScrollController();
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: const Color(0xFF0B1220),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF172033)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  widget.title,
                  style: const TextStyle(
                    color: Color(0xFF94A3B8),
                    fontSize: 10.5,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 0.5,
                  ),
                ),
              ),
              InkWell(
                borderRadius: BorderRadius.circular(10),
                onTap: () async {
                  await Clipboard.setData(ClipboardData(text: widget.value));
                  if (!context.mounted) return;
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text('${widget.title} copied'),
                      duration: const Duration(milliseconds: 900),
                    ),
                  );
                },
                child: const Padding(
                  padding: EdgeInsets.all(2),
                  child: Icon(
                    Icons.copy_all_rounded,
                    size: 15,
                    color: Color(0xFF94A3B8),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          if (widget.scrollable)
            SizedBox(
              height: widget.bodyHeight ?? 160,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: const Color(0xFF020617),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFF1E293B)),
                ),
                child: Scrollbar(
                  controller: _scrollController,
                  thumbVisibility: true,
                  interactive: true,
                  child: ListView(
                    controller: _scrollController,
                    padding: const EdgeInsets.all(10),
                    physics: const ClampingScrollPhysics(),
                    children: [
                      SelectableText(
                        widget.value,
                        style: const TextStyle(
                          color: Color(0xFFE2E8F0),
                          fontFamily: 'monospace',
                          fontSize: 11.7,
                          height: 1.35,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            )
          else
            DecoratedBox(
              decoration: BoxDecoration(
                color: const Color(0xFF020617),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: const Color(0xFF1E293B)),
              ),
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: SelectableText(
                  widget.value,
                  style: const TextStyle(
                    color: Color(0xFFE2E8F0),
                    fontFamily: 'monospace',
                    fontSize: 11.7,
                    height: 1.35,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _OverviewPanel extends StatelessWidget {
  const _OverviewPanel({
    required this.online,
    required this.bridgeState,
    required this.transport,
    required this.callStatus,
    required this.callDirection,
    required this.callNumber,
    required this.readinessScore,
    required this.readinessLabel,
    required this.retryLabel,
    required this.batteryLevel,
    required this.batteryStatus,
    required this.queueDepth,
    required this.publishSuccess,
    required this.publishFailure,
    required this.onDeviceTap,
    required this.onQueueTap,
    required this.footerActions,
  });

  final bool online;
  final String bridgeState;
  final String transport;
  final String callStatus;
  final String callDirection;
  final String callNumber;
  final int readinessScore;
  final String readinessLabel;
  final String retryLabel;
  final int? batteryLevel;
  final String batteryStatus;
  final int queueDepth;
  final int publishSuccess;
  final int publishFailure;
  final VoidCallback onDeviceTap;
  final VoidCallback onQueueTap;
  final List<_MiniAction> footerActions;

  @override
  Widget build(BuildContext context) {
    final deliveryTotal = publishSuccess + publishFailure + queueDepth;
    final batteryProgress = batteryLevel == null
        ? 0.0
        : (batteryLevel!.clamp(0, 100)) / 100;
    final successUnits = publishSuccess.toDouble();
    final pendingUnits = queueDepth.toDouble();
    final failedUnits = publishFailure.toDouble();
    final successRate = deliveryTotal <= 0
        ? 0
        : ((publishSuccess / deliveryTotal) * 100).round();
    final protocolLabel = transport.toUpperCase();
    final normalizedCallStatus = callStatus.trim().toLowerCase();
    final normalizedCallDirection = callDirection.trim().toLowerCase();
    final headline = online
        ? 'Bridge ready'
        : bridgeState.toLowerCase().contains('connect')
        ? 'Reconnecting'
        : 'Bridge offline';
    final helper = online
        ? '$protocolLabel live • $readinessLabel'
        : 'Retry active • next $retryLabel';
    final badgeLabel = online
        ? 'Online'
        : bridgeState.toLowerCase().contains('connect')
        ? 'Connecting'
        : 'Offline';
    final connectivityText = online
        ? '$protocolLabel Online'
        : bridgeState.toLowerCase().contains('connect')
        ? '$protocolLabel Connecting'
        : '$protocolLabel Offline';
    final powerText = batteryLevel == null
        ? 'Battery pending • $batteryStatus'
        : '$batteryLevel% battery • $batteryStatus';
    final hasCallState = normalizedCallStatus.isNotEmpty;
    final callAccent = switch (normalizedCallStatus) {
      'ringing' => const Color(0xFFF59E0B),
      'dialing' => const Color(0xFF2563EB),
      'connected' || 'answered' => const Color(0xFF16A34A),
      'ended' || 'missed' || 'rejected' => const Color(0xFF64748B),
      _ => const Color(0xFF0F766E),
    };
    final callLabel = normalizedCallStatus.isEmpty
        ? ''
        : '${normalizedCallStatus.substring(0, 1).toUpperCase()}${normalizedCallStatus.substring(1)}';
    final callHint = [
      if (normalizedCallDirection.isNotEmpty)
        '${normalizedCallDirection.substring(0, 1).toUpperCase()}${normalizedCallDirection.substring(1)}',
      if (callNumber.trim().isNotEmpty) callNumber.trim(),
    ].join(' • ');
    // ignore: unused_local_variable
    final queueText = deliveryTotal <= 0
        ? 'No action backlog'
        : '$successRate% success';
    // ignore: unused_local_variable
    final queueHint = deliveryTotal <= 0
        ? 'Waiting for dashboard actions'
        : '${_compactCount(publishSuccess)} sent / ${_compactCount(queueDepth)} pending / ${_compactCount(publishFailure)} failed';

    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 10),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFFFFFFFF), Color(0xFFF7FAFF)],
        ),
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: const Color(0xFFE2E8F0)),
        boxShadow: const [
          BoxShadow(
            color: Color(0x120F172A),
            blurRadius: 18,
            offset: Offset(0, 10),
          ),
        ],
      ),
      child: Column(
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(12, 11, 12, 10),
            decoration: BoxDecoration(
              color: const Color(0xFFF8FAFC),
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: const Color(0xFFE2E8F0)),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        headline,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w900,
                          color: Color(0xFF0F172A),
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        helper,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 10.9,
                          height: 1.25,
                          color: Color(0xFF64748B),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 7,
                  ),
                  decoration: BoxDecoration(
                    color: online
                        ? const Color(0xFFDCFCE7)
                        : const Color(0xFFFFF7ED),
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(
                      color: online
                          ? const Color(0xFFBBF7D0)
                          : const Color(0xFFFED7AA),
                    ),
                  ),
                  child: Text(
                    badgeLabel,
                    style: const TextStyle(
                      fontSize: 10.2,
                      fontWeight: FontWeight.w900,
                      color: Color(0xFF334155),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          if (hasCallState) ...[
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(10, 9, 10, 9),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [Colors.white, callAccent.withValues(alpha: 0.08)],
                ),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: callAccent.withValues(alpha: 0.22)),
              ),
              child: Row(
                children: [
                  Container(
                    width: 30,
                    height: 30,
                    decoration: BoxDecoration(
                      color: callAccent.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Icon(
                      normalizedCallStatus == 'ringing'
                          ? Icons.call_rounded
                          : normalizedCallStatus == 'missed'
                          ? Icons.call_missed_rounded
                          : normalizedCallStatus == 'ended' ||
                                  normalizedCallStatus == 'rejected'
                          ? Icons.call_end_rounded
                          : Icons.phone_in_talk_rounded,
                      size: 16,
                      color: callAccent,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Call • $callLabel',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 11.8,
                            fontWeight: FontWeight.w900,
                            color: Color(0xFF0F172A),
                          ),
                        ),
                        if (callHint.isNotEmpty) ...[
                          const SizedBox(height: 2),
                          Text(
                            callHint,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 10.6,
                              color: Color(0xFF64748B),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],
          Row(
            children: [
              Expanded(
                child: _OverviewMiniStat(
                  icon: Icons.devices_rounded,
                  label: 'Connectivity & Device',
                  value: connectivityText,
                  hint: powerText,
                  color: online
                      ? const Color(0xFF16A34A)
                      : const Color(0xFFF59E0B),
                  progress: batteryProgress,
                  progressLabel: 'Power',
                  onTap: onDeviceTap,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _OverviewMiniStat(
                  icon: Icons.sync_alt_rounded,
                  label: 'Queue & Delivery',
                  value: queueText,
                  hint: queueHint,
                  color: publishFailure > 0
                      ? const Color(0xFFDC2626)
                      : queueDepth > 0
                      ? const Color(0xFFF59E0B)
                      : const Color(0xFF16A34A),
                  progress: deliveryTotal <= 0
                      ? 0.0
                      : successUnits / deliveryTotal,
                  progressLabel: 'Delivery',
                  onTap: onQueueTap,
                  secondaryProgress: pendingUnits,
                  tertiaryProgress: failedUnits,
                  totalUnits: deliveryTotal.toDouble(),
                  successColorOverride: const Color(0xFF16A34A),
                  secondaryColor: const Color(0xFFF59E0B),
                  tertiaryColor: const Color(0xFFDC2626),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          const Divider(height: 1, color: Color(0xFFE2E8F0)),
          const SizedBox(height: 8),
          _QuickActionStrip(actions: footerActions),
        ],
      ),
    );
  }
}

class _OverviewMiniStat extends StatelessWidget {
  const _OverviewMiniStat({
    required this.icon,
    required this.label,
    required this.value,
    required this.hint,
    required this.color,
    required this.progress,
    required this.progressLabel,
    required this.onTap,
    this.secondaryProgress,
    this.tertiaryProgress,
    this.totalUnits,
    this.successColorOverride,
    this.secondaryColor,
    this.tertiaryColor,
  });

  final IconData icon;
  final String label;
  final String value;
  final String hint;
  final Color color;
  final double progress;
  final String progressLabel;
  final VoidCallback onTap;
  final double? secondaryProgress;
  final double? tertiaryProgress;
  final double? totalUnits;
  final Color? successColorOverride;
  final Color? secondaryColor;
  final Color? tertiaryColor;

  @override
  Widget build(BuildContext context) {
    final useSegments =
        totalUnits != null &&
        totalUnits! > 0 &&
        secondaryProgress != null &&
        tertiaryProgress != null;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0.985, end: 1),
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      builder: (context, valueScale, child) => Transform.scale(
        scale: valueScale,
        child: Opacity(opacity: valueScale.clamp(0.0, 1.0), child: child),
      ),
      child: Semantics(
        button: true,
        label: '$label, $value',
        onTap: onTap,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(18),
            child: Ink(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [Colors.white, color.withValues(alpha: 0.05)],
                ),
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: color.withValues(alpha: 0.18)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 26,
                        height: 26,
                        decoration: BoxDecoration(
                          color: color.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Icon(icon, size: 14, color: color),
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 10.4,
                            fontWeight: FontWeight.w800,
                            color: Color(0xFF475569),
                          ),
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 5,
                          vertical: 3,
                        ),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF8FAFC),
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: const Color(0xFFE2E8F0)),
                        ),
                        child: const Icon(
                          Icons.open_in_full_rounded,
                          size: 11,
                          color: Color(0xFF64748B),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 7),
                  Text(
                    value,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 13.3,
                      fontWeight: FontWeight.w900,
                      color: Color(0xFF0F172A),
                    ),
                  ),
                  const SizedBox(height: 5),
                  if (useSegments)
                    _SegmentedProgressBar(
                      successUnits: (progress * totalUnits!).clamp(
                        0.0,
                        totalUnits!,
                      ),
                      pendingUnits: secondaryProgress!,
                      failedUnits: tertiaryProgress!,
                      totalUnits: totalUnits!,
                      successColor: successColorOverride ?? color,
                      pendingColor: secondaryColor ?? const Color(0xFFF59E0B),
                      failedColor: tertiaryColor ?? const Color(0xFFDC2626),
                    )
                  else
                    _AnimatedProgressBar(progress: progress, color: color),
                  const SizedBox(height: 6),
                  SizedBox(
                    height: 34,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          progressLabel,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 9.6,
                            fontWeight: FontWeight.w800,
                            color: Color(0xFF64748B),
                          ),
                        ),
                        const SizedBox(height: 2),
                        Expanded(
                          child: Text(
                            hint,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 10.1,
                              color: Color(0xFF64748B),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AnimatedProgressBar extends StatelessWidget {
  const _AnimatedProgressBar({required this.progress, required this.color});

  final double progress;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: progress.clamp(0.0, 1.0)),
      duration: const Duration(milliseconds: 320),
      curve: Curves.easeOutCubic,
      builder: (context, value, _) => ClipRRect(
        borderRadius: BorderRadius.circular(99),
        child: LinearProgressIndicator(
          minHeight: 4,
          value: value,
          backgroundColor: const Color(0xFFE2E8F0),
          valueColor: AlwaysStoppedAnimation<Color>(color),
        ),
      ),
    );
  }
}

class _SegmentedProgressBar extends StatelessWidget {
  const _SegmentedProgressBar({
    required this.successUnits,
    required this.pendingUnits,
    required this.failedUnits,
    required this.totalUnits,
    required this.successColor,
    required this.pendingColor,
    required this.failedColor,
  });

  final double successUnits;
  final double pendingUnits;
  final double failedUnits;
  final double totalUnits;
  final Color successColor;
  final Color pendingColor;
  final Color failedColor;

  @override
  Widget build(BuildContext context) {
    final safeTotal = totalUnits <= 0 ? 1.0 : totalUnits;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: const Duration(milliseconds: 360),
      curve: Curves.easeOutCubic,
      builder: (context, animationValue, _) => Container(
        height: 4,
        decoration: BoxDecoration(
          color: const Color(0xFFE2E8F0),
          borderRadius: BorderRadius.circular(999),
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(
          children: [
            if (successUnits > 0)
              Expanded(
                flex: (((successUnits / safeTotal) * 1000) * animationValue)
                    .round()
                    .clamp(1, 1000),
                child: ColoredBox(color: successColor),
              ),
            if (pendingUnits > 0)
              Expanded(
                flex: (((pendingUnits / safeTotal) * 1000) * animationValue)
                    .round()
                    .clamp(1, 1000),
                child: ColoredBox(color: pendingColor),
              ),
            if (failedUnits > 0)
              Expanded(
                flex: (((failedUnits / safeTotal) * 1000) * animationValue)
                    .round()
                    .clamp(1, 1000),
                child: ColoredBox(color: failedColor),
              ),
            if (successUnits <= 0 && pendingUnits <= 0 && failedUnits <= 0)
              const Expanded(child: ColoredBox(color: Color(0xFFCBD5E1))),
          ],
        ),
      ),
    );
  }
}

class _ConsoleCard extends StatelessWidget {
  const _ConsoleCard({
    required this.bodyHeight,
    required this.queryController,
    required this.selectedCategory,
    required this.onCategoryChanged,
    required this.categoryOptions,
    required this.selectedFilter,
    required this.onFilterChanged,
    required this.levelOptions,
    required this.onChanged,
    required this.onCopy,
    required this.onClear,
    required this.entries,
    required this.onTapEntry,
  });

  final double bodyHeight;
  final TextEditingController queryController;
  final String selectedCategory;
  final ValueChanged<String> onCategoryChanged;
  final Map<String, String> categoryOptions;
  final String selectedFilter;
  final ValueChanged<String> onFilterChanged;
  final Map<String, String> levelOptions;
  final ValueChanged<String> onChanged;
  final VoidCallback onCopy;
  final VoidCallback onClear;
  final List<Map<dynamic, dynamic>> entries;
  final ValueChanged<Map<dynamic, dynamic>> onTapEntry;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: const Color(0xFF0B1220),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF172033)),
      ),
      child: Column(
        children: [
          Row(
            children: [
              const Expanded(
                child: Text(
                  'Operations Console',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 12.4,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              _consoleUtility('Copy console', Icons.copy_all_rounded, onCopy),
              const SizedBox(width: 4),
              _consoleUtility(
                'Clear console',
                Icons.cleaning_services_rounded,
                onClear,
              ),
            ],
          ),
          const SizedBox(height: 6),
          Semantics(
            label: 'Search console events',
            textField: true,
            child: SizedBox(
              height: 32,
              child: TextField(
                controller: queryController,
                onChanged: onChanged,
                style: const TextStyle(color: Colors.white, fontSize: 10.9),
                decoration: InputDecoration(
                  hintText: 'Search SMS, call, USSD, HTTP',
                  hintStyle: const TextStyle(
                    color: Color(0xFF94A3B8),
                    fontSize: 10.4,
                  ),
                  filled: true,
                  fillColor: const Color(0xFF111827),
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 9,
                    vertical: 4,
                  ),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(11),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 5),
          Row(
            children: [
              Expanded(
                child: _consoleDropdown(
                  label: 'Type',
                  value: selectedCategory,
                  options: categoryOptions,
                  onChanged: onCategoryChanged,
                  accent: const Color(0xFF0F766E),
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: _consoleDropdown(
                  label: 'Level',
                  value: selectedFilter,
                  options: levelOptions,
                  onChanged: onFilterChanged,
                  accent: const Color(0xFF1D4ED8),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 240),
            switchInCurve: Curves.easeOutCubic,
            switchOutCurve: Curves.easeInCubic,
            transitionBuilder: (child, animation) => FadeTransition(
              opacity: animation,
              child: SizeTransition(
                sizeFactor: animation,
                axisAlignment: -1,
                child: child,
              ),
            ),
            child: Container(
              key: ValueKey(
                '${entries.length}-${entries.isEmpty ? 'empty' : _string(entries.first['timestamp'])}',
              ),
              constraints: BoxConstraints(
                minHeight: 156,
                maxHeight: bodyHeight,
              ),
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                color: const Color(0xFF111827),
                borderRadius: BorderRadius.circular(14),
              ),
              child: entries.isEmpty
                  ? const Center(
                      child: Text(
                        'No device operation events in the current filter.',
                        style: TextStyle(color: Color(0xFF94A3B8)),
                      ),
                    )
                  : ListView.separated(
                      itemCount: entries.length,
                      separatorBuilder: (_, separatorIndex) =>
                          const Divider(height: 1, color: Color(0xFF1F2937)),
                      itemBuilder: (context, index) {
                        final entry = entries[index];
                        final level = _string(entry['level'], fallback: 'info');
                        final type = _string(
                          entry['type'],
                          fallback: _inferConsoleType(entry),
                        );
                        final levelColor = switch (level) {
                          'error' => const Color(0xFFF87171),
                          'warn' => const Color(0xFFFBBF24),
                          _ => const Color(0xFF60A5FA),
                        };
                        return ListTile(
                          dense: true,
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 7,
                            vertical: 2,
                          ),
                          minVerticalPadding: 6,
                          onTap: () => onTapEntry(entry),
                          title: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  _string(entry['summary']),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontWeight: FontWeight.w700,
                                    fontSize: 11.1,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 4),
                              _LogBadge(
                                label: _typeLabel(type),
                                color: const Color(0xFF14B8A6),
                              ),
                              const SizedBox(width: 3),
                              _LogBadge(
                                label: level.toUpperCase(),
                                color: levelColor,
                              ),
                            ],
                          ),
                          subtitle: Text(
                            '${_string(entry['timestamp'])}  ${_string(entry['detail'])}',
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: Color(0xFF94A3B8),
                              fontSize: 10.1,
                            ),
                          ),
                        );
                      },
                    ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _consoleDropdown({
    required String label,
    required String value,
    required Map<String, String> options,
    required ValueChanged<String> onChanged,
    required Color accent,
  }) {
    return DropdownButtonFormField<String>(
      initialValue: value,
      isDense: true,
      dropdownColor: const Color(0xFF111827),
      iconEnabledColor: const Color(0xFFE2E8F0),
      style: const TextStyle(
        color: Colors.white,
        fontWeight: FontWeight.w800,
        fontSize: 12,
      ),
      decoration: InputDecoration(
        labelText: label,
        labelStyle: const TextStyle(
          color: Color(0xFF94A3B8),
          fontWeight: FontWeight.w800,
          fontSize: 10.2,
        ),
        filled: true,
        fillColor: const Color(0xFF111827),
        contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: accent.withValues(alpha: 0.45)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: accent, width: 1.4),
        ),
      ),
      items: [
        for (final option in options.entries)
          DropdownMenuItem<String>(
            value: option.key,
            child: Text(
              option.value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
      ],
      onChanged: (next) {
        if (next != null) {
          onChanged(next);
        }
      },
    );
  }

  String _inferConsoleType(Map<dynamic, dynamic> entry) {
    final text =
        '${_string(entry['summary'])} ${_string(entry['detail'])} ${_string(entry['raw'])}'
            .toLowerCase();
    if (text.contains('/status') ||
        text.contains('telemetry') ||
        text.contains('status push')) {
      return 'telemetry';
    }
    if (text.contains('sms') || text.contains('message')) return 'sms';
    if (text.contains('ussd')) return 'ussd';
    if (text.contains('call') || text.contains('dial')) return 'call';
    if (text.contains('internet') || text.contains('hotspot')) {
      return 'internet';
    }
    if (text.contains('mqtt')) return 'mqtt';
    if (text.contains('http')) return 'http';
    if (text.contains('queue') || text.contains('publish')) return 'queue';
    if (text.contains('setup') || text.contains('onboard')) return 'setup';
    return 'system';
  }

  String _typeLabel(String type) {
    final normalized = type.trim().toLowerCase();
    return switch (normalized) {
      'sms' => 'SMS',
      'ussd' => 'USSD',
      'mqtt' => 'MQTT',
      'http' => 'HTTP',
      'internet' => 'NET',
      'telemetry' => 'TLM',
      'call' => 'CALL',
      'queue' => 'QUEUE',
      'setup' => 'SETUP',
      'system' => 'SYS',
      _ => normalized.isEmpty ? 'SYS' : normalized.toUpperCase(),
    };
  }

  Widget _consoleUtility(String label, IconData icon, VoidCallback onTap) {
    return Tooltip(
      message: label,
      child: Semantics(
        label: label,
        button: true,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(12),
            child: Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: const Color(0xFF111827),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: Colors.white, size: 18),
            ),
          ),
        ),
      ),
    );
  }
}

class _LogBadge extends StatelessWidget {
  const _LogBadge({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: color,
          fontSize: 8.8,
          fontWeight: FontWeight.w900,
          letterSpacing: 0.2,
        ),
      ),
    );
  }
}

class _HeroPill extends StatelessWidget {
  const _HeroPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: const TextStyle(
          color: Colors.white,
          fontWeight: FontWeight.w700,
          fontSize: 12,
        ),
      ),
    );
  }
}

class _SetupHero extends StatelessWidget {
  const _SetupHero({required this.deviceId});

  final String deviceId;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF0B5ED7), Color(0xFF0F766E)],
        ),
        boxShadow: const [
          BoxShadow(
            color: Color(0x240B5ED7),
            blurRadius: 24,
            offset: Offset(0, 14),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.16),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: Colors.white.withValues(alpha: 0.18)),
            ),
            child: const Icon(
              Icons.memory_rounded,
              color: Colors.white,
              size: 24,
            ),
          ),
          const SizedBox(height: 13),
          const Text(
            'Device Bridge',
            style: TextStyle(
              color: Colors.white,
              fontSize: 22,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            'Secure onboard by QR or setup code.',
            style: TextStyle(color: Color(0xFFDCEBFF), fontSize: 13),
          ),
          const SizedBox(height: 11),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _HeroPill(label: 'Onboarding'),
              _HeroPill(label: deviceId.isEmpty ? 'New device' : deviceId),
            ],
          ),
        ],
      ),
    );
  }
}

class _SetupStatusBanner extends StatelessWidget {
  const _SetupStatusBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0xFFFFFBEB),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFFDE68A)),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.info_outline_rounded,
            color: Color(0xFFB45309),
            size: 18,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(
                color: Color(0xFF92400E),
                fontSize: 12.4,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SetupSafetyNote extends StatelessWidget {
  const _SetupSafetyNote();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: BoxDecoration(
        color: const Color(0xFFEFF6FF),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFBFDBFE)),
      ),
      child: const Row(
        children: [
          Icon(Icons.lock_rounded, color: Color(0xFF1D4ED8), size: 18),
          SizedBox(width: 10),
          Expanded(
            child: Text(
              'No raw config is shown. The app imports only the encoded setup code from your dashboard.',
              style: TextStyle(
                color: Color(0xFF1E3A8A),
                fontSize: 11.8,
                height: 1.35,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SetupMethodCard extends StatelessWidget {
  const _SetupMethodCard({
    required this.icon,
    required this.eyebrow,
    required this.title,
    required this.detail,
    required this.accent,
    required this.onTap,
  });

  final IconData icon;
  final String eyebrow;
  final String title;
  final String detail;
  final Color accent;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(22),
      child: Container(
        padding: const EdgeInsets.all(13),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: const Color(0xFFE2E8F0)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    color: accent.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(15),
                  ),
                  child: Icon(icon, color: accent, size: 23),
                ),
                const Spacer(),
                Icon(Icons.arrow_forward_rounded, color: accent, size: 18),
              ],
            ),
            const SizedBox(height: 10),
            Text(
              eyebrow.toUpperCase(),
              style: TextStyle(
                fontSize: 10.5,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.6,
                color: accent,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 5),
            Text(
              detail,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11.9, color: Color(0xFF64748B)),
            ),
          ],
        ),
      ),
    );
  }
}

class _SettingsSectionHeader extends StatelessWidget {
  const _SettingsSectionHeader({required this.title, required this.detail});

  final String title;
  final String detail;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(fontSize: 13.2, fontWeight: FontWeight.w900),
        ),
        const SizedBox(height: 4),
        Text(
          detail,
          style: const TextStyle(
            fontSize: 11.8,
            height: 1.35,
            color: Color(0xFF64748B),
          ),
        ),
      ],
    );
  }
}

class _SettingsCompactRow extends StatelessWidget {
  const _SettingsCompactRow({
    required this.icon,
    required this.accent,
    required this.title,
    required this.detail,
    required this.actionLabel,
    required this.onTap,
  });

  final IconData icon;
  final Color accent;
  final String title;
  final String detail;
  final String actionLabel;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Row(
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: accent.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(icon, color: accent, size: 20),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 13.8,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  detail,
                  style: const TextStyle(
                    fontSize: 11.4,
                    height: 1.3,
                    color: Color(0xFF64748B),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          FilledButton(
            onPressed: onTap,
            style: FilledButton.styleFrom(
              backgroundColor: enabled ? accent : const Color(0xFFCBD5E1),
              foregroundColor: Colors.white,
              minimumSize: const Size(0, 38),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 0),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
            child: Text(
              actionLabel,
              style: const TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SettingsFeatureCard extends StatelessWidget {
  const _SettingsFeatureCard({
    required this.icon,
    required this.accent,
    required this.title,
    required this.detail,
    required this.statusLabel,
    required this.statusColor,
    required this.actionLabel,
    required this.onTap,
  });

  final IconData icon;
  final Color accent;
  final String title;
  final String detail;
  final String statusLabel;
  final Color statusColor;
  final String actionLabel;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Icon(icon, color: accent, size: 22),
              ),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(
                    color: statusColor.withValues(alpha: 0.28),
                  ),
                ),
                child: Text(
                  statusLabel,
                  style: TextStyle(
                    color: statusColor,
                    fontSize: 10.4,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            title,
            style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w900),
          ),
          const SizedBox(height: 5),
          Text(
            detail,
            style: const TextStyle(
              fontSize: 12.2,
              height: 1.4,
              color: Color(0xFF64748B),
            ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: onTap,
              style: FilledButton.styleFrom(
                backgroundColor: enabled ? accent : const Color(0xFFCBD5E1),
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 12),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                ),
              ),
              child: Text(
                actionLabel,
                style: const TextStyle(fontWeight: FontWeight.w800),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SetupProgressCard extends StatelessWidget {
  const _SetupProgressCard({
    required this.title,
    required this.detail,
    required this.deviceId,
    required this.target,
  });

  final String title;
  final String detail;
  final String deviceId;
  final String target;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF0F172A),
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: const Color(0xFF1E293B)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 12,
                height: 12,
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  color: Color(0xFF60A5FA),
                ),
              ),
              const SizedBox(width: 10),
              Text(
                title,
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w800,
                  fontSize: 16,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            detail,
            style: const TextStyle(color: Color(0xFFE2E8F0), fontSize: 13),
          ),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: const LinearProgressIndicator(
              minHeight: 8,
              backgroundColor: Color(0xFF1E293B),
              valueColor: AlwaysStoppedAnimation<Color>(Color(0xFF60A5FA)),
            ),
          ),
          const SizedBox(height: 12),
          SelectableText(
            'device   = ${deviceId.isEmpty ? 'pending' : deviceId}\n'
            'target   = ${target.isEmpty ? 'resolving' : target}\n'
            'next     = open dashboard',
            style: const TextStyle(
              color: Color(0xFFCBD5E1),
              fontFamily: 'monospace',
              fontSize: 12.2,
              height: 1.45,
            ),
          ),
        ],
      ),
    );
  }
}

class _MiniAction {
  const _MiniAction({
    required this.label,
    required this.icon,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final VoidCallback onTap;
}

enum _ActionDeliveryStatus { success, pending, failed }

class _ActionDeliveryMetrics {
  const _ActionDeliveryMetrics({
    required this.success,
    required this.pending,
    required this.failed,
    required this.recentEntries,
  });

  final int success;
  final int pending;
  final int failed;
  final List<Map<dynamic, dynamic>> recentEntries;
}

List<_InsightSimCardData> _extractSimCards(String detail) {
  final slots = <int, Map<String, String>>{};
  for (final rawLine in detail.split('\n')) {
    final line = rawLine.trim();
    final match = RegExp(
      r'^slot_(\d+)(?:_([a-z0-9_]+))?\s*=\s*(.+)$',
      caseSensitive: false,
    ).firstMatch(line);
    if (match == null) {
      continue;
    }
    final slotIndex = int.tryParse(match.group(1) ?? '') ?? 0;
    if (slotIndex <= 0) {
      continue;
    }
    final key = (match.group(2) ?? 'state').toLowerCase();
    final value = _string(match.group(3));
    if (value.isEmpty) {
      continue;
    }
    slots.putIfAbsent(slotIndex, () => <String, String>{})[key] = value;
  }
  final items = slots.entries.toList()
    ..sort((left, right) => left.key.compareTo(right.key));
  return items
      .map(
        (entry) => _InsightSimCardData(
          slotLabel: 'SIM ${entry.key}',
          title: _string(entry.value['label'], fallback: 'Slot ${entry.key}'),
          number: _string(
            entry.value['number'],
            fallback: _string(entry.value['subscriber_number']),
          ),
          carrier: _string(
            entry.value['carrier'],
            fallback: _string(entry.value['operator']),
          ),
          state: _string(entry.value['state'], fallback: 'Unknown'),
        ),
      )
      .toList(growable: false);
}

String _formatConsoleData(String value) {
  final trimmed = value.trim();
  if (trimmed.isEmpty) {
    return '';
  }
  try {
    final decoded = jsonDecode(trimmed);
    const encoder = JsonEncoder.withIndent('  ');
    return encoder.convert(decoded);
  } on FormatException {
    return trimmed;
  }
}

String _compactCount(int value) {
  if (value >= 1000000) {
    final compact = value / 1000000;
    return compact >= 10
        ? '${compact.toStringAsFixed(0)}M'
        : '${compact.toStringAsFixed(1)}M';
  }
  if (value >= 1000) {
    final compact = value / 1000;
    return compact >= 10
        ? '${compact.toStringAsFixed(0)}K'
        : '${compact.toStringAsFixed(1)}K';
  }
  return '$value';
}

String _string(dynamic value, {String fallback = ''}) {
  if (value == null) return fallback;
  final text = value.toString().trim();
  return text.isEmpty ? fallback : text;
}

bool _bool(dynamic value) {
  return value == true;
}

int _int(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}
