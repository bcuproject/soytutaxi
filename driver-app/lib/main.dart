// SoyTuTaxi Chofer — Android app for drivers.
//
// The screens are the driver web app (https://bcuproject.github.io/soytutaxi/chofer) shown in a WebView, so every
// change to the web app reaches drivers without a new install. The app adds what a web page can't do reliably:
//  * GPS while the driver is on shift, also with the screen off (a persistent "Compartiendo tu ubicación" notice);
//  * a loud notification with vibration when a new trip offer arrives while the app is in the background.
// The page sends the app the driver's session and on/off shift over the "SttNative" JavaScript channel; the app calls
// the same server functions the page uses (driver_report_location, driver_offers) with that session.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

const appUrl = 'https://bcuproject.github.io/soytutaxi/chofer?app=android';
const allowedHost = 'bcuproject.github.io';
const sendEvery = Duration(seconds: 15);
const offerCheckEvery = Duration(seconds: 15);

final notifications = FlutterLocalNotificationsPlugin();
const offerChannel = AndroidNotificationDetails(
  'offers', 'Viajes nuevos',
  channelDescription: 'Aviso cuando hay un viaje nuevo para aceptar',
  importance: Importance.max,
  priority: Priority.high,
  playSound: true,
  enableVibration: true,
  category: AndroidNotificationCategory.call,
  visibility: NotificationVisibility.public,
  ticker: 'Viaje nuevo',
);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await notifications.initialize(
    settings: const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher')),
  );
  runApp(const DriverApp());
}

class DriverApp extends StatelessWidget {
  const DriverApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'SoyTuTaxi Chofer',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(colorSchemeSeed: const Color(0xFFF5C518), brightness: Brightness.dark, useMaterial3: true),
        home: const Shell(),
      );
}

/// What the web page told us about the signed-in driver.
class Session {
  Session(this.url, this.anonKey, this.accessToken, this.expiresAt);
  final String url, anonKey, accessToken;
  final int expiresAt; // seconds since epoch
  bool get expired => expiresAt > 0 && DateTime.now().millisecondsSinceEpoch ~/ 1000 >= expiresAt - 30;
}

