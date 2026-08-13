interface Env {
  DB: D1Database;
  TRANSCODE_SERVER: string;
  TRANSCODE_TOKEN: string;
}

interface TranscodeTask {
  job_id: string;
  source_url: string;
  output_path: string;
  mode: string;
  status: string;
  progress: number;
  message?: string;
  module_slug?: string;
  lesson_slug?: string;
  split_points?: string;
  segments?: string;
  error?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'GET') {
    if (path === '/api/transcode/jobs') {
      return listTasks(env);
    }
    const match = path.match(/^\/api\/transcode\/jobs\/([^/]+)$/);
    if (match) {
      return getTask(env, match[1]);
    }
  }

  if (request.method === 'POST' && path === '/api/transcode/jobs') {
    return createTask(request, env);
  }

  if (request.method === 'DELETE') {
    const match = path.match(/^\/api\/transcode\/jobs\/([^/]+)$/);
    if (match) {
      return deleteTask(env, match[1]);
    }
  }

  if (request.method === 'PATCH') {
    const match = path.match(/^\/api\/transcode\/jobs\/([^/]+)$/);
    if (match) {
      return updateTask(env, match[1], request);
    }
  }

  return json({ error: 'Not Found' }, 404);
};

async function createTask(request: Request, env: Env) {
  const body = await request.json();
  const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const splitPoints = body.split_points ? JSON.stringify(body.split_points) : null;

  await env.DB.prepare(
    `INSERT INTO transcode_tasks
     (job_id, source_url, output_path, mode, status, progress, message, module_slug, lesson_slug, split_points)
     VALUES (?, ?, ?, ?, 'pending', 0, '任务已创建', ?, ?, ?)`
  )
    .bind(
      jobId,
      body.source_url,
      body.output_path,
      body.mode || 'transcode',
      body.module_slug || null,
      body.lesson_slug || null,
      splitPoints
    )
    .run();

  const serverUrl = env.TRANSCODE_SERVER || 'http://localhost:8765';

  try {
    const response = await fetch(`${serverUrl}/api/transcode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.TRANSCODE_TOKEN || ''}`,
      },
      body: JSON.stringify({
        ...body,
        output_path: body.output_path,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      await env.DB.prepare(
        `UPDATE transcode_tasks SET status='failed', error=?, message='转码服务调用失败' WHERE job_id=?`
      )
        .bind(errorText, jobId)
        .run();

      return json({ error: '转码服务调用失败', detail: errorText }, 500);
    }
  } catch (err: any) {
    await env.DB.prepare(
      `UPDATE transcode_tasks SET status='failed', error=?, message='无法连接转码服务' WHERE job_id=?`
    )
      .bind(err.message, jobId)
      .run();

    return json({ error: '无法连接转码服务', detail: err.message }, 502);
  }

  return json({
    job_id: jobId,
    status: 'pending',
    message: '任务已创建，转码服务正在处理',
  });
}

async function getTask(env: Env, jobId: string) {
  const result = await env.DB.prepare(
    'SELECT * FROM transcode_tasks WHERE job_id = ?'
  )
    .bind(jobId)
    .first();

  if (!result) {
    return json({ error: '任务不存在' }, 404);
  }

  return json({
    id: result.id,
    job_id: result.job_id,
    source_url: result.source_url,
    output_path: result.output_path,
    mode: result.mode,
    status: result.status,
    progress: result.progress,
    message: result.message,
    module_slug: result.module_slug,
    lesson_slug: result.lesson_slug,
    split_points: result.split_points ? JSON.parse(result.split_points) : null,
    segments: result.segments ? JSON.parse(result.segments) : null,
    error: result.error,
    created_at: result.created_at,
    updated_at: result.updated_at,
  });
}

async function listTasks(env: Env) {
  const result = await env.DB.prepare(
    `SELECT * FROM transcode_tasks
     ORDER BY created_at DESC
     LIMIT 50`
  ).all();

  return json({
    total: result.results.length,
    jobs: result.results.map((r) => ({
      id: r.id,
      job_id: r.job_id,
      status: r.status,
      progress: r.progress,
      message: r.message,
      source_url: r.source_url,
      output_path: r.output_path,
      mode: r.mode,
      module_slug: r.module_slug,
      lesson_slug: r.lesson_slug,
      created_at: r.created_at,
    })),
  });
}

async function updateTask(env: Env, jobId: string, request: Request) {
  const body = await request.json();

  const fields: string[] = [];
  const values: any[] = [];

  if (body.status) {
    fields.push('status = ?');
    values.push(body.status);
  }
  if (body.progress !== undefined) {
    fields.push('progress = ?');
    values.push(body.progress);
  }
  if (body.message) {
    fields.push('message = ?');
    values.push(body.message);
  }
  if (body.segments) {
    fields.push('segments = ?');
    values.push(JSON.stringify(body.segments));
  }
  if (body.error) {
    fields.push('error = ?');
    values.push(body.error);
  }

  if (fields.length === 0) {
    return json({ error: '无更新字段' }, 400);
  }

  fields.push("updated_at = datetime('now', 'localtime')");
  values.push(jobId);

  await env.DB.prepare(
    `UPDATE transcode_tasks SET ${fields.join(', ')} WHERE job_id = ?`
  )
    .bind(...values)
    .run();

  return json({ status: 'ok' });
}

async function deleteTask(env: Env, jobId: string) {
  await env.DB.prepare('DELETE FROM transcode_tasks WHERE job_id = ?')
    .bind(jobId)
    .run();

  return json({ status: 'ok' });
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
