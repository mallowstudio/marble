// Unified test portal server. Based on the marble-repo server.js (same MIME types and headers);
// serves public/ with "/" = selector, "/marble/" and "/pinball/" = the two independent Unity WebGL builds.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.join(__dirname, "public");
const port = process.env.PORT || 3000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const server = http.createServer((req, res) => {
  let url, pathname;

  try {
    url = new URL(req.url, "http://localhost");
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end("Bad Request");
  }

  // Unity builds load their files relative to index.html, so a game page must be served with a trailing slash.
  if (pathname === "/marble" || pathname === "/pinball") {
    res.writeHead(301, { Location: pathname + "/" + url.search });
    return res.end();
  }

  if (pathname.endsWith("/")) pathname += "index.html";

  const filePath = path.resolve(root, "." + pathname);
  const relative = path.relative(root, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      return res.end("Not Found");
    }

    const ext = path.extname(filePath).toLowerCase();

    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';"
    );

    res.setHeader(
      "Content-Type",
      mimeTypes[ext] || "application/octet-stream"
    );

    res.setHeader("X-Content-Type-Options", "nosniff");

    // Pages are revalidated so a redeploy is picked up.
    if (ext === ".html") res.setHeader("Cache-Control", "no-cache");

    if (!isBuildFile(relative)) return sendFile(req, res, filePath, stat);

    // Build files keep the same names across deploys, so every load revalidates them against a
    // content-hash ETag: unchanged bytes get a 304, changed bytes get a new ETag and a full 200.
    contentEtag(filePath, stat).then((etag) => {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("ETag", etag);
      if (etagMatches(req.headers["if-none-match"], etag)) {
        res.writeHead(304);
        return res.end();
      }
      sendFile(req, res, filePath, stat);
    }, () => {
      res.writeHead(500);
      res.end();
    });
  });
});

function sendFile(req, res, filePath, stat) {
  if (req.method === "HEAD") {
    res.setHeader("Content-Length", stat.size);
    return res.end();
  }

  fs.createReadStream(filePath)
    .on("error", () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    })
    .pipe(res);
}

// public/<game>/Build/<file>
function isBuildFile(relative) {
  const parts = relative.split(path.sep);
  return parts.length === 3 && parts[1] === "Build";
}

// Strong ETag = SHA-1 of the file contents, cached per path until its size or mtime changes.
const etags = new Map();

function contentEtag(filePath, stat) {
  const key = stat.size + ":" + stat.mtimeMs;
  const cached = etags.get(filePath);
  if (cached && cached.key === key) return cached.etag;

  const etag = new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    fs.createReadStream(filePath)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve('"' + hash.digest("base64url") + '"'));
  });
  etags.set(filePath, { key, etag });
  etag.catch(() => etags.delete(filePath));
  return etag;
}

function etagMatches(header, etag) {
  if (!header) return false;
  return header.split(",").some((tag) => {
    tag = tag.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}

server.listen(port, "0.0.0.0", () => {
  console.log(`Games test portal listening on ${port}`);
});
