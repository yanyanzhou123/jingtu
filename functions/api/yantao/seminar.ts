import { type Env, json } from '../../_lib/auth';
import { allowRequest, deepseekChat, stripMarkdownNoise } from '../../_lib/deepseek';
import { loadSession, newSessionId, saveSession, type ChatTurn } from '../../_lib/yantao';

type SeminarSession = {
  expiresAt: number;
  topic: string;
  history: ChatTurn[];
  done: boolean;
};

const SEMINAR_SYSTEM = `你是「慧灯净土 · 佛学圆桌」的主持人与流程执行者。目标是求真、辩证、共建知识网络。

角色与规则：
1. 你扮演「主持」（理性之锚）：冷静、洞察，引导高强度思想交锋，始终朝更深核心推进。
2. 根据议题动态邀请 3～4 位「佛学相关」典型代表人物（祖师、论师、译师、禅净密等宗门见地的代表性人格）。
   - 只选与佛教 / 藏传 / 汉传 / 南传佛学相关的人物或宗门典型立场。
   - 禁止邀请西方世俗哲学家、科学家、企业家等非佛学人物作为圆桌嘉宾。
   - 若需极短对照外学，只能由主持人一句话点明，不得让其成为发言嘉宾。
3. 每位代表发言格式：【姓名】【行动：主张/质询/补正/综合】：正文
   正文末可有一行「简言之：……」
4. 每一完整轮次顺序：
   a) 多位代表就当前引导问题依次发言（即时交锋，可互指）
   b) 主持人综述本轮核心争议
   c) 用等宽字符给出一个简短 ASCII 思考框架（概括结构，勿过长）
   d) 提出下一引导问题
   e) 提示指令：（可 / 止 / 深入此节 / 引入新人物）
5. 学员指令含义：
   - 可：采纳下一引导问题，开启新一轮代表发言+综述
   - 止：结束圆桌，输出结构化「知识网络」小结（议题、各方要点、争议、暂结）
   - 深入此节：不推进新题，围绕上一核心争议加深一轮
   - 引入新人物：请学员给出人物名后，以佛学人物加入并先陈述立场，再继续
6. 开场：确认议题 → 列出代表人物（姓名+一两句宗风/见地特征，可用简短性格标签）→ 先请各方定义议题核心概念。
7. 文风：严肃求真、中文；少用 Markdown（不要 **、#）；可用「1. 2. 3.」与 ASCII 图。
8. 你不能替代依止上师；圆桌是闻思辅助。`;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  if (!(await allowRequest(request, { prefix: 'jx-yantao-seminar', perMin: 6 }))) {
    return json({ error: '提问过于频繁，请稍后再试。' }, 429);
  }
  if (!env.DEEPSEEK_API_KEY) return json({ error: '未配置 DeepSeek API Key' }, 500);
  if (!env.FILES) return json({ error: '未绑定 R2' }, 500);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }

  const action = String(body?.action || '').trim();

  try {
    if (action === 'start') {
      const topic = String(body.topic || '').trim();
      if (!topic) return json({ error: '请输入研讨议题' }, 400);
      if (topic.length > 300) return json({ error: '议题过长' }, 400);

      const sessionId = await newSessionId();
      const opening = await deepseekChat(
        env.DEEPSEEK_API_KEY,
        SEMINAR_SYSTEM,
        `学员提出议题：「${topic}」\n\n请按规则完成开场：致谢、确认议题、邀请佛学代表人物并简介、提出开场定义问题，最后提示指令（可 / 止 / 深入此节 / 引入新人物）。本轮先不要让代表长篇发言，把定义题抛出即可。`,
        { temperature: 0.45, maxTokens: 2000 },
      );

      const reply = stripMarkdownNoise(opening);
      const session: SeminarSession = {
        expiresAt: 0,
        topic,
        done: false,
        history: [
          { role: 'user', content: `议题：${topic}` },
          { role: 'assistant', content: reply },
        ],
      };
      await saveSession(env, 'seminar', sessionId, session as any);

      return json({ ok: true, sessionId, topic, reply, done: false });
    }

    if (action === 'command' || action === 'reply') {
      const sessionId = String(body.sessionId || '').trim();
      const message = String(body.message || body.command || '').trim();
      if (!sessionId) return json({ error: '缺少会话' }, 400);
      if (!message) return json({ error: '请输入内容或指令' }, 400);
      if (message.length > 1500) return json({ error: '内容过长' }, 400);

      const session = await loadSession<SeminarSession>(env, 'seminar', sessionId);
      if (!session) return json({ error: '会话已过期，请重新开始' }, 410);
      if (session.done) {
        return json({
          ok: true,
          sessionId,
          done: true,
          reply: '本场圆桌已结束。若要另开议题，请返回重新开始。',
        });
      }

      const cmd = message.replace(/\s+/g, '');
      let userLine = message;
      if (cmd === '可') userLine = '指令：可（采纳下一引导问题，开启新一轮完整讨论）';
      else if (cmd === '止') userLine = '指令：止（结束圆桌，请输出知识网络小结）';
      else if (cmd === '深入此节' || cmd === '深入') userLine = '指令：深入此节（围绕上一核心争议加深）';
      else if (cmd.startsWith('引入新人物') || cmd.startsWith('引入')) {
        userLine = `指令：引入新人物。学员说明：${message}`;
      }

      session.history.push({ role: 'user', content: userLine });
      const transcript = session.history
        .slice(-10)
        .map((t) => `${t.role === 'user' ? '学员' : '圆桌'}：${t.content}`)
        .join('\n\n');

      let raw = await deepseekChat(
        env.DEEPSEEK_API_KEY,
        SEMINAR_SYSTEM,
        `核心议题：「${session.topic}」\n\n对话记录：\n${transcript}\n\n请根据学员最新输入继续圆桌。若指令为「可」或「深入此节」，请产出完整一轮（代表发言→主持综述→ASCII框架→新问题→指令提示）。若为「止」，只做结束与知识网络，勿再提示继续。`,
        { temperature: 0.45, maxTokens: 3500 },
      );
      raw = stripMarkdownNoise(raw);

      const done = cmd === '止' || /知识网络|暂告一段落|圆桌结束/.test(raw);
      session.done = done;
      session.history.push({ role: 'assistant', content: raw });
      if (session.history.length > 20) session.history = session.history.slice(-20);
      await saveSession(env, 'seminar', sessionId, session as any);

      return json({ ok: true, sessionId, reply: raw, done });
    }

    return json({ error: `未知 action: ${action}` }, 400);
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
};
