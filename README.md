# AI 起名平台

Vercel Node 函数 + 流式（SSE）输出 + Supabase 历史记录。用户输入起名需求，模型实时吐出 3 组名字与寓意解释，生成结果自动入库。

## 文件结构

```
.
├── api/
│   └── name.js        # 唯一后端：POST 流式起名 / GET 历史记录
├── db/
│   └── schema.sql     # Supabase 建表 SQL（含索引与 RLS 策略）
├── index.html         # 前端页面（Vercel 自动作为站点首页）
├── .env.example       # 环境变量模板（复制成 .env 填真实密钥）
├── .gitignore         # 已忽略 .env，密钥不会进仓库
└── package.json
```

## 本地运行

```bash
npm install
cp .env.example .env        # 然后填自己的密钥
npm run dev                 # 即 vercel dev，默认 http://localhost:3000
```

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SUPABASE_URL` | 是 | Supabase 项目地址 |
| `SUPABASE_ANON_KEY` | 是 | 匿名 key |
| `SUPABASE_SERVICE_ROLE_KEY` | 否 | 配了就优先用它写入（可绕过 RLS） |
| `DOUBAO_API_KEY` | 是 | 火山方舟 API Key |
| `DOUBAO_MODEL` | 是 | 接入点 ID（`ep-xxxx`）或模型 ID；接入点返回 `NoAvailableModel` 通常是没绑到已开通的模型 |
| `DEFAULT_MODEL` | 否 | 默认 `doubao`，可切 `deepseek` / `qwen` / `kimi` |
| `DOUBAO_BASE_URL` 等 | 否 | 默认已写死官方地址，一般不用配 |

所有密钥只从 `process.env` 读取，代码里没有任何硬编码。

## 接口

**POST `/api/name`**

```json
{ "requirement": "男孩，姓沈，国风简约" }
```

返回 `text/event-stream`，事件体为 JSON：

```
data: {"type":"start","model":"doubao","label":"豆包 · 火山方舟","modelId":"ep-xxx"}
data: {"type":"delta","content":"### 方案一"}
...
data: {"type":"done","saved":true,"savedId":12,"durationMs":8231}
data: {"type":"error","message":"模型鉴权失败..."}
```

**GET `/api/name`** → 最近 10 条历史（`id / user_requirement / name_result / model_name / created_at`）。

## 数据库

把 `db/schema.sql` 整段贴进 Supabase → SQL Editor → Run，产出 `name_history` 表。表结构：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint identity | 主键 |
| `user_requirement` | text | 用户起名需求 |
| `name_result` | text | 完整起名方案（Markdown 原文） |
| `model_name` | text | 使用的模型标识 |
| `created_at` | timestamptz | 默认 now() |

## 部署到 Vercel

1. 推送到 GitHub（确认 `.env` 未被提交）。
2. Vercel → Import 该仓库，框架选 Other，无需改构建命令。
3. 在 Settings → Environment Variables 里填入与 `.env` 相同的变量（Production / Preview 都勾上）。
4. Deploy，拿到公网域名。

> Node 函数默认超时对长文本可能不够：如果经常生成到一半被截断，在 Vercel 项目设置里调大 Function 时长（Pro 可到 60s+）。

## 常见问题

- **401 / 403**：Key 错、或该 Key 没有这个模型/接入点的权限。
- **404 / 400**：`DOUBAO_MODEL` 填错最常见，火山方舟要填接入点 ID；通义千问必须用 `compatible-mode` 地址。
- **历史为空**：先确认 SQL 跑成功，再检查 RLS 策略是否放开 select；控制台里能查到数据就说明是权限问题。
- **一直转圈没有字**：本地网络访问不到模型域名，或 Vercel 未配置环境变量。
- **等很久才出字、内容还被截断**：豆包 2.x 默认开深度思考，token 大量消耗在 `reasoning_content` 上。本项目在 `api/name.js` 里给豆包配置了 `thinking: { type: 'disabled' }`，起名这类任务不需要思考，关掉后首个字约 2 秒出现、20 秒左右完整返回。若换的模型不支持该参数而报 400，删掉 `extraBody` 即可。

## 想切换到多模型（阶段 2）

`api/name.js` 顶部已有 `MODEL_CONFIG_MAP`，四个模型的地址与鉴权都已按 OpenAI 兼容格式写好。要做前端下拉框，只需：

1. 前端多传一个字段：`{ requirement, model: 'deepseek' }`（后端已支持校验，非法值回落默认模型）。
2. 页面加一个 `<select>`，选项为 `doubao / deepseek / qwen / kimi`。
3. 对应模型的环境变量填上 Key 与模型名即可，主调用代码一行不用改。
