import { type Env, json } from '../../_lib/auth';
import { extractLessonsFromCatalog } from '../../_lib/cards';
import { allowRequest, deepseekChat, stripMarkdownNoise } from '../../_lib/deepseek';
import {
  clipLessonText,
  loadSession,
  newSessionId,
  saveSession,
  type ChatTurn,
} from '../../_lib/yantao';

const CATALOG_KEY = 'config/catalog.json';
/** 低于此长度或带占位标记的课文不可考问 */
const MIN_EXAM_CHARS = 80;

function isExamableText(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/[（(]\s*占位\s*[）)]/.test(t)) return false;
  if (/^(待补充|暂无正文|占位|内容待上传)/.test(t)) return false;
  return t.length >= MIN_EXAM_CHARS;
}

type ExamQuestion = { id: number; prompt: string };

type ExamSession = {
  expiresAt: number;
  moduleSlug: string;
  lessonSlug: string;
  moduleTitle: string;
  lessonTitle: string;
  lessonText: string;
  questions: ExamQuestion[];
  currentIndex: number;
  /** waiting_answer | discussing | done */
  phase: 'waiting_answer' | 'discussing' | 'done';
  history: ChatTurn[];
};

async function loadCatalog(env: Env, request: Request): Promise<any> {
  if (env.FILES) {
    const obj = await env.FILES.get(CATALOG_KEY);
    if (obj) return obj.json();
  }
  const origin = new URL(request.url).origin;
  const res = await fetch(`${origin}/catalog.seed.json`);
  if (!res.ok) throw new Error('无法加载学修目录');
  return res.json();
}

function findLesson(catalog: any, moduleSlug: string, lessonSlug: string) {
  const lessons = extractLessonsFromCatalog(catalog);
  return lessons.find((l) => l.moduleSlug === moduleSlug && l.lessonSlug === lessonSlug) || null;
}

function parseQuestions(raw: string): ExamQuestion[] {
  const text = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const obj = JSON.parse(text.slice(start, end + 1));
    const arr = Array.isArray(obj?.questions) ? obj.questions : [];
    return arr
      .map((q: any, i: number) => ({
        id: i + 1,
        prompt: String(q?.prompt || q?.question || q || '').trim(),
      }))
      .filter((q: ExamQuestion) => q.prompt.length >= 4)
      .slice(0, 5);
  } catch {
    return [];
  }
}

