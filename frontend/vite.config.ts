import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// 3D ?붿????몄쐢(twin/ ?대뜑, 鍮뚮뱶 ?녿뒗 HTML쨌JS)??/twin/ 二쇱냼濡?媛숈씠 ?꾩?
//   媛쒕컻: npm run dev ??http://localhost:5173/twin/digital-twin.html
//   鍮뚮뱶: dist/twin/ ?쇰줈 蹂듭궗 (EnergyPlus 寃곌낵 sim/ ? ?쒖쇅)
//   ?댁쟾 ?쒕??덉씠??怨꾩궛(/api/sim)? npm run twin:sim ?쇰줈 ?꾩슫 怨꾩궛 ?쒕쾭(8766)濡??섍?
const TWIN_DIR = path.resolve(import.meta.dirname, 'twin')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8', '.md': 'text/plain; charset=utf-8',
}
function experiment(): Plugin {
  let running = false
  return {
    name: 'local-scenario-experiment',
    configureServer(server) {
      server.middlewares.use('/api/experiment', async (req, res) => {
        const lookup = (code: number, body: string) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(body)
        }
        const error = (code: number, message: string) => lookup(code, JSON.stringify({ error: message }))
        if (req.url !== '/' && req.url !== '') return error(404, '실험 주소를 찾을 수 없습니다.')
        if (req.method !== 'POST') return error(405, 'POST 요청만 지원합니다.')
        if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['content-type'] !== 'application/json')
          return error(403, '로컬 대시보드에서 실험을 실행하세요.')
        let engine: unknown
        try {
          let body = ''
          for await (const chunk of req) {
            body += chunk.toString()
            if (body.length > 256) return error(413, '실험 요청이 너무 큽니다.')
          }
          engine = JSON.parse(body).engine
        } catch {
          return error(400, '실험 요청을 읽을 수 없습니다.')
        }
        if (engine !== '5r1c' && engine !== 'energyplus' && engine !== 'both')
          return error(400, '지원하지 않는 실험 엔진입니다.')
        if (running) return error(409, '다른 실험이 실행 중입니다. 잠시 후 다시 시도하세요.')
        running = true
        execFile(process.execPath, [path.join(TWIN_DIR, 'tools', 'experiment-web.mjs'), engine],
          { cwd: TWIN_DIR, timeout: 120_000, windowsHide: true },
          (failure, stdout, stderr) => {
            running = false
            if (failure) return error(500, stderr.trim() || '실험을 실행하지 못했습니다.')
            lookup(200, stdout)
          })
      })
    },
  }
}

function twin(): Plugin {
  return {
    name: 'digital-twin',
    configureServer(server) {
      server.middlewares.use('/twin', (req, res, next) => {
        let p = decodeURIComponent((req.url || '/').split('?')[0])
        if (p.endsWith('/')) p += 'digital-twin.html'
        const f = path.resolve(TWIN_DIR, '.' + p)
        if (!f.startsWith(TWIN_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return next()
        res.setHeader('Content-Type', TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-store')
        fs.createReadStream(f).pipe(res)
      })
    },
    closeBundle() {
      const out = path.resolve(import.meta.dirname, 'dist', 'twin')
      if (fs.existsSync(path.resolve(import.meta.dirname, 'dist'))) fs.cpSync(TWIN_DIR, out, { recursive: true, filter: (s) => !s.includes(`${path.sep}sim${path.sep}`) && !s.endsWith(`${path.sep}sim`) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), twin(), experiment()],
  server: { proxy: { '/api/sim': 'http://127.0.0.1:8766' } },
})
