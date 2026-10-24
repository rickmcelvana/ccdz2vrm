# Deploying the website — `ccdz2vrm.latentpresence.com`

The page that converts in the browser is static files: `dist/` after `pnpm build`. There is no
server-side code, and nothing a visitor converts ever reaches the server: the FBX is read and the
VRM written inside their own browser tab (ENVIRONMENT.md §37). The same recipe as
latentPresence's app (`latentPresence/docs/deploy.md`): a checkout on the server, built in place,
served by Caddy.

## 1. Once, on the server

- **Node.js 22 or later** and **pnpm 12.3.4** (`npm install -g pnpm@12.3.4`). No Rust, Zig or
  Blender: the build is Vite alone, and the FBX reader's WebAssembly is committed
  (`app/src/convert/ufbx_contract.wasm`).
- A checkout:

  ```bash
  git clone https://github.com/rickmcelvana/ccdz2vrm.git
  ```

- DNS: `ccdz2vrm.latentpresence.com` → the server (done: it resolves to the same address as
  latentpresence.com).

## 2. Build, and every update

```bash
cd ccdz2vrm
git pull && pnpm install --frozen-lockfile && pnpm build
```

`dist/` should hold `index.html`, `icon.svg` and `assets/` with two `.wasm` files (the FBX reader,
~2.4 MB, and mozjpeg, ~250 KB).

## 3. Caddy

```
ccdz2vrm.latentpresence.com {
    root * /path/to/ccdz2vrm/dist
    encode zstd gzip

    # Built files carry a content hash in their names, so they can be cached for good.
    @hashed path /assets/*
    header @hashed Cache-Control "public, max-age=31536000, immutable"
    # The page itself is not hashed: always ask, so an update shows at once.
    @page path / /index.html
    header @page Cache-Control "no-cache"

    file_server
}
```

Then `caddy reload` (or `systemctl reload caddy`). Caddy gets the HTTPS certificate itself.

### Why each line

- **No cross-origin isolation headers** (unlike latentPresence's app): the converter uses no
  `SharedArrayBuffer`, and the page loads nothing from other origins.
- **`.wasm` needs no MIME line**: Caddy serves it as `application/wasm`. If a host ever doesn't,
  the worker falls back to a plain compile (tested with `application/octet-stream`).
- **No `try_files`**: it is one page with no routes.
- **Compression matters for first load**: the FBX reader's WebAssembly is 2.4 MB, 0.9 MB
  compressed; the page's script is 1.2 MB, 0.3 MB compressed.

## 4. Check it

Open `https://ccdz2vrm.latentpresence.com`, drop an FBX (or click the drop zone), convert at Web
quality, and Download. In the browser's dev tools, Network: the two `.wasm` files load with
status 200 and `content-encoding: zstd` (or `gzip`).
