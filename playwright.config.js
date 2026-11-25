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
  projects: browsers.map((name) => ({ name, use: use(name) })),
  webServer: [
    { command: 'node demo/server.js', port: 5175, reuseExistingServer: true },
    // The y-websocket 2 server with LevelDB persistence, for
    // tests/provider.spec.js. (@y/websocket-server 0.1.5 fails on every update.)
    { command: 'node node_modules/y-websocket-server/bin/server.cjs', env: { PORT: '5185', YPERSISTENCE: join(tmpdir(), 'y-trix-test-leveldb') }, port: 5185, reuseExistingServer: true }
  ]
})
