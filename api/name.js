import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

/**
 * 模型配置表：一处配置，一套调用代码。
 * 所有配置项都是 OpenAI 兼容网关，请求头、入参、SSE 分片格式完全一致，
 * 所以下方只需要写一段 fetch，不必给每个模型单独写分支。
 * 想接新模型：只在这里加一项配置即可（阶段2 甚至可以直接做前端下拉框）。
 */
const MODEL_CONFIG_MAP = {
  doubao: {
    label: '豆包 · 火山方舟',
    baseURL: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v1',
    apiKey: process.env.DOUBAO_API_KEY,
    model: process.env.DOUBAO_MODEL || '', // 火山方舟填接入点 ID（ep-xxx）或模型名
    // 豆包 2.x 默认开深度思考，会把大量 token 花在 reasoning_content 上：
    // 用户长时间看不到字，正式内容还容易被截断。起名这种任务不需要思考，直接关掉。
    extraBody: { thinking: { type: 'disabled' } },
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  },
  qwen: {
    label: '通义千问 · DashScope',
    baseURL: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.QWEN_API_KEY,
    model: process.env.QWEN_MODEL || 'qwen-plus',
  },
  kimi: {
    label: 'Kimi · 月之暗面',
    baseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1',
    apiKey: process.env.KIMI_API_KEY,
    model: process.env.KIMI_MODEL || 'moonshot-v1-8k',
  },
};

// 当前启用的模型：默认豆包，后面换模型只改环境变量 DEFAULT_MODEL，不用改代码
const DEFAULT_MODEL = (process.env.DEFAULT_MODEL || 'doubao').trim();

const SYSTEM_PROMPT = `你是一位资深的起名顾问，精通汉语音韵、字义训诂与中西命名文化。
请根据用户的需求，给出 3 组起名方案，每组都要包含名字、寓意解释和字义出处。

输出要求（严格遵守）：
1. 使用 Markdown，每个方案以 "### 方案一：名字" 开头，依次为方案一、方案二、方案三；
2. 每个方案内部固定三行小标题："**寓意**：..."、"**字义**：..."、"**风格**：..."；
3. 名字必须与需求中的性别、风格、字数、姓氏（若用户提到）严格匹配，避免生僻字、多音字和不好的谐音；
4. 寓意解释要具体，讲清字义来源、意象和适合什么样的人，不要空泛堆砌形容词；
5. 不要输出开场白、总结、免责声明或额外解释，只输出这 3 组方案；
6. 默认使用简体中文；用户明确要英文名时，名字给英文，解释用中文。`;

const MAX_REQUIREMENT_LENGTH = 300;

// 生成 3 组名字大约 20~40 秒，放宽函数超时（Hobby 上限 60s，Pro 可再调大）
export const config = { maxDuration: 60 };

/** Supabase 客户端（懒加载，避免没配密钥时启动就报错） */
let supabaseClient = null;
function getSupabase() {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  // 服务端优先用 service_role（可绕过 RLS），没有就退回 anon key
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  supabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabaseClient;
}

/** 把一次起名记录写入 name_history 表 */
async function saveHistory({ requirement, result, modelName }) {
  const supabase = getSupabase();
  if (!supabase) {
    return { saved: false, reason: '未配置 SUPABASE_URL / SUPABASE_ANON_KEY' };
  }

  const { data, error } = await supabase
    .from('name_history')
    .insert({
      user_requirement: requirement,
      name_result: result,
      model_name: modelName,
    })
    .select('id')
    .single();

  if (error) {
    return { saved: false, reason: error.message };
  }
  return { saved: true, id: data?.id ?? null };
}

/** 解析上游 SSE 文本块，抽出增量内容 */
function extractDelta(payload) {
  try {
    const json = JSON.parse(payload);
    const choice = json?.choices?.[0];
    if (!choice) return '';
    // 部分模型会先吐 reasoning_content，这里只取正式回答
    return choice.delta?.content || '';
  } catch {
    return '';
  }
}

