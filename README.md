# Prompt Optimizer

基于进化算法的 LLM Prompt 自动优化系统。通过变异、评估、淘汰的迭代循环，持续改进 prompt 质量。

## 核心思路

```
原始 Prompt → 多策略变异 → LLM-as-Judge 评估 → 人工标注反馈 → 定向进化 → 最优 Prompt
```

1. **变异**：对 prompt 施加不同策略（精简、加示例、重构、定向优化）生成变体
2. **评估**：用 LLM 作为裁判，从准确性、格式、一致性、边界处理 4 个维度打分
3. **淘汰**：维护固定大小的种群，低分变体被淘汰，高分变体存活
4. **反馈**：人工标注问题标签（指令模糊、废话太多、格式不稳定等），指导下一轮变异方向

## 快速开始

### 环境要求

- Node.js 18+
- 兼容 OpenAI API 的 LLM 服务

### 安装

```bash
npm install
```

### 配置

创建 `.env` 文件：

```bash
LLM_BASE_URL=https://your-api-endpoint/v1
LLM_API_KEY=your-api-key
LLM_MODEL=gemini-2.5-flash-preview-05-20  # 可选，默认值
```

### 初始化数据库

```bash
npm run db:generate
npm run db:migrate
```

### 运行

**CLI 交互模式：**

```bash
npm run cli
```

CLI 支持完整的工作流：创建项目 → 添加测试用例 → 初始化种群 → 迭代进化。

**HTTP API 模式：**

```bash
npm run start
# 默认监听 http://localhost:3000
```

### 运行测试

```bash
npx tsx src/test.ts
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects` | 列出所有项目 |
| GET | `/api/projects/:id` | 获取项目详情 |
| POST | `/api/projects/:id/test-cases` | 添加测试用例 |
| GET | `/api/projects/:id/test-cases` | 获取测试用例列表 |
| POST | `/api/projects/:id/initialize` | 初始化种群（Round 0） |
| POST | `/api/projects/:id/evolve` | 进化一轮（需提供标注） |
| GET | `/api/projects/:id/leaderboard` | 查看排行榜 |
| GET | `/api/projects/:id/history` | 查看进化历史 |
| GET | `/api/projects/:id/best` | 导出最优 prompt |
| GET | `/api/prompts/:id` | 查看 prompt 详情及评估结果 |
| GET | `/api/tags` | 获取所有反馈标签 |

### 示例：完整流程

```bash
# 1. 创建项目
curl -X POST http://localhost:3000/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "翻译助手优化", "populationSize": 6}'

# 2. 添加测试用例
curl -X POST http://localhost:3000/api/projects/{id}/test-cases \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Translate to Chinese: The quick brown fox",
    "expectedOutput": "敏捷的棕色狐狸",
    "scoringCriteria": "翻译准确、自然流畅"
  }'

# 3. 初始化种群
curl -X POST http://localhost:3000/api/projects/{id}/initialize \
  -H "Content-Type: application/json" \
  -d '{"prompt": "你是一个翻译助手，请将英文翻译为中文。"}'

# 4. 查看排行榜
curl http://localhost:3000/api/projects/{id}/leaderboard

# 5. 标注并进化
curl -X POST http://localhost:3000/api/projects/{id}/evolve \
  -H "Content-Type: application/json" \
  -d '{"tags": ["废话太多", "格式不稳定"], "note": "翻译结果前面不要加解释"}'

# 6. 导出最优 prompt
curl http://localhost:3000/api/projects/{id}/best
```

## 项目结构

```
src/
├── cli.ts                  # CLI 交互入口
├── server.ts               # HTTP API 服务（Hono）
├── test.ts                 # 单元测试
└── lib/
    ├── ai/client.ts        # OpenAI 兼容客户端
    ├── db/
    │   ├── schema.ts       # 数据库 Schema（Drizzle ORM）
    │   ├── index.ts        # 数据库连接
    │   └── migrate.ts      # 数据库迁移
    └── engine/
        ├── mutator.ts      # Prompt 变异策略
        ├── evaluator.ts    # LLM-as-Judge 评估
        ├── feedback.ts     # 人工反馈标签映射
        └── population.ts   # 种群管理（排名、淘汰、精英）
```

## 反馈标签

| 分类 | 标签 |
|------|------|
| 指令问题 | 指令模糊、指令矛盾、过于复杂、边界条件缺失 |
| 输出问题 | 格式不稳定、废话太多、遗漏关键信息、幻觉风险 |
| 风格问题 | 语气不对、角色设定太弱、示例质量差 |
| 覆盖问题 | 未覆盖某类case、对异常输入不鲁棒 |

## 技术栈

- **Runtime**: Node.js + TypeScript (tsx)
- **HTTP**: Hono
- **Database**: SQLite (better-sqlite3 + Drizzle ORM)
- **LLM**: OpenAI 兼容 API
