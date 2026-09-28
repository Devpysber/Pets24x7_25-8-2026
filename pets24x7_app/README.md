# Pets24x7 Android app

The app is the website (pets24x7.com, backed by api.pets24x7.com) in a native
Android shell. Pages, accounts, plans and payments are the same as on the web;
a change deployed to the site reaches the app at once, with no app update.

What the app adds over the browser:

- Bottom navigation: Home, Search, Membership, Account (Account opens the
  signed-in dashboard, or sign-in).
- Android back button walks back through pages; asks before leaving.
- Offline screen with Try again, and automatic reload when the connection returns.
- Native photo picking (camera or gallery) for pet photos and business galleries.
- Native alert / confirm / prompt dialogs.
- WhatsApp, phone, email and UPI payment links open in their own apps.
- pets24x7.com links open in the app (Android App Links).
- The site sees `Pets24x7App/1.0` in the user agent: it hides Google Sign-In
  there (Google blocks it inside WebViews); email and code sign-in work.

Identity: `com.pets24x7.app` (never change it after the first upload).
Target SDK: 36. Permissions: INTERNET, ACCESS_NETWORK_STATE only.

## Build

```
cd pets24x7_app
flutter pub get
flutter build appbundle --release   # build/app/outputs/bundle/release/app-release.aab  (Play Store)
flutter build apk --release         # build/app/outputs/flutter-apk/app-release.apk   (install on a phone)
```

Release builds are signed with the upload key named in `android/key.properties`
(not in git). Without that file they fall back to the debug key.

**The upload key** lives in `C:/Users/ASUS/pets24x7-keys/` with its password in
`README-KEEP-SAFE.txt`. Back that folder up. Losing it means asking Google to
reset the upload key before any update.

Before each Play upload, raise `version:` in `pubspec.yaml` (e.g. `1.0.1+2`;
the number after `+` must always go up).

## Play Console checklist

1. Create the app: name "Pets24x7", default language English (India), App, Free.
2. Upload `app-release.aab` to **Internal testing** first, then Closed testing.
   New personal developer accounts must run a closed test with at least 12
   testers for 14 days before Production is unlocked.
3. **App signing**: keep "Google Play App Signing" on. Then copy the *App
   signing key* SHA-256 from Setup > App signing and add it to
   `pets24x7_new/.well-known/assetlinks.json` next to the upload key's
   fingerprint (already there), and redeploy, so pets24x7.com links open the
   installed app.
4. Store listing: short and full description, 512x512 icon
   (`assets/play_store_icon_512.png`), a 1024x500 feature graphic, and at
   least 2 phone screenshots.
5. **Privacy policy**: https://pets24x7.com/privacy.html
6. **Account deletion URL**: https://pets24x7.com/delete-account/
   (in-app: Dashboard > Account > Delete my account; businesses: Settings).
7. **Data safety** (what the app and site collect):
   - Personal info: name, email address, phone number: collected, used for
     account management and app functionality, not shared except with the
     business a person enquires about (enquiry details only). Users can
     request deletion (yes).
   - Financial info: purchase history (memberships and business plans).
     Card and UPI details are handled by Razorpay, not by Pets24x7.
   - Photos: pet and business photos the user uploads (optional).
   - App activity: pages opened and taps inside the app (analytics, fraud
     prevention). Location: not collected. Data is encrypted in transit (yes).
8. Content rating questionnaire (no objectionable content), target audience
   18+ (people who manage pets and pay for services), no ads SDK in the app.
9. Payments: memberships and business plans are real-world services
   (concierge help, business listings), so they are sold through Razorpay on
   the site, not Google Play Billing. Keep the listing and app copy describing
   them as services.

## Server (one time)

The live nginx vhost must be reinstalled from `ops/nginx-pets24x7.com.conf`
(the deploy does not install nginx), so `/.well-known/assetlinks.json` is
served; the old config denies every dot path.
