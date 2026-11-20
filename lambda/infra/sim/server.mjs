// 컨테이너 HTTP 서버: Lambda Web Adapter가 Function URL 요청을 여기(PORT, 기본 8080)로 넘김 → handler.mjs 호출
//   GET /healthz: 어댑터 준비 확인(비밀 헤더 없이 200)
//   로컬 확인: docker run -p 8080:8080 -e SIM_SECRET=x maestro-sim:local → curl -H 'x-maestro-sim: x' localhost:8080/api/sim/status
import http from 'node:http';
import { handler } from './handler.mjs';

const MAX = 4 << 20;   // handler가 3MB에서 413으로 거절, 그보다 큰 요청은 여기서 끊음

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type':'text/plain' }); return res.end('ok'); }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX) { res.writeHead(413, { 'Content-Type':'application/json' }); return res.end('{"error":"too large"}'); } chunks.push(c); }
  try {
    const r = await handler({ rawPath:url.pathname, requestContext:{ http:{ method:req.method } }, headers:req.headers,
      body:Buffer.concat(chunks).toString('utf8'), isBase64Encoded:false });
    res.writeHead(r.statusCode, r.headers);
    res.end(r.body);
  } catch (e) {
    console.error(JSON.stringify({ sim:'server-error', message:String(e?.message).slice(0, 300) }));
    res.writeHead(500, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ error:'server error' }));
  }
}).listen(+process.env.PORT || 8080, () => console.log(`sim server :${+process.env.PORT || 8080}`));