const KHENPO_SYSTEM = `你是慧灯净土网站的考问堪布。风格恭敬、严肃、清晰，如真实依止上师前的口试。
规则：
1. 只能依据给定「本课原文」出题、点评、追问；原文未述及的不要引入，可说「本课原文未展开」。
2. 不编造经论出处，不替代上师与实修决断；仅作辅助考问。
3. 用语简洁中文，不要 Markdown（不要 **、#、列表符 -）。
4. 一次只推进当前这一题的研讨，不要一次抛出所有题。`;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  if (!(await allowRequest(request, { prefix: 'jx-yantao-exam', perMin: 8 }))) {
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
      const moduleSlug = String(body.moduleSlug || '').trim();
      const lessonSlug = String(body.lessonSlug || '').trim();
      if (!moduleSlug || !lessonSlug) return json({ error: '请选择模块与课次' }, 400);

      const catalog = await loadCatalog(env, request);
      const lesson = findLesson(catalog, moduleSlug, lessonSlug);
      if (!lesson?.text?.trim()) return json({ error: '未找到该课或课文为空' }, 404);
      if (!isExamableText(lesson.text)) {
        return json(
          {
            error:
              '本课尚无足够正文（多为占位），请先在运营后台补全文稿后再考问。',
          },
          400,
        );
      }

      const lessonText = clipLessonText(lesson.text, 12000);
      const genRaw = await deepseekChat(
        env.DEEPSEEK_API_KEY,
        `${KHENPO_SYSTEM}
现在请根据原文出 3～5 道理解义理的问答题（不要死记硬背填空）。
只输出 JSON：{"questions":[{"prompt":"问题全文"}]}`,
        `课程：${lesson.moduleTitle} · ${lesson.lessonTitle}\n\n本课原文：\n${lessonText}`,
        { temperature: 0.35, jsonMode: true },
      );
      const questions = parseQuestions(genRaw);
      if (questions.length < 2) {
        return json({ error: '出题失败，请重试' }, 502);
      }

      const sessionId = await newSessionId();
      const first = questions[0];
      const opening = `善。今日就「${lesson.moduleTitle} · ${lesson.lessonTitle}」略作考问，共 ${questions.length} 题。请依本课所闻如理作答。\n\n第一题：${first.prompt}`;

      const session: ExamSession = {
        expiresAt: 0,
        moduleSlug,
        lessonSlug,
        moduleTitle: lesson.moduleTitle,
        lessonTitle: lesson.lessonTitle,
        lessonText,
        questions,
        currentIndex: 0,
        phase: 'waiting_answer',
        history: [{ role: 'assistant', content: opening }],
      };
      await saveSession(env, 'exam', sessionId, session as any);

      return json({
        ok: true,
        sessionId,
        lessonTitle: `${lesson.moduleTitle} · ${lesson.lessonTitle}`,
        questionCount: questions.length,
        currentIndex: 0,
        phase: session.phase,
        reply: opening,
      });
    }

    if (action === 'reply') {
      const sessionId = String(body.sessionId || '').trim();
      const message = String(body.message || '').trim();
      if (!sessionId) return json({ error: '缺少会话' }, 400);
      if (!message) return json({ error: '请输入作答' }, 400);
      if (message.length > 2000) return json({ error: '回答过长' }, 400);

      const session = await loadSession<ExamSession>(env, 'exam', sessionId);
      if (!session) return json({ error: '会话已过期，请重新开始' }, 410);
      if (session.phase === 'done') {
        return json({
          ok: true,
          sessionId,
          phase: 'done',
          currentIndex: session.currentIndex,
          reply: '本次考问已结束。若要再考，请重新选择课次开始。',
        });
      }

      const q = session.questions[session.currentIndex];
      const userMsg = `学员作答：${message}`;
      session.history.push({ role: 'user', content: userMsg });

      const transcript = session.history
        .slice(-8)
        .map((t) => `${t.role === 'user' ? '学员' : '堪布'}：${t.content}`)
        .join('\n\n');

      const guide =
        session.phase === 'waiting_answer'
          ? `当前是第 ${session.currentIndex + 1}/${session.questions.length} 题：「${q.prompt}」。
请依据原文点评学员作答：先判定大体是否相应，再指出欠缺或可延伸处；可提出一个简短追问。
若学员已答得充分，或主动说「下一题」「请继续」，则在回复末尾单独一行写：【进入下一题】
若这是最后一题且已可结束，写：【结束考问】`
          : `仍在第 ${session.currentIndex + 1} 题的研讨中。继续依原文回应；充分后写【进入下一题】或【结束考问】。`;

      let raw = await deepseekChat(
        env.DEEPSEEK_API_KEY,
        KHENPO_SYSTEM,
        `课程：${session.moduleTitle} · ${session.lessonTitle}\n\n本课原文（节选）：\n${session.lessonText.slice(0, 9000)}\n\n对话：\n${transcript}\n\n${guide}`,
        { temperature: 0.35 },
      );
      raw = stripMarkdownNoise(raw);

      let nextIndex = session.currentIndex;
      let phase = session.phase === 'waiting_answer' ? 'discussing' : session.phase;
      let reply = raw
        .replace(/【进入下一题】/g, '')
        .replace(/【结束考问】/g, '')
        .trim();

      if (/【结束考问】/.test(raw) || (session.currentIndex >= session.questions.length - 1 && /【进入下一题】/.test(raw))) {
        phase = 'done';
        const summary = await deepseekChat(
          env.DEEPSEEK_API_KEY,
          KHENPO_SYSTEM,
          `课程：${session.moduleTitle} · ${session.lessonTitle}\n原文要点依据：\n${session.lessonText.slice(0, 6000)}\n\n考问题目：\n${session.questions.map((x) => x.prompt).join('\n')}\n\n请作简短总评（优缺点）与两条复习建议，仍须依据本课原文。不要 Markdown。`,
          { temperature: 0.3 },
        );
        reply = `${reply}\n\n——\n${stripMarkdownNoise(summary)}`;
      } else if (/【进入下一题】/.test(raw)) {
        nextIndex = session.currentIndex + 1;
        if (nextIndex >= session.questions.length) {
          phase = 'done';
        } else {
          phase = 'waiting_answer';
          const nq = session.questions[nextIndex];
          reply = `${reply}\n\n第 ${nextIndex + 1} 题：${nq.prompt}`;
        }
      }

      session.currentIndex = Math.min(nextIndex, session.questions.length - 1);
      session.phase = phase as ExamSession['phase'];
      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 24) session.history = session.history.slice(-24);
      await saveSession(env, 'exam', sessionId, session as any);

      return json({
        ok: true,
        sessionId,
        phase: session.phase,
        currentIndex: session.currentIndex,
        questionCount: session.questions.length,
        reply,
      });
    }

    return json({ error: `未知 action: ${action}` }, 400);
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
};
