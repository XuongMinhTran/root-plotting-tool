/*
 * worker.js — the Cloudflare Worker for ROOT-A-TRON 3000.
 *
 * The pages in frontend/ are served as static assets. The fitting API
 * (/health, /allowed, /fit, /histogram, /simultaneous-fit) runs in a
 * Cloudflare Container built from backend/Dockerfile (Python, Flask and
 * CERN ROOT). Pages and API therefore share one address, and app.js finds
 * the API on its own origin.
 *
 * The container goes to sleep after `sleepAfter` without requests, and
 * Cloudflare stops charging for it while it sleeps. The next request wakes
 * it up; that first request waits several seconds while ROOT loads.
 *
 * Configuration: wrangler.jsonc in the repository root.
 */
import { Container, getContainer } from '@cloudflare/containers';

// Everything else is a page, script or style from frontend/.
export const API_PATHS = new Set(['/health', '/allowed', '/fit', '/histogram', '/simultaneous-fit']);

export class RootFitBackend extends Container {
  defaultPort = 8000;      // Flask listens here (backend/app.py)
  sleepAfter = '15m';      // stop after 15 minutes without requests

  async fetch(request) {
    // Importing ROOT takes several seconds on a small instance, which can exceed the
    // library's default 20-second readiness window after the container wakes up.
    if ((await this.getState()).status !== 'healthy') {
      try {
        await this.startAndWaitForPorts({
          ports: this.defaultPort,
          cancellationOptions: { instanceGetTimeoutMS: 30_000, portReadyTimeoutMS: 120_000, abort: request.signal },
        });
      } catch (_) {
        // containerFetch below tries again and turns a failure into a readable response.
      }
    }
    return this.containerFetch(request, this.defaultPort);
  }
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!API_PATHS.has(pathname)) return env.ASSETS.fetch(request);
    let response;
    try {
      response = await getContainer(env.BACKEND).fetch(request);
    } catch (error) {
      return jsonError(503, `The fitting service could not be reached (${error?.message || error}). It may still be starting; please try again in a minute. Your inputs are still here.`);
    }
    // Flask answers in JSON. Plain-text errors come from the container platform
    // (still provisioning, failed to start, busy); give the page a message it can show.
    if (response.ok || (response.headers.get('Content-Type') || '').includes('json')) return response;
    const detail = (await response.text()).trim().split('\n')[0].slice(0, 300);
    return jsonError(response.status >= 500 ? response.status : 502,
      `The fitting service is starting or unavailable (HTTP ${response.status}${detail ? ': ' + detail : ''}). If it was asleep or has just been deployed, wait a minute and try again. Your inputs are still here.`);
  },
};
