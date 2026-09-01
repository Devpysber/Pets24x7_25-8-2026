"""
Pets24x7 — local dev server that emulates the Hostinger .htaccess rewrites.

`python -m http.server` serves raw files only, so pretty URLs like
/in/mumbai/ 404 because the pre-rendered pages (pets24x7_new/in/, /us/)
are gitignored and built by build_pages.py at deploy time.

This server maps the clean URLs onto the fallback templates
(city.html / listing.html / review/*) exactly like the .htaccess rules,
injecting <base href="/"> so their relative asset paths still resolve.

Run:  python serve.py           (defaults to port 8000)
      python serve.py 8080
"""

import os
import re
import sys
import posixpath
import http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, quote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

# Reverse-proxy every API/auth path to the backend so the whole app is served
# from ONE origin (http://localhost:PORT). Same-origin => the httpOnly JWT
# cookie is sent on every fetch in every browser (no cross-port / third-party
# cookie blocking), and it mirrors production where pets24x7.com + api.pets24x7.com
# share the .pets24x7.com cookie domain.
API_TARGET = os.environ.get("PETS_API_TARGET", "127.0.0.1:4000")
PROXY_PREFIXES = ("/api/", "/api", "/dev/", "/dev", "/admin/", "/admin", "/r/", "/health")


def _should_proxy(path):
    return any(path == p or path.startswith(p.rstrip("/") + "/") or path == p.rstrip("/")
               for p in PROXY_PREFIXES)

# Category slugs (from build_pages.py CATEGORY_BLURB). 3rd path segment that
# matches one of these is a category page; anything else is a listing id.
CATEGORY_SLUGS = {
    "veterinary-clinics", "emergency-animal-hospital", "vaccination-centers",
    "mobile-vet-services", "specialty-vets-exotics-avian-reptiles",
    "pet-dental-care", "pet-physiotherapy-rehab", "pet-grooming-spa",
    "pet-boarding-daycare", "pet-walking", "pet-training-obedience-behavior",
    "pet-sitting-in-home-care", "pet-relocation-services", "pet-taxi-transport",
    "veterinary-labs-diagnostics", "pet-therapy-services",
}

CITY_RE     = re.compile(r"^/(in|us)/([a-z0-9-]+)/?$")
PAGE_RE     = re.compile(r"^/(in|us)/([a-z0-9-]+)/page/(\d+)/?$")
SUB_RE      = re.compile(r"^/(in|us)/([a-z0-9-]+)/([a-z0-9-]+)/?$")
REVIEW_RE   = re.compile(r"^/review/([A-Z0-9]{4,16})/?$")
REVIEW_FORM = re.compile(r"^/review/([A-Z0-9]{4,16})/form/?$")
REVIEW_THX  = re.compile(r"^/review/([A-Z0-9]{4,16})/thanks/?$")
UPPER_CC    = re.compile(r"^/(IN|US)/(.*)$")

# Injected into rewritten templates: <base> so relative asset/data paths
# resolve from root even with a pretty browser URL, plus a shim that
# synthesises the ?country=&city=&cat=/&id= query the templates read from
# location.search (the real deploy bakes these in server-side; the fallback
# templates still parse the query string).
_CATS_JS = ",".join('"%s"' % c for c in sorted(CATEGORY_SLUGS))
INJECT = (
    '<base href="/">'
    "<script>(function(){"
    "if(location.search)return;"
    "var r=location.pathname.match(/^\\/review\\/([A-Z0-9]{4,16})(?:\\/(?:form|thanks))?\\/?$/i);"
    "if(r){history.replaceState(null,'',location.pathname+'?code='+r[1]);return;}"
    "var m=location.pathname.match(/^\\/(in|us)\\/([a-z0-9-]+)(?:\\/([a-z0-9-]+))?\\/?$/i);"
    "if(!m)return;"
    "var CATS=[" + _CATS_JS + "];"
    "var q='country='+m[1].toUpperCase()+'&city='+m[2].toLowerCase();"
    "if(m[3]){q+=(CATS.indexOf(m[3].toLowerCase())>-1?'&cat=':'&id=')+m[3];}"
    "history.replaceState(null,'',location.pathname+'?'+q);"
    "})();</script>"
).encode()


