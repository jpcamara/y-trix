import { defineConfig } from '@playwright/test'
// BROWSERS=chromium,webkit,firefox picks the engines. Firefox is not in the
// default set because Playwright's Firefox build does not start on macOS 27.
const browsers = (process.env.BROWSERS || 'chromium,webkit').split(',')
export default defineConfig({
  testDir: 'tests',
  timeout: 30000,
  fullyParallel: true,
  use: { baseURL: 'http://localhost:5175' },
  projects: browsers.map((name) => ({ name, use: { browserName: name } })),
  webServer: { command: 'node demo/server.js', port: 5175, reuseExistingServer: true }
})
