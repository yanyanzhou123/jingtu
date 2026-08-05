/**
 * 定时消化段落向量索引（检索卡已停用）。
 * 部署：在仓库根目录执行 npm run deploy:cron
 */
export interface Env {
  SITE_URL: string;
  CRON_SECRET: string;
}

async function post(env: Env, path: string, body: object) {
  const base = (env.SITE_URL || 'https://huidengjingtu.win').replace(/\/$/, '');
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cron-Secret': env.CRON_SECRET,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`${path} ${res.status}: ${text.slice(0, 500)}`);
}

async function tick(env: Env) {
  await post(env, '/api/passages', { action: 'process', limit: 8 });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(tick(env));
  },
  async fetch(_request: Request, env: Env): Promise<Response> {
    await tick(env);
    return new Response('ok');
  },
};
