// Minimal static server for the demo and tests.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }
const port = Number(process.env.PORT || 5175)

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (path === '/') path = '/demo/index.html'
  const file = normalize(join(root, path))
  if (!file.startsWith(root)) { res.writeHead(403); return res.end() }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('not found')
  }
}).listen(port, () => console.log(`http://localhost:${port}/`))
