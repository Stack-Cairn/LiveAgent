import { createServer } from 'node:http';

const nodePort = process.env.LIVEAGENT_NODE_PORT;
const backendPort = process.env.LIVEAGENT_BACKEND_PORT;
const internalToken = process.env.LIVEAGENT_INTERNAL_TOKEN;

// 校验所有必需的环境变量
if (!nodePort) {
  console.error('Missing required environment variable: LIVEAGENT_NODE_PORT');
  process.exit(1);
}

if (!backendPort) {
  console.error('Missing required environment variable: LIVEAGENT_BACKEND_PORT');
  process.exit(1);
}

if (!internalToken) {
  console.error('Missing required environment variable: LIVEAGENT_INTERNAL_TOKEN');
  process.exit(1);
}

const server = createServer((req, res) => {
  // 健康检查端点，不需要验证 token
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // 校验 Authorization header
  const authHeader = req.headers.authorization;
  const expectedAuth = `Bearer ${internalToken}`;

  if (authHeader !== expectedAuth) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    return;
  }

  // 目前只有健康检查，其它请求暂不处理
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(parseInt(nodePort), '127.0.0.1', () => {
  console.log(`Node engine listening on 127.0.0.1:${nodePort}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  server.close(() => {
    process.exit(0);
  });
});