export default async function handler(req, res) {
  // ---------- GET：读取历史记录，给前端列表用 ----------
  if (req.method === 'GET') {
    const supabase = getSupabase();
    if (!supabase) {
      return res.status(200).json({
        ok: false,
        data: [],
        message: '未配置 Supabase，历史记录不可用',
      });
    }

    const { data, error } = await supabase
      .from('name_history')
      .select('id, user_requirement, name_result, model_name, created_at')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      return res.status(500).json({ ok: false, data: [], message: error.message });
    }
    return res.status(200).json({ ok: true, data: data ?? [] });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: '只支持 GET / POST' });
  }

  // ---------- POST：流式生成起名方案 ----------
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const requirement = String(body.requirement || '').trim();
  const requestedModel = String(body.model || DEFAULT_MODEL).trim();

  if (!requirement) {
    return res.status(400).json({ error: '请先填写起名需求，例如：男孩、国风、姓氏沈' });
  }
  if (requirement.length > MAX_REQUIREMENT_LENGTH) {
    return res.status(400).json({ error: `起名需求不能超过 ${MAX_REQUIREMENT_LENGTH} 个字` });
  }

  const modelKey = MODEL_CONFIG_MAP[requestedModel] ? requestedModel : DEFAULT_MODEL;
  const config = MODEL_CONFIG_MAP[modelKey];

  if (!config || !config.apiKey || !config.model) {
    return res.status(500).json({
      error: `模型「${modelKey}」尚未配置完整，请检查 .env 里的 ${modelKey.toUpperCase()}_API_KEY / ${modelKey.toUpperCase()}_MODEL`,
    });
  }

  const startedAt = Date.now();

  // SSE 响应头：逐字返回，禁止缓存与中间层缓冲
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (payload) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: 'start', model: modelKey, label: config.label, modelId: config.model });

  // 客户端断开（用户关页面）时中止上游请求，别白烧 token
  let closed = false;
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      closed = true;
      abortController.abort();
    }
  });

  let fullText = '';

  try {
    const upstream = await fetch(`${config.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        temperature: 0.8,
        max_tokens: 1600,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `起名需求：${requirement}` },
        ],
        ...(config.extraBody || {}),
      }),
      signal: abortController.signal,
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      throw new Error(`上游模型返回 ${upstream.status}：${detail.slice(0, 300) || '无详细错误信息'}`);
    }
    if (!upstream.body) throw new Error('上游没有返回流式内容');

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    const consume = (chunk) => {
      const dataLine = chunk
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('data:'));

      if (!dataLine) return;
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === '[DONE]') return;

      const delta = extractDelta(payload);
      if (!delta) return;

      fullText += delta;
      send({ type: 'delta', content: delta });
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');

      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';

      for (const chunk of chunks) consume(chunk);
    }

    // 兜底：有些服务最后一段不带空行结尾，别把最后一个分片丢掉
    if (buffer.trim()) consume(buffer);

    if (!fullText.trim()) throw new Error('模型没有返回内容，请稍后重试或换个需求');

    // 生成结束后统一入库（放在服务端做，前端传什么都改不了记录）
    const saved = await saveHistory({
      requirement,
      result: fullText,
      modelName: `${modelKey} · ${config.model}`,
    });

    send({
      type: 'done',
      model: modelKey,
      saved: saved.saved,
      savedId: saved.id ?? null,
      saveMessage: saved.saved ? null : saved.reason || null,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (closed || abortController.signal.aborted) {
      // 客户端已断开，不需要再写响应
    } else {
      send({ type: 'error', message: readableError(error) });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function readableError(error) {
  const message = error?.message || String(error);
  if (message.includes('fetch failed') || message.includes('ENOTFOUND')) {
    return '无法连接模型接口，请检查 baseURL、网络和代理设置';
  }
  if (message.includes('401') || message.includes('403')) {
    return '模型鉴权失败，请检查 API Key 是否正确、是否有该模型权限';
  }
  if (message.includes('429')) {
    return '模型调用频率超限或额度用尽，请稍后再试';
  }
  return message;
}
