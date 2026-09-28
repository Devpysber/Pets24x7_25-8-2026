// Pets24x7 for Android.
//
// The website (pets24x7.com) is the product: same pages, same accounts, same
// backend (api.pets24x7.com). This app hosts it in a WebView and adds what a
// phone app should have: a bottom navigation bar, an offline screen, the
// Android back button, native photo picking for uploads, native dialogs,
// deep links from pets24x7.com, and WhatsApp / phone / UPI / email links
// opened in their own apps.
//
// The site recognises the app by "Pets24x7App" in the user agent (it hides
// Google Sign-In there, which Google does not allow inside WebViews).

import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

const String kSite = 'https://pets24x7.com';
const String kAppUserAgent = 'Pets24x7App/1.0';
const Color kBrand = Color(0xFF2563EB);

/// Hosts that stay inside the app. Everything else on the web still loads in
/// the app (payment and bank pages must), except the hosts below.
const Set<String> kExternalHosts = {
  'wa.me', 'api.whatsapp.com', 'web.whatsapp.com', 'play.google.com',
  'maps.google.com', 'www.google.com', 'maps.app.goo.gl', 'goo.gl',
  'www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be',
  'www.facebook.com', 'facebook.com', 'm.facebook.com', 'www.instagram.com',
  'instagram.com', 'twitter.com', 'x.com', 'www.linkedin.com', 'accounts.google.com',
};

class Tab {
  const Tab(this.label, this.icon, this.selectedIcon, this.path, this.match);
  final String label;
  final IconData icon;
  final IconData selectedIcon;
  final String path;
  final bool Function(Uri u) match;
}

final List<Tab> kTabs = [
  Tab('Home', Icons.home_outlined, Icons.home, '/', (u) => u.path == '/' || u.path.isEmpty || u.path.startsWith('/in/') || u.path.startsWith('/us/')),
  Tab('Search', Icons.search_outlined, Icons.search, '/search/', (u) => u.path.startsWith('/search')),
  Tab('Membership', Icons.workspace_premium_outlined, Icons.workspace_premium, '/membership/', (u) => u.path.startsWith('/membership')),
  Tab('Account', Icons.person_outline, Icons.person, '/login/', (u) =>
      u.path.startsWith('/dashboard') || u.path.contains('login') || u.path.startsWith('/delete-account') || u.path.startsWith('/register-business')),
];

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.white,
    statusBarIconBrightness: Brightness.dark,
    systemNavigationBarColor: Colors.white,
    systemNavigationBarIconBrightness: Brightness.dark,
  ));
  runApp(const Pets24x7App());
}

class Pets24x7App extends StatelessWidget {
  const Pets24x7App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Pets24x7',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: kBrand, brightness: Brightness.light),
        useMaterial3: true,
        scaffoldBackgroundColor: Colors.white,
      ),
      home: const SiteShell(),
    );
  }
}

class SiteShell extends StatefulWidget {
  const SiteShell({super.key});

  @override
  State<SiteShell> createState() => _SiteShellState();
}

class _SiteShellState extends State<SiteShell> {
  final WebViewController _web = WebViewController();
  final AppLinks _links = AppLinks();
  StreamSubscription<Uri>? _linkSub;
  StreamSubscription<List<ConnectivityResult>>? _netSub;

  int _tab = 0;
  int _progress = 0;
  bool _offline = false;
  bool _ready = false;
  Uri? _lastUrl;

  @override
  void initState() {
    super.initState();
    _setUp();
  }

