"""Launch the manabase helper (static web app) for local use.

The app is fully client-side — the deployable site is the ``docs/`` folder (see
DEPLOY.md for hosting). This just serves docs/ locally and opens your browser.

    python mtg_manabase.py
"""

import functools
import http.server
import os
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "docs")
HOST, PORT = "127.0.0.1", 8733


class Handler(http.server.SimpleHTTPRequestHandler):
    # Ensure ES modules and JSON get correct MIME types regardless of the OS
    # mimetypes registry (some map .js to text/plain, which breaks modules).
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
    }

    def log_message(self, *args):
        pass


def _safe_open(url):
    try:
        webbrowser.open(url)
    except Exception:  # noqa: BLE001
        pass


def main(open_browser=True):
    handler = functools.partial(Handler, directory=DOCS)
    url = "http://{}:{}/".format(HOST, PORT)
    print("Manabase helper at {} (serving docs/). Ctrl-C to stop.".format(url))
    if open_browser:
        threading.Timer(0.5, lambda: _safe_open(url)).start()
    httpd = http.server.ThreadingHTTPServer((HOST, PORT), handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
