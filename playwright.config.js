import { defineConfig } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// BROWSERS=chromium,webkit,firefox picks the engines.
const browsers = (process.env.BROWSERS || 'chromium,webkit,firefox').split(',')
// macOS 27 denies Firefox its app-data folder (~/Library/Application Support/
// Firefox) and it exits with "Could not find profile folder". A stand-in home
// for the browser process gets it past that.
const firefoxHome = join(tmpdir(), 'playwright-firefox-home')
if (process.platform === 'darwin') mkdirSync(firefoxHome, { recursive: true })
const use = (name) => name === 'firefox' && process.platform === 'darwin'
  ? { browserName: name, launchOptions: { env: { ...process.env, CFFIXED_USER_HOME: firefoxHome } } }
  : { browserName: name }
export default defineConfig({
  testDir: 'tests',
  timeout: 30000,
  fullyParallel: true,
  use: { baseURL: 'http://localhost:5175' },
  projects: browsers.map((name) => ({ name, use: use(name) })).concat(browsers.includes('chromium')
    // The oldest Trix the peer range allows. TRIX_VERSIONS=a,b tries others
    // (install trix-<version> aliases and bundle demo/dist/main-<version>.js).
    ? (process.env.TRIX_VERSIONS || '2.1.15').split(',').map((v) => ({ name: 'chromium-trix' + v, use: use('chromium'), metadata: { trix: v }, testMatch: /(sync|security)\.spec\.js/ }))
    : []),
  webServer: [
    { command: 'node demo/server.js', port: 5175, reuseExistingServer: true },
    // Two y-websocket servers for tests/provider.spec.js: the last release on
    // Yjs 13 (0.1.1, with LevelDB persistence) and the latest (0.1.5, which
    // runs Yjs 14 inside; package.json pins @y/protocols so it gets one copy).
    { command: 'node node_modules/y-websocket-server-13/src/server.js', env: { PORT: '5185', YPERSISTENCE: join(tmpdir(), 'y-trix-test-leveldb') }, port: 5185, reuseExistingServer: true },
    { command: 'node node_modules/@y/websocket-server/src/server.js', env: { PORT: '5187' }, port: 5187, reuseExistingServer: true }
  ]
})