  Future<void> _setUp() async {
    final controller = _web;

    await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
    await controller.setBackgroundColor(Colors.white);
    final baseUa = await controller.getUserAgent() ?? '';
    await controller.setUserAgent('$baseUa $kAppUserAgent'.trim());

    await controller.setNavigationDelegate(NavigationDelegate(
      onNavigationRequest: _onNavigation,
      onProgress: (p) => setState(() => _progress = p),
      onPageStarted: (url) => _noteUrl(url),
      onPageFinished: (url) {
        _noteUrl(url);
        setState(() {
          _progress = 100;
          _ready = true;
        });
      },
      onUrlChange: (change) {
        if (change.url != null) _noteUrl(change.url!);
      },
      onWebResourceError: (err) {
        if (err.isForMainFrame ?? true) {
          // A page that cannot load at all: the offline screen with Retry.
          if (err.errorType == WebResourceErrorType.hostLookup ||
              err.errorType == WebResourceErrorType.connect ||
              err.errorType == WebResourceErrorType.timeout ||
              err.errorType == WebResourceErrorType.io) {
            setState(() => _offline = true);
          }
        }
      },
    ));

    // Native dialogs for alert() / confirm() / prompt() (a WebView shows none).
    await controller.setOnJavaScriptAlertDialog((req) async {
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (c) => AlertDialog(
          content: Text(req.message),
          actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('OK'))],
        ),
      );
    });
    await controller.setOnJavaScriptConfirmDialog((req) async {
      if (!mounted) return false;
      final ok = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          content: Text(req.message),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('OK')),
          ],
        ),
      );
      return ok ?? false;
    });
    await controller.setOnJavaScriptTextInputDialog((req) async {
      if (!mounted) return '';
      final field = TextEditingController(text: req.defaultText ?? '');
      final value = await showDialog<String>(
        context: context,
        builder: (c) => AlertDialog(
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(req.message),
            TextField(controller: field, autofocus: true),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, ''), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, field.text), child: const Text('OK')),
          ],
        ),
      );
      return value ?? '';
    });

    final platform = controller.platform;
    if (platform is AndroidWebViewController) {
      await platform.setMediaPlaybackRequiresUserGesture(true);
      // Photo uploads (pet photos, business gallery) through the system picker.
      await platform.setOnShowFileSelector(_pickFiles);
    }

    // Opened from a pets24x7.com link? Start there; otherwise the home page.
    Uri start = Uri.parse('$kSite/');
    try {
      final initial = await _links.getInitialLink();
      if (initial != null && _isSiteHost(initial.host)) start = initial;
    } catch (_) {}
    _linkSub = _links.uriLinkStream.listen((uri) {
      if (_isSiteHost(uri.host)) _web.loadRequest(uri);
    });

    _netSub = Connectivity().onConnectivityChanged.listen((results) {
      final online = results.any((r) => r != ConnectivityResult.none);
      if (online && _offline) _retry();
    });

    await controller.loadRequest(start);
    if (mounted) setState(() {});
  }

  bool _isSiteHost(String host) => host == 'pets24x7.com' || host == 'www.pets24x7.com';

  void _noteUrl(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    _lastUrl = uri;
    if (!_isSiteHost(uri.host)) return;
    final i = kTabs.indexWhere((t) => t.match(uri));
    if (i >= 0 && i != _tab) setState(() => _tab = i);
  }

  Future<NavigationDecision> _onNavigation(NavigationRequest req) async {
    final uri = Uri.tryParse(req.url);
    if (uri == null) return NavigationDecision.prevent;
    final scheme = uri.scheme.toLowerCase();

    // tel:, mailto:, whatsapp:, upi:, intent:, market: … belong to other apps.
    if (scheme != 'http' && scheme != 'https') {
      await _openExternal(uri);
      return NavigationDecision.prevent;
    }
    // Only whole-page navigations are redirected; frames (payment forms) stay.
    if (req.isMainFrame) {
      if (kExternalHosts.contains(uri.host.toLowerCase())) {
        await _openExternal(uri);
        return NavigationDecision.prevent;
      }
      // Invoices and other files open in the browser, which can save them.
      if (uri.path.toLowerCase().endsWith('.pdf') || uri.path.contains('/invoice')) {
        await _openExternal(uri);
        return NavigationDecision.prevent;
      }
    }
    return NavigationDecision.navigate;
  }

  Future<void> _openExternal(Uri uri) async {
    try {
      final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!ok && mounted) _snack('No app on this phone can open that link.');
    } catch (_) {
      if (mounted) _snack('No app on this phone can open that link.');
    }
  }

  Future<List<String>> _pickFiles(FileSelectorParams params) async {
    final wantsImages = params.acceptTypes.isEmpty ||
        params.acceptTypes.every((t) => t.isEmpty || t.startsWith('image'));
    final multiple = params.mode == FileSelectorMode.openMultiple;
    try {
      if (wantsImages) {
        final source = await showModalBottomSheet<ImageSource>(
          context: context,
          showDragHandle: true,
          builder: (c) => SafeArea(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              ListTile(leading: const Icon(Icons.photo_camera_outlined), title: const Text('Take a photo'), onTap: () => Navigator.pop(c, ImageSource.camera)),
              ListTile(leading: const Icon(Icons.photo_library_outlined), title: const Text('Choose from gallery'), onTap: () => Navigator.pop(c, ImageSource.gallery)),
            ]),
          ),
        );
        if (source == null) return [];
        final picker = ImagePicker();
        if (multiple && source == ImageSource.gallery) {
          final files = await picker.pickMultiImage(imageQuality: 85, maxWidth: 2000);
          return files.map((f) => Uri.file(f.path).toString()).toList();
        }
        final f = await picker.pickImage(source: source, imageQuality: 85, maxWidth: 2000);
        return f == null ? [] : [Uri.file(f.path).toString()];
      }
      final groups = [XTypeGroup(mimeTypes: params.acceptTypes.where((t) => t.isNotEmpty).toList())];
      if (multiple) {
        final files = await openFiles(acceptedTypeGroups: groups);
        return files.map((f) => Uri.file(f.path).toString()).toList();
      }
      final f = await openFile(acceptedTypeGroups: groups);
      return f == null ? [] : [Uri.file(f.path).toString()];
    } catch (_) {
      return [];
    }
  }

  void _snack(String text) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  void _retry() {
    setState(() => _offline = false);
    final url = _lastUrl;
    if (url != null && _isSiteHost(url.host)) {
      _web.loadRequest(url);
    } else {
      _web.loadRequest(Uri.parse('$kSite/'));
    }
  }

  void _goTab(int i) {
    final again = i == _tab;
    setState(() => _tab = i);
    if (again && _lastUrl != null && kTabs[i].match(_lastUrl!)) {
      _web.reload(); // tapping the open tab again refreshes it
      return;
    }
    _web.loadRequest(Uri.parse('$kSite${kTabs[i].path}'));
  }

  Future<void> _onBack() async {
    if (await _web.canGoBack()) {
      await _web.goBack();
      return;
    }
    if (!mounted) return;
    final leave = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Leave Pets24x7?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Stay')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Leave')),
        ],
      ),
    );
    if (leave == true) SystemNavigator.pop();
  }

  @override
  void dispose() {
    _linkSub?.cancel();
    _netSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _onBack();
      },
      child: Scaffold(
        body: SafeArea(
          bottom: false,
          child: Stack(children: [
            WebViewWidget(controller: _web),
            if (_progress < 100)
              Positioned(
                top: 0, left: 0, right: 0,
                child: LinearProgressIndicator(value: _progress / 100, minHeight: 3, color: kBrand, backgroundColor: Colors.transparent),
              ),
            if (!_ready && !_offline) const _Splash(),
            if (_offline) _Offline(onRetry: _retry),
          ]),
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: _goTab,
          height: 64,
          backgroundColor: Colors.white,
          indicatorColor: kBrand.withValues(alpha: 0.12),
          destinations: [
            for (final t in kTabs)
              NavigationDestination(icon: Icon(t.icon), selectedIcon: Icon(t.selectedIcon, color: kBrand), label: t.label),
          ],
        ),
      ),
    );
  }
}

class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      alignment: Alignment.center,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Image.asset('assets/logo.png', width: 180),
        const SizedBox(height: 24),
        const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3, color: kBrand)),
      ]),
    );
  }
}

class _Offline extends StatelessWidget {
  const _Offline({required this.onRetry});
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      padding: const EdgeInsets.all(32),
      alignment: Alignment.center,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.wifi_off_rounded, size: 56, color: Color(0xFF9CA3AF)),
        const SizedBox(height: 16),
        const Text("You're offline", style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        const Text('Check your internet connection. Pets24x7 reconnects on its own as soon as you are back online.',
            textAlign: TextAlign.center, style: TextStyle(color: Color(0xFF6B7280))),
        const SizedBox(height: 20),
        FilledButton.icon(onPressed: onRetry, icon: const Icon(Icons.refresh), label: const Text('Try again')),
      ]),
    );
  }
}