class Shell extends StatefulWidget {
  const Shell({super.key});
  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> with WidgetsBindingObserver {
  late final WebViewController web;
  Session? session;
  bool onShift = false;
  bool loading = true;
  bool offline = false;
  AppLifecycleState life = AppLifecycleState.resumed;

  StreamSubscription<Position>? gpsSub;
  Position? lastFix;
  DateTime? lastSentFix;
  Timer? sendTimer, offerTimer;
  final Set<String> seenOffers = {};
  bool offersPrimed = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF0B0D10))
      ..addJavaScriptChannel('SttNative', onMessageReceived: (m) => onPageMessage(m.message))
      ..setNavigationDelegate(NavigationDelegate(
        onPageStarted: (_) => setState(() { loading = true; offline = false; }),
        onPageFinished: (_) => setState(() => loading = false),
        onWebResourceError: (e) {
          if (e.isForMainFrame ?? true) setState(() { offline = true; loading = false; });
        },
        onNavigationRequest: (req) {
          final uri = Uri.tryParse(req.url);
          // Our own pages stay in the app; WhatsApp, phone, maps and payment links open outside.
          if (uri != null && uri.host == allowedHost) return NavigationDecision.navigate;
          if (uri != null) launchUrl(uri, mode: LaunchMode.externalApplication);
          return NavigationDecision.prevent;
        },
      ))
      ..loadRequest(Uri.parse(appUrl));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    stopShift();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    life = state;
    if (state == AppLifecycleState.resumed) {
      // Back in front: the page shows the offers itself; clear our alerts.
      notifications.cancelAll();
    }
  }

  // ---- Messages from the web page ----
  void onPageMessage(String raw) {
    Map<String, dynamic> m;
    try { m = jsonDecode(raw) as Map<String, dynamic>; } catch (_) { return; }
    switch (m['type']) {
      case 'session':
        session = Session('${m['url']}', '${m['anonKey']}', '${m['accessToken']}', (m['expiresAt'] as num?)?.toInt() ?? 0);
        break;
      case 'logout':
        session = null;
        stopShift();
        break;
      case 'shift':
        (m['on'] == true) ? startShift() : stopShift();
        break;
    }
  }

  // ---- On shift: GPS + offer alerts ----
  Future<void> startShift() async {
    if (onShift) return;
    if (!await ensureLocationPermission()) {
      tellPage({'error': 'Permití la ubicación (Permitir siempre) para aparecer en el mapa.'});
      return;
    }
    await notifications
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.requestNotificationsPermission();
    onShift = true;
    gpsSub = Geolocator.getPositionStream(
      locationSettings: AndroidSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 0,
        intervalDuration: const Duration(seconds: 5),
        foregroundNotificationConfig: const ForegroundNotificationConfig(
          notificationTitle: 'SoyTuTaxi · en turno',
          notificationText: 'Compartiendo tu ubicación con la central',
          enableWakeLock: true,
          setOngoing: true,
        ),
      ),
    ).listen((p) => lastFix = p, onError: (_) => tellPage({'error': 'Sin señal GPS.'}));
    sendTimer = Timer.periodic(sendEvery, (_) => sendFix());
    offerTimer = Timer.periodic(offerCheckEvery, (_) => checkOffers());
    Future.delayed(const Duration(seconds: 3), sendFix);
    checkOffers();
  }

  void stopShift() {
    onShift = false;
    gpsSub?.cancel(); gpsSub = null;
    sendTimer?.cancel(); sendTimer = null;
    offerTimer?.cancel(); offerTimer = null;
    offersPrimed = false;
    seenOffers.clear();
  }

  Future<bool> ensureLocationPermission() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      tellPage({'error': 'Activá el GPS del teléfono.'});
      return false;
    }
    var p = await Geolocator.checkPermission();
    if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
    return p == LocationPermission.whileInUse || p == LocationPermission.always;
  }

  Future<http.Response?> rpc(String fn, Map<String, dynamic> body) async {
    final s = session;
    if (s == null) return null;
    if (s.expired) {
      // The page renews the session while the app is open; ask it to resend if it already did.
      web.runJavaScript('window.dispatchEvent(new Event("stt-native-wants-session"))');
    }
    try {
      return await http
          .post(Uri.parse('${s.url}/rest/v1/rpc/$fn'),
              headers: {'apikey': s.anonKey, 'authorization': 'Bearer ${s.accessToken}', 'content-type': 'application/json'},
              body: jsonEncode(body))
          .timeout(const Duration(seconds: 12));
    } catch (_) {
      return null;
    }
  }

  Future<void> sendFix() async {
    final p = lastFix;
    if (!onShift || p == null || p.timestamp == lastSentFix) return;
    final r = await rpc('driver_report_location', {
      'p_lat': p.latitude, 'p_lng': p.longitude, 'p_accuracy': p.accuracy,
      'p_heading': p.heading, 'p_speed': p.speed, 'p_recorded_at': p.timestamp.toUtc().toIso8601String(),
    });
    if (r != null && r.statusCode < 300) {
      lastSentFix = p.timestamp;
      tellPage({'sentAt': DateTime.now().toUtc().toIso8601String(), 'accuracy': p.accuracy, 'error': null});
    } else if (r != null && r.statusCode == 401) {
      tellPage({'error': 'Abrí la app para renovar la sesión.'});
      if (life != AppLifecycleState.resumed) {
        notifications.show(
            id: 2, title: 'SoyTuTaxi', body: 'Abrí la app: hay que renovar la sesión para seguir en el mapa.',
            notificationDetails: const NotificationDetails(android: offerChannel));
      }
    } else {
      tellPage({'error': 'No se pudo enviar la ubicación.'});
    }
  }

  Future<void> checkOffers() async {
    if (!onShift) return;
    final r = await rpc('driver_offers', {});
    if (r == null || r.statusCode >= 300) return;
    List offers;
    try { offers = jsonDecode(r.body) as List; } catch (_) { return; }
    final fresh = offers.where((o) => !seenOffers.contains('${o['id']}')).toList();
    for (final o in offers) { seenOffers.add('${o['id']}'); }
    // The first check after going on shift only learns what is already there.
    if (!offersPrimed) { offersPrimed = true; return; }
    if (fresh.isEmpty) return;
    HapticFeedback.heavyImpact();
    if (life == AppLifecycleState.resumed) return; // the page shows it on screen
    final o = fresh.first;
    final where = o['direction'] == 'from_airport' ? '${o['airport']} → ${o['zone'] ?? ''}' : '${o['zone'] ?? ''} → ${o['airport']}';
    final when = DateTime.tryParse('${o['pickupAt']}')?.toLocal();
    final hhmm = when == null ? '' : '${when.day}/${when.month} ${when.hour.toString().padLeft(2, '0')}:${when.minute.toString().padLeft(2, '0')}';
    await notifications.show(
        id: 1, title: '🚕 Viaje nuevo · $hhmm', body: '$where · ${o['passengers']} pax. Abrí la app para aceptarlo.',
        notificationDetails: const NotificationDetails(android: offerChannel));
  }

  void tellPage(Map<String, dynamic> detail) {
    web.runJavaScript('window.dispatchEvent(new CustomEvent("stt-native-location",{detail:${jsonEncode(detail)}}))');
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (await web.canGoBack()) {
          web.goBack();
        } else {
          SystemNavigator.pop(); // to the home screen; GPS keeps going while on shift
        }
      },
      child: Scaffold(
        backgroundColor: const Color(0xFF0B0D10),
        body: SafeArea(
          child: Stack(children: [
            WebViewWidget(controller: web),
            if (loading) const LinearProgressIndicator(minHeight: 2),
            if (offline)
              Center(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  const Icon(Icons.wifi_off, size: 48),
                  const SizedBox(height: 12),
                  const Text('Sin conexión'),
                  const SizedBox(height: 12),
                  FilledButton(onPressed: () => web.reload(), child: const Text('Reintentar')),
                ]),
              ),
          ]),
        ),
      ),
    );
  }
}
