// Unified test portal server. Based on the marble-repo server.js (same MIME types and headers);
// serves public/ with "/" = selector, "/marble/" and "/pinball/" = the two independent Unity WebGL builds.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

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
    // A verified pre-compressed <file>.br is served instead to clients that accept Brotli.
    Promise.all([contentEtag(filePath, stat), brotliVariant(filePath)]).then(([etag, br]) => {
      const variant = br && acceptsBrotli(req.headers["accept-encoding"]) ? br : null;
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("ETag", variant ? variant.etag : etag);
      if (variant) res.setHeader("Content-Encoding", "br");
      if (etagMatches(req.headers["if-none-match"], variant ? variant.etag : etag)) {
        res.writeHead(304);
        return res.end();
      }
      if (variant) sendFile(req, res, variant.path, variant.stat);
      else sendFile(req, res, filePath, stat);
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

// <file>.br is used only after its decompressed bytes are verified to hash to the original file,
// so a stale .br left beside a newer payload falls back to the original. Its ETag is the SHA-1 of
// the compressed bytes, distinct from the original's. Cached per path until either file changes.
const brVariants = new Map();

function brotliVariant(filePath) {
  const brPath = filePath + ".br";
  return Promise.all([fs.promises.stat(filePath), fs.promises.stat(brPath).catch(() => null)]).then(([stat, brStat]) => {
    if (!brStat || !brStat.isFile()) return null;
    const key = [stat.size, stat.mtimeMs, brStat.size, brStat.mtimeMs].join(":");
    const cached = brVariants.get(filePath);
    if (cached && cached.key === key) return cached.variant;

    const variant = Promise.all([contentEtag(filePath, stat), hashBrotli(brPath)]).then(([etag, hashes]) => {
      if (hashes.decoded !== etag) {
        console.warn(`Ignoring ${brPath}: it does not decompress to ${path.basename(filePath)}`);
        return null;
      }
      return { path: brPath, stat: brStat, etag: '"br-' + hashes.encoded + '"' };
    });
    brVariants.set(filePath, { key, variant });
    variant.catch(() => brVariants.delete(filePath));
    return variant;
  });
}

// SHA-1 of the compressed bytes and of their decompressed output, in the same quoted form as contentEtag.
function hashBrotli(brPath) {
  return new Promise((resolve, reject) => {
    const encoded = crypto.createHash("sha1");
    const decoded = crypto.createHash("sha1");
    const unzip = zlib.createBrotliDecompress()
      .on("error", reject)
      .on("data", (chunk) => decoded.update(chunk))
      .on("end", () => resolve({ encoded: encoded.digest("base64url"), decoded: '"' + decoded.digest("base64url") + '"' }));
    fs.createReadStream(brPath)
      .on("error", reject)
      .on("data", (chunk) => encoded.update(chunk))
      .pipe(unzip);
  });
}

function acceptsBrotli(header) {
  if (!header) return false;
  return header.split(",").some((part) => {
    const [coding, ...params] = part.trim().split(";");
    if (coding.trim().toLowerCase() !== "br") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !q || parseFloat(q.slice(2)) > 0;
  });
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
  warmBuildCache();
});

// Hash and verify every Build file up front so the first visitors do not wait for it.
function warmBuildCache() {
  for (const game of fs.readdirSync(root)) {
    const dir = path.join(root, game, "Build");
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".br")) continue;
      const filePath = path.join(dir, name);
      fs.promises.stat(filePath)
        .then((stat) => Promise.all([contentEtag(filePath, stat), brotliVariant(filePath)]))
        .then(([, br]) => console.log(`${game}/Build/${name}: ${br ? "brotli verified" : "identity only"}`))
        .catch((err) => console.warn(`${game}/Build/${name}: ${err.message}`));
    }
  }
}