def rewrite(path):
    """Return (template_file, query_string) for a clean URL, or None."""
    m = UPPER_CC.match(path)
    if m:
        return ("__redirect__", "/" + m.group(1).lower() + "/" + m.group(2))

    m = PAGE_RE.match(path)
    if m:
        cc, city, n = m.groups()
        return ("city.html", f"country={cc.upper()}&city={city}&page={n}")

    m = CITY_RE.match(path)
    if m:
        cc, city = m.groups()
        return ("city.html", f"country={cc.upper()}&city={city}")

    m = SUB_RE.match(path)
    if m:
        cc, city, seg = m.groups()
        if seg in CATEGORY_SLUGS:
            return ("city.html", f"country={cc.upper()}&city={city}&cat={seg}")
        return ("listing.html", f"country={cc.upper()}&city={city}&id={seg}")

    m = REVIEW_RE.match(path)
    if m:
        return ("review/index.html", f"code={m.group(1)}")
    m = REVIEW_FORM.match(path)
    if m:
        return ("review/form/index.html", f"code={m.group(1)}")
    m = REVIEW_THX.match(path)
    if m:
        return ("review/thanks/index.html", f"code={m.group(1)}")

    return None


class Handler(SimpleHTTPRequestHandler):
    # ---- reverse proxy to the backend ----
    def _proxy(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None

        conn = http.client.HTTPConnection(API_TARGET, timeout=30)
        # Forward headers; drop hop-by-hop + let http.client set Host/Content-Length.
        fwd = {}
        for k, v in self.headers.items():
            lk = k.lower()
            if lk in ("host", "content-length", "connection", "keep-alive",
                      "proxy-authenticate", "proxy-authorization", "te",
                      "trailers", "transfer-encoding", "upgrade", "accept-encoding"):
                continue
            fwd[k] = v
        fwd["Host"] = API_TARGET
        fwd["X-Forwarded-For"] = self.client_address[0]
        fwd["X-Forwarded-Proto"] = "http"
        try:
            conn.request(self.command, self.path, body=body, headers=fwd)
            resp = conn.getresponse()
            data = resp.read()
        except Exception as e:  # backend down / unreachable
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            msg = b'{"ok":false,"error":"backend_unreachable"}'
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        finally:
            conn.close()

        self.send_response(resp.status)
        for k, v in resp.getheaders():
            lk = k.lower()
            if lk in ("connection", "keep-alive", "transfer-encoding",
                      "content-length", "content-encoding"):
                continue
            # Set-Cookie may repeat — send_header handles each call separately.
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        # NB: end_headers() below adds Cache-Control: no-store (fine for API).
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_POST(self):
        if _should_proxy(urlparse(self.path).path):
            return self._proxy()
        self.send_error(405)

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST
    do_OPTIONS = do_POST

    def do_GET(self):
        parsed = urlparse(self.path)
        clean = parsed.path

        if clean == "/favicon.ico":
            clean = "/pets24x7_logo.png"
            self.path = "/pets24x7_logo.png"
            return super().do_GET()

        if _should_proxy(clean):
            return self._proxy()

        hit = rewrite(clean)
        if hit and hit[0] == "__redirect__":
            self.send_response(301)
            self.send_header("Location", hit[1])
            self.end_headers()
            return

        if hit:
            template, qs = hit
            try:
                with open(template, "rb") as fh:
                    body = fh.read()
            except FileNotFoundError:
                self.send_error(404, "template missing: " + template)
                return
            # Inject <base> so relative asset/data paths resolve from root
            # even though the browser URL is /in/<city>/...
            if b"<base " not in body[:2000]:
                body = re.sub(rb"(<head[^>]*>)", rb"\1" + INJECT, body, count=1)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # DirectoryIndex: /foo/ -> /foo/index.html handled by base class.
        return super().do_GET()

    def send_error(self, code, message=None, explain=None):
        # Match the production `ErrorDocument 404 /404.html` rule so a missing
        # URL looks the same in dev as it does on Hostinger.
        if code == 404:
            try:
                with open("404.html", "rb") as fh:
                    body = fh.read()
            except OSError:
                return super().send_error(code, message, explain)
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            return
        return super().send_error(code, message, explain)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    print(f"Pets24x7 dev server (htaccess-aware)  ->  http://localhost:{PORT}/")
    print("  /in/mumbai/            -> city.html?country=IN&city=mumbai")
    print("  /in/mumbai/pet-grooming-spa/  -> city.html ...&cat=")
    print("  /in/mumbai/<id>/       -> listing.html ...&id=")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
