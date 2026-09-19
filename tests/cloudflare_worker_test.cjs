// Run with: node tests/cloudflare_worker_test.cjs
// Checks the Cloudflare Worker (cloudflare/worker.js) without Cloudflare or npm packages:
// @cloudflare/containers is replaced by a small stand-in, so this tests the routing and
// error handling written in this repository, not Cloudflare itself.
const fs = require('node:fs'), assert = require('node:assert/strict');

const mock = `
const calls = globalThis.__calls = {start: [], containerFetch: [], stubFetch: [], assets: []};
export class Container {
  constructor(state) { this.__state = state || 'stopped'; }
  async getState() { return {status: this.__state}; }
  async startAndWaitForPorts(args) { calls.start.push(args); if (globalThis.__startFails) throw new Error('slow start'); this.__state = 'healthy'; }
  async containerFetch(request, port) { calls.containerFetch.push({url: request.url, port}); return new Response('{"ok":true}', {headers: {'Content-Type': 'application/json'}}); }
}
export function getContainer(binding, name = 'cf-singleton-container') { return binding.get(name); }
`;
const source = fs.readFileSync('cloudflare/worker.js', 'utf8')
  .replace(/import\s*\{[^}]*\}\s*from\s*'@cloudflare\/containers';/, mock);

(async () => {
  const worker = await import('data:text/javascript,' + encodeURIComponent(source));
  const calls = globalThis.__calls;
  const reply = {value: null};
  const env = {
    ASSETS: {fetch: async request => { calls.assets.push(new URL(request.url).pathname); return new Response('<html>page</html>', {headers: {'Content-Type': 'text/html'}}); }},
    BACKEND: {get: name => ({fetch: async request => { calls.stubFetch.push({name, path: new URL(request.url).pathname, method: request.method}); if (reply.value instanceof Error) throw reply.value; return reply.value; }})},
  };
  const site = 'https://root-plotting-tool.example.workers.dev';

  // Pages go to static assets; the API goes to the single shared container.
  let response = await worker.default.fetch(new Request(site + '/classic'), env);
  assert.equal(await response.text(), '<html>page</html>');
  assert.deepEqual(calls.assets, ['/classic']);
  assert.equal(calls.stubFetch.length, 0);

  reply.value = new Response(JSON.stringify({error: 'A simultaneous fit needs at least two datasets.'}), {status: 400, headers: {'Content-Type': 'application/json'}});
  response = await worker.default.fetch(new Request(site + '/simultaneous-fit', {method: 'POST', body: '{}'}), env);
  assert.equal(response.status, 400, 'Flask errors pass through unchanged');
  assert.equal((await response.json()).error, 'A simultaneous fit needs at least two datasets.');
  assert.deepEqual(calls.stubFetch.at(-1), {name: 'cf-singleton-container', path: '/simultaneous-fit', method: 'POST'});

  // Plain-text platform errors become JSON the page can display.
  reply.value = new Response('There is no Container instance available at this time.\nThis is likely because ...', {status: 503});
  response = await worker.default.fetch(new Request(site + '/fit', {method: 'POST', body: '{}'}), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  const error = (await response.json()).error;
  assert.match(error, /starting or unavailable \(HTTP 503: There is no Container instance available at this time\.\)/);
  assert.doesNotMatch(error, /This is likely/, 'only the first line of the platform message is shown');

  reply.value = new Error('network lost');
  response = await worker.default.fetch(new Request(site + '/health'), env);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /could not be reached \(network lost\)/);
  assert.deepEqual(calls.assets, ['/classic'], 'API paths never fall through to static assets');

  // The container class waits longer than the library default while ROOT loads, then forwards.
  const backend = new worker.RootFitBackend('stopped');
  await backend.fetch(new Request(site + '/fit', {method: 'POST', body: '{}'}));
  assert.equal(calls.start.length, 1);
  assert.equal(calls.start[0].ports, 8000);
  assert.equal(calls.start[0].cancellationOptions.portReadyTimeoutMS, 120000);
  assert.deepEqual(calls.containerFetch.at(-1), {url: site + '/fit', port: 8000});
  await backend.fetch(new Request(site + '/fit', {method: 'POST', body: '{}'}));
  assert.equal(calls.start.length, 1, 'a healthy container is not restarted');
  globalThis.__startFails = true;
  await new worker.RootFitBackend('stopped').fetch(new Request(site + '/health'));
  assert.equal(calls.containerFetch.length, 3, 'a failed slow start still hands the request to containerFetch');
  assert.equal(backend.sleepAfter, '15m');

  // The Worker, wrangler.jsonc and Flask agree on the list of API routes.
  const routes = new Set([...fs.readFileSync('backend/app.py', 'utf8').matchAll(/@app\.(?:route|post|get)\(\s*["'](\/[^"'<]*)["']/g)].map(m => m[1]).filter(p => p !== '/'));
  assert.deepEqual([...worker.API_PATHS].sort(), [...routes].sort(), 'API_PATHS in worker.js matches the Flask routes');
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/[^"\n]*$/gm, ''));
  assert.deepEqual([...config.assets.run_worker_first].sort(), [...routes].sort(), 'run_worker_first in wrangler.jsonc matches the Flask routes');
  assert.equal(config.name, 'root-plotting-tool');
  assert.equal(config.containers[0].class_name, 'RootFitBackend');
  assert.equal(config.durable_objects.bindings[0].class_name, 'RootFitBackend');
  assert.ok(fs.existsSync(config.containers[0].image), 'the Dockerfile named in wrangler.jsonc exists');
  const app = fs.readFileSync('frontend/app.js', 'utf8');
  assert.match(app, /const DEFAULT_BACKEND = 'https:\/\/root-plotting-tool\.tranxuongminh\.workers\.dev'/);
  console.log('OK: Cloudflare Worker routing, container start-up, readable platform errors, and route lists in sync.');
})().catch(error => { console.error(error); process.exit(1); });
