/**
 * Saving the property's imagery to the phone, for use out of signal.
 *
 * Tiles are simply requested; the service worker keeps every QLD tile it
 * sees, so asking for them all once is enough. That only works when a service
 * worker is running, which browsers allow over HTTPS (the Cloudflare address)
 * but not over plain HTTP on the LAN — so the button says so rather than
 * appearing to work.
 */

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/** Every tile covering the bounds, from minZoom to maxZoom inclusive. */
export function tilesFor(bounds, minZoom, maxZoom) {
  const out = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const x0 = lon2x(bounds.getWest(), z), x1 = lon2x(bounds.getEast(), z);
    const y0 = lat2y(bounds.getNorth(), z), y1 = lat2y(bounds.getSouth(), z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  }
  return out;
}

export function offlineSupported() {
  return "serviceWorker" in navigator && !!navigator.serviceWorker.controller;
}

/**
 * Fetches the tiles a few at a time. Resolves with counts; `onProgress` is
 * called as it goes, and `signal` stops it early.
 */
export async function downloadTiles(source, tiles, onProgress, signal) {
  // Ask the browser not to evict the cache under storage pressure. It may
  // say no; the tiles are still saved, just less permanently.
  try { await navigator.storage?.persist?.(); } catch { /* ignore */ }

  let done = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < tiles.length && !signal.aborted) {
      const [z, x, y] = tiles[next++];
      try {
        const res = await fetch(`/tiles/${source}/${z}/${x}/${y}`, { signal });
        if (!res.ok && res.status !== 404) failed++;
        await res.arrayBuffer();
      } catch {
        if (signal.aborted) return;
        failed++;
      }
      done++;
      onProgress(done, failed);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { done, failed };
}
