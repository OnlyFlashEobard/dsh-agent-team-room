/**
 * Agent Team Room — Host half.
 *
 * A real multi-agent collaboration loop for the DSH Web GUI:
 *   - persists a team roster (name/role/persona/provider/model/temperature);
 *   - runs a mission round by round, calling the configured model for every
 *     enabled agent, so the transcript is made of genuine model output;
 *   - serves the roster, the live transcript and the controls over same-origin
 *     `/api/agent-room/*` routes polled by the browser half.
 *
 * Only node builtins are used. The browser half lives in `client.js`.
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Stable patch row id, referenced by the Client half's panel key. */
export const name = 'agent-team-room'

/**
 * The page needs the Web carrier. `llm` and `agentDefaultModel` are optional so
 * the inventory entry still loads (and explains itself) on a profile without a
 * model adapter.
 */
export const inject = ['webServer']

const API_PREFIX = '/api/agent-room'
const PALETTE = ['#3b82f6', '#0ea5e9', '#14b8a6', '#f59e0b', '#a855f7', '#ef4444', '#22c55e', '#64748b']
const MAX_AGENTS = 6
const MAX_MESSAGES = 400
const MAX_HISTORY = 12
const MAX_TEXT = 8000
const DEFAULT_TIMEOUT_SEC = 180
const MAX_WORKSPACE_LIST = 160
const MAX_WORKSPACE_TEXT = 18000
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.dsh',
  'dist',
  'build',
  'out',
  '.next',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
])

const PERSONAS = {
  planner:
    '你是团队的规划者。你擅长把开放任务拆解成可执行步骤：先给出目标与成功标准，再给出 2-4 条步骤，标注依赖、优先级和缺少的信息。你说话直接、结构化，不写空话。',
  engineer:
    '你是团队的工程师。你负责把想法变成可落地的方案：数据结构、接口、边界条件、失败模式、验证方式。你偏好简单可靠的实现，会明确指出成本与取舍。',
  reviewer:
    '你是团队的评审者。你负责挑问题：找出方案里的薄弱点、反例、遗漏的前提和被忽略的用户场景，并给出可执行的改进建议。你只批评观点，不攻击人。',
  researcher:
    '你是团队的研究者。你负责补充事实、数据、先例与外部约束，严格区分“已知”“推测”和“需要核实”。你不编造来源，信息不足时直接说明。',
}

function homeFile(...parts) {
  return path.join(homedir(), '.dsh', ...parts)
}

/** Profile directory; keeps every DSH profile's teams and history apart. */
let profileDirCache = null
function profileDir() {
  if (profileDirCache) return profileDirCache
  if (process.env.DSH_PROFILE_DIR) {
    profileDirCache = process.env.DSH_PROFILE_DIR
    return profileDirCache
  }
  if (process.env.DSH_PROFILE) {
    profileDirCache = homeFile('profiles', process.env.DSH_PROFILE)
    return profileDirCache
  }
  // The desktop host receives the profile directory as a positional argument,
  // without exporting DSH_PROFILE_DIR into its process environment.
  for (const arg of process.argv || []) {
    const normalized = String(arg).replace(/\\/g, '/').replace(/\/+$/, '')
    if (!/\/\.dsh\/profiles\/[^/]+$/.test(normalized) && !/\/profiles\/[^/]+$/.test(normalized)) continue
    if (existsSync(arg)) {
      profileDirCache = String(arg)
      return profileDirCache
    }
  }
  profileDirCache = homeFile()
  return profileDirCache
}

function storePath() {
  return path.join(profileDir(), 'agent-team-room.json')
}

function legacyStorePath() {
  return homeFile('agent-team-room.json')
}

function newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function clampText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function isLoopbackRequest(req) {
  const address = req && req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : ''
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = (req && req.headers && req.headers.host) || ''
  const hostname = host.split(':')[0].toLowerCase()
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    chunks.push(buffer)
    total += buffer.length
    if (total > 512 * 1024) return null
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function seedTeam(defaultSelection) {
  const provider = defaultSelection && defaultSelection.provider ? defaultSelection.provider : ''
  const model = defaultSelection && defaultSelection.model ? defaultSelection.model : ''
  return {
    version: 2,
    team: {
      name: '智能体小队',
      finalizerId: 'agent-planner',
      autoPlan: false,
      orchestration: 'round-robin',
      leadProvider: '',
      leadModel: '',
      workspace: '',
      callTimeoutSec: DEFAULT_TIMEOUT_SEC,
      mode: 'chat',
    },
    agents: [
      {
        id: 'agent-planner',
        name: '规划者',
        role: '拆解目标 · 制定步骤',
        emoji: '🧭',
        color: PALETTE[0],
        provider,
        model,
        temperature: 0.7,
        maxTokens: 0,
        reasoningEffort: '',
        enabled: true,
        persona: PERSONAS.planner,
      },
      {
        id: 'agent-engineer',
        name: '工程师',
        role: '方案设计 · 落地实现',
        emoji: '🛠️',
        color: PALETTE[1],
        provider,
        model,
        temperature: 0.6,
        maxTokens: 0,
        reasoningEffort: '',
        enabled: true,
        persona: PERSONAS.engineer,
      },
      {
        id: 'agent-reviewer',
        name: '评审者',
        role: '挑问题 · 找风险',
        emoji: '🔍',
        color: PALETTE[3],
        provider,
        model,
        temperature: 0.8,
        maxTokens: 0,
        reasoningEffort: '',
        enabled: true,
        persona: PERSONAS.reviewer,
      },
    ],
    lastRun: null,
  }
}

function sanitizeConfig(input, previous) {
  const src = input && typeof input === 'object' ? input : {}
  const teamIn = src.team && typeof src.team === 'object' ? src.team : {}
  const prevAgents = previous && Array.isArray(previous.agents) ? previous.agents : []
  const rawAgents = Array.isArray(src.agents) ? src.agents : prevAgents
  const agents = []

  for (const raw of rawAgents.slice(0, MAX_AGENTS)) {
    if (!raw || typeof raw !== 'object') continue
    const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim().slice(0, 64) : newId('agent')
    if (agents.some((a) => a.id === id)) continue
    agents.push({
      id,
      name: clampText(raw.name, 40).trim() || '成员 ' + (agents.length + 1),
      role: clampText(raw.role, 80).trim() || '团队成员',
      emoji: clampText(raw.emoji, 8).trim() || '🤖',
      color: /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : PALETTE[agents.length % PALETTE.length],
      provider: clampText(raw.provider, 120).trim(),
      model: clampText(raw.model, 160).trim(),
      temperature: clampNumber(raw.temperature, 0, 1, 0.7),
      maxTokens: Math.round(clampNumber(raw.maxTokens, 0, 64000, 0)),
      reasoningEffort: clampText(raw.reasoningEffort, 40).trim(),
      enabled: raw.enabled !== false,
      persona: clampText(raw.persona, 4000).trim() || PERSONAS.planner,
    })
  }

  if (agents.length === 0) {
    const seeded = seedTeam({ provider: '', model: '' })
    for (const agent of seeded.agents) agents.push(agent)
  }

  const requestedFinalizer = typeof teamIn.finalizerId === 'string' ? teamIn.finalizerId : null
  const finalizerId = agents.some((a) => a.id === requestedFinalizer) ? requestedFinalizer : null
  const orchestration = ['round-robin', 'lead-picks', 'parallel'].includes(teamIn.orchestration)
    ? teamIn.orchestration
    : 'round-robin'
  const workspace = clampText(teamIn.workspace, 2048).trim()

  return {
    team: {
      name: clampText(teamIn.name, 60).trim() || '智能体小队',
      finalizerId,
      autoPlan: teamIn.autoPlan === true,
      orchestration,
      leadProvider: clampText(teamIn.leadProvider, 120).trim(),
      leadModel: clampText(teamIn.leadModel, 160).trim(),
      workspace,
      callTimeoutSec: Math.round(clampNumber(teamIn.callTimeoutSec, 30, 900, DEFAULT_TIMEOUT_SEC)),
      mode: teamIn.mode === 'agent' ? 'agent' : 'chat',
    },
    agents,
  }
}

function serializeRun(run) {
  if (!run) return null
  return {
    id: run.id,
    mission: run.mission,
    acceptance: run.acceptance || '',
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    resumedAt: run.resumedAt || 0,
    currentRound: run.currentRound,
    currentAgentId: run.currentAgentId,
    phase: run.phase || '',
    delivered: run.delivered === true,
    nextFocus: run.nextFocus || '',
    nextSpeakers: Array.isArray(run.nextSpeakers) ? run.nextSpeakers : [],
    brief: Array.isArray(run.brief) ? run.brief.slice(-80) : [],
    tokens: run.tokens || { input: 0, output: 0, judge: 0, plan: 0 },
    executionMode: run.executionMode || 'chat',
    workspace: run.workspace || '',
    teamSnapshot: run.teamSnapshot || null,
    error: run.error || '',
    messages: (run.messages || []).slice(-MAX_MESSAGES).map((m) => ({
      id: m.id,
      kind: m.kind,
      agentId: m.agentId || null,
      agentName: m.agentName || '',
      role: m.role || '',
      emoji: m.emoji || '',
      color: m.color || '',
      text: typeof m.text === 'string' ? m.text.slice(0, MAX_TEXT) : '',
      reasoning: typeof m.reasoning === 'string' ? m.reasoning.slice(0, MAX_TEXT) : '',
      error: typeof m.error === 'string' ? m.error.slice(0, 2000) : '',
      at: m.at || 0,
      round: m.round || 0,
      delivered: m.delivered === true,
      execution: m.execution || '',
      usage: m.usage || null,
      streaming: false,
    })),
  }
}

function normalizeRunRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  const run = serializeRun(raw)
  if (!run || !run.id) return null
  if (!run.mission) return null
  if (run.status === 'running') {
    run.status = 'stopped'
    run.error = run.error || '协作在 DSH 关闭或插件重载时中断'
  }
  if (!['paused', 'stopped', 'done', 'error'].includes(run.status)) run.status = 'stopped'
  run.brief = Array.isArray(run.brief) ? run.brief.filter((line) => typeof line === 'string') : []
  run.tokens = {
    input: Number(run.tokens && run.tokens.input) || 0,
    output: Number(run.tokens && run.tokens.output) || 0,
    judge: Number(run.tokens && run.tokens.judge) || 0,
    plan: Number(run.tokens && run.tokens.plan) || 0,
  }
  if (!run.tokens.input && !run.tokens.output) {
    for (const message of run.messages || []) {
      if (!message.usage) continue
      run.tokens.input += Number(message.usage.inputTokens) || 0
      run.tokens.output += Number(message.usage.outputTokens) || 0
    }
  }
  return run
}

export function apply(ctx) {
  let data = null
  let active = null // { run, controller }
  let selectedRunId = null
  let metaCache = null
  let metaCacheAt = 0
  let disposed = false

  function llm() {
    return ctx.get('llm')
  }

  function findAgent(id) {
    return data && data.agents.find((a) => a.id === id)
  }

  function enabledAgents() {
    return data.agents.filter((a) => a.enabled)
  }

  async function persist() {
    const payload = JSON.stringify(
      {
        version: 2,
        team: data.team,
        agents: data.agents,
        runs: data.runs,
        lastRunId: data.lastRunId,
        previousRoster: data.previousRoster,
      },
      null,
      2,
    )
    await mkdir(path.dirname(storePath()), { recursive: true })
    const tmp = storePath() + '.' + process.pid + '.tmp'
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, storePath())
  }

  async function loadStoreFile() {
    try {
      return JSON.parse(await readFile(storePath(), 'utf8'))
    } catch {
      return null
    }
  }

  async function migrateLegacyFile() {
    if (storePath() === legacyStorePath()) return null
    if (await loadStoreFile()) return null
    let legacy = null
    try {
      legacy = JSON.parse(await readFile(legacyStorePath(), 'utf8'))
    } catch {
      return null
    }
    try {
      await mkdir(path.dirname(storePath()), { recursive: true })
      await copyFile(legacyStorePath(), storePath())
      // Import once: keep a backup name so another profile does not re-import it.
      await rename(legacyStorePath(), legacyStorePath() + '.migrated').catch(() => {})
    } catch {
      /* keep the legacy file if the copy fails */
    }
    return legacy
  }

  const ready = (async () => {
    let loaded = await loadStoreFile()
    if (!loaded) loaded = await migrateLegacyFile()
    let defaultSelection = { provider: '', model: '' }
    try {
      const selector = ctx.get('agentDefaultModel')
      if (selector && typeof selector.currentSelection === 'function') {
        const current = selector.currentSelection()
        if (current && current.provider) {
          defaultSelection = { provider: current.provider, model: current.model || '' }
        }
      }
    } catch {
      defaultSelection = { provider: '', model: '' }
    }
    const previous = loaded && typeof loaded === 'object' ? loaded : null
    const sanitized = sanitizeConfig(previous || seedTeam(defaultSelection), seedTeam(defaultSelection))
    const runs = []
    if (previous && Array.isArray(previous.runs)) {
      for (const raw of previous.runs.slice(-MAX_HISTORY)) {
        const record = normalizeRunRecord(raw)
        if (record) runs.push(record)
      }
    } else if (previous && previous.lastRun) {
      const record = normalizeRunRecord(previous.lastRun)
      if (record) runs.push(record)
    }
    let lastRunId =
      previous && typeof previous.lastRunId === 'string' && runs.some((r) => r.id === previous.lastRunId)
        ? previous.lastRunId
        : runs.length
          ? runs[runs.length - 1].id
          : null
    if (runs.length > MAX_HISTORY) runs.splice(0, runs.length - MAX_HISTORY)
    data = {
      team: sanitized.team,
      agents: sanitized.agents,
      runs,
      lastRunId,
      previousRoster: previous && previous.previousRoster ? previous.previousRoster : null,
    }
    if (!previous) {
      // Fill seeded members with the profile's current default route.
      for (const agent of data.agents) {
        if (!agent.provider && defaultSelection.provider) agent.provider = defaultSelection.provider
        if (!agent.model && defaultSelection.model) agent.model = defaultSelection.model
      }
      await persist().catch(() => {})
    } else {
      const interrupted = runs.some((r) => r.status === 'running')
      if (interrupted || previous.version !== 2) await persist().catch(() => {})
    }
  })()

  ctx.effect(() => {
    return () => {
      disposed = true
      if (active && active.controller) {
        try {
          active.controller.abort()
        } catch {
          /* already settled */
        }
      }
    }
  })

  async function readMeta() {
    const now = Date.now()
    if (metaCache && now - metaCacheAt < 30000) return metaCache
    const providers = []
    const service = llm()
    let defaultSelection = { provider: '', model: '' }
    try {
      const selector = ctx.get('agentDefaultModel')
      if (selector && typeof selector.currentSelection === 'function') {
        const current = selector.currentSelection()
        if (current && current.provider) {
          defaultSelection = { provider: current.provider, model: current.model || '' }
        }
      }
    } catch {
      /* optional service */
    }
    if (service) {
      let list = []
      try {
        list = service.listProviders() || []
      } catch {
        list = []
      }
      for (const provider of list) {
        const entry = { id: provider.id, name: provider.name || provider.id, models: [] }
        try {
          const models = await service.listModels(provider.id)
          entry.models = (models || []).map((m) => ({ id: m.id, name: m.name || m.id }))
        } catch {
          entry.models = []
        }
        providers.push(entry)
      }
    }
    metaCache = { providers, defaultSelection, llmAvailable: Boolean(service) }
    metaCacheAt = now
    return metaCache
  }

  /** The model that plans a roster: the profile's default, then a configured member. */
  function architectRoute(meta) {
    const providers = meta.providers || []
    const has = (id) => providers.some((p) => p.id === id && p.models.length > 0)
    const selection = meta.defaultSelection || { provider: '', model: '' }
    if (has(selection.provider)) {
      const provider = providers.find((p) => p.id === selection.provider)
      const model = provider.models.some((m) => m.id === selection.model)
        ? selection.model
        : provider.models[0].id
      return { provider: selection.provider, model }
    }
    for (const agent of data.agents) {
      if (has(agent.provider)) {
        const provider = providers.find((p) => p.id === agent.provider)
        const model = provider.models.some((m) => m.id === agent.model)
          ? agent.model
          : provider.models[0].id
        return { provider: agent.provider, model }
      }
    }
    const first = providers.find((p) => p.models.length > 0)
    if (first) return { provider: first.id, model: first.models[0].id }
    return null
  }

  function catalogText(meta) {
    return (meta.providers || [])
      .filter((provider) => provider.models.length > 0)
      .map(
        (provider) =>
          '- ' +
          provider.id +
          ' (' +
          provider.name +
          '): ' +
          provider.models.map((model) => model.id).join(', '),
      )
      .join('\n')
  }

  function extractJsonObject(text) {
    const cleaned = String(text || '')
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim()
    try {
      return JSON.parse(cleaned)
    } catch {
      /* fall through to the balanced scan */
    }
    for (let start = cleaned.indexOf('{'); start >= 0; start = cleaned.indexOf('{', start + 1)) {
      let depth = 0
      let inString = false
      let escaped = false
      for (let i = start; i < cleaned.length; i += 1) {
        const char = cleaned[i]
        if (escaped) {
          escaped = false
          continue
        }
        if (char === '\\') {
          escaped = true
          continue
        }
        if (char === '"') {
          inString = !inString
          continue
        }
        if (inString) continue
        if (char === '{') depth += 1
        else if (char === '}') {
          depth -= 1
          if (depth === 0) {
            try {
              return JSON.parse(cleaned.slice(start, i + 1))
            } catch {
              break
            }
          }
        }
      }
    }
    return null
  }

  function normalizePlannedTeam(parsed, meta, route) {
    const providers = meta.providers || []
    const rawAgents = Array.isArray(parsed && parsed.agents) ? parsed.agents : []
    const agents = []
    for (const raw of rawAgents.slice(0, MAX_AGENTS)) {
      if (!raw || typeof raw !== 'object') continue
      let provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
      let model = typeof raw.model === 'string' ? raw.model.trim() : ''
      let known = providers.find((p) => p.id === provider && p.models.length > 0)
      if (!known) {
        provider = route.provider
        model = route.model
        known = providers.find((p) => p.id === provider)
      } else if (!known.models.some((m) => m.id === model)) {
        model = known.models.some((m) => m.id === route.model) ? route.model : known.models[0].id
      }
      const name = clampText(raw.name, 24).trim() || '成员 ' + (agents.length + 1)
      agents.push({
        id: newId('agent'),
        name,
        role: clampText(raw.role, 60).trim() || '团队成员',
        emoji: clampText(raw.emoji, 8).trim() || '🤖',
        color: /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : PALETTE[agents.length % PALETTE.length],
        provider,
        model,
        temperature: clampNumber(raw.temperature, 0.1, 1, 0.7),
        enabled: true,
        persona:
          clampText(raw.persona, 4000).trim() ||
          '你是团队中的「' + name + '」，负责「' + clampText(raw.role, 60).trim() + '」。只代表自己发言，给出具体贡献。',
      })
    }
    if (!agents.length) return null
    const teamIn = parsed && parsed.team && typeof parsed.team === 'object' ? parsed.team : {}
    let finalizerId = null
    if (typeof teamIn.finalizerIndex === 'number') {
      const candidate = agents[Math.round(teamIn.finalizerIndex)]
      if (candidate) finalizerId = candidate.id
    }
    if (!finalizerId) finalizerId = agents[0].id
    return {
      team: {
        ...data.team,
        name: clampText(teamIn.name, 60).trim() || data.team.name || '智能体小队',
        finalizerId,
        autoPlan: data.team.autoPlan,
      },
      agents,
      rationale: clampText(parsed && parsed.rationale, 600).trim(),
    }
  }

  /**
   * Ask the main/architect Agent to size and configure the team for one mission.
   * Returns a complete config draft; callers decide whether to persist it.
   */
  async function planTeam(mission, options) {
    const service = llm()
    if (!service) throw new Error('模型服务不可用（llm）')
    const meta = await readMeta()
    const primary = leadRoute(meta)
    if (!primary) throw new Error('没有可用于组队的主 Agent 模型，请先配置模型服务')
    const catalog = catalogText(meta)
    if (!catalog) throw new Error('没有可用的模型服务，请先配置模型服务')
    const acceptance = clampText(options && options.acceptance, 2000).trim()
    let workspaceContext = ''
    if (options && options.workspace) {
      workspaceContext = await readWorkspaceContext(options.workspace).catch(() => '')
    }
    const prompt = [
      '任务描述：',
      mission,
      ...(acceptance ? ['', '验收标准：', acceptance] : []),
      ...(workspaceContext ? ['', workspaceContext] : []),
      '',
      '可用模型服务（providerId: 模型 id 列表）：',
      catalog,
      '',
      '请根据任务内容与难度设计一支协作小队，并只输出一个 JSON 对象。规则：',
      '1. 成员数量随难度变化：简单任务 1-2 人，一般任务 3 人，复杂或跨领域任务 4-5 人，最多 6 人；不要为了凑数增加成员。',
      '2. 每个成员的职责必须清晰且互不重叠，只保留任务真正需要的角色；只有高风险、跨领域或需要验收的任务才加入评审角色。',
      '3. 团队名称与成员名称使用 2-6 个汉字；角色不超过 14 个字；人设 60-160 字，写清思考方式与输出要求。',
      '4. provider/model 必须来自上面的列表；temperature 取 0.2-0.9。',
      '5. 团队会持续多轮协作，直到主 Agent 判定任务已交付或用户主动停止，因此不需要设置轮次。',
      '6. finalizerIndex 是负责交付总结的成员下标（从 0 开始）。',
      '7. rationale 用一句中文说明为什么这样配置人数与角色。',
      '',
      'JSON 结构：',
      '{"rationale":"...","team":{"name":"...","finalizerIndex":0},"agents":[{"name":"...","role":"...","emoji":"🧭","color":"#3b82f6","provider":"...","model":"...","temperature":0.7,"persona":"..."}]}',
      '不要输出代码块、解释或其他文字。',
    ].join('\n')

    const fallback = fallbackLeadRoute(meta, primary)
    const routes = [primary, fallback].filter(
      (route, index, list) =>
        route && list.findIndex((item) => item.provider === route.provider && item.model === route.model) === index,
    )
    let text = ''
    let usedRoute = primary
    let failure = ''
    let usage = null
    for (const route of routes) {
      text = ''
      failure = ''
      try {
        for await (const chunk of service.stream({
          provider: route.provider,
          model: route.model,
          system:
            '你是 DeepSeek Harness 多智能体团队的主控 Agent（team architect）。你擅长按任务难度设计协作小队，只输出严格 JSON。',
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          temperature: 0.2,
          maxTokens: 2400,
          signal: timeoutSignal(options && options.signal),
        })) {
          if (!chunk) continue
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
            failure = (chunk.reason.failure && chunk.reason.failure.message) || '组队模型调用失败'
          }
        }
      } catch (error) {
        failure = String((error && error.message) || error)
      }
      usedRoute = route
      if (!failure && text) break
    }
    if (failure) throw new Error(failure)
    const parsed = extractJsonObject(text)
    if (!parsed) throw new Error('主 Agent 未能产出可解析的组队方案')
    const normalized = normalizePlannedTeam(parsed, meta, usedRoute)
    if (!normalized) throw new Error('主 Agent 的组队方案没有有效成员')
    return {
      config: { team: normalized.team, agents: normalized.agents },
      rationale: normalized.rationale,
      route: usedRoute,
      usage,
    }
  }

  function findRun(id) {
    return data.runs.find((run) => run.id === id) || null
  }

  function lastRun() {
    return data.lastRunId ? findRun(data.lastRunId) : null
  }

  function currentRun() {
    if (active) return active.run
    const selected = selectedRunId ? findRun(selectedRunId) : null
    return selected || lastRun()
  }

  function historySummaries() {
    return data.runs
      .slice()
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .map((run) => ({
        id: run.id,
        mission: run.mission,
        acceptance: run.acceptance || '',
        status: run.status,
        delivered: run.delivered === true,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        currentRound: run.currentRound,
        messageCount: (run.messages || []).length,
        tokens: run.tokens || null,
        executionMode: run.executionMode || 'chat',
      }))
  }

  function archiveRun(run) {
    const record = serializeRun(run)
    if (!record) return
    const index = data.runs.findIndex((item) => item.id === record.id)
    if (index >= 0) data.runs[index] = record
    else data.runs.push(record)
    while (data.runs.length > MAX_HISTORY) data.runs.shift()
    data.lastRunId = record.id
  }

  function statePayload() {
    const run = currentRun()
    return {
      ok: true,
      version: 2,
      status: active ? 'running' : 'idle',
      config: { team: data.team, agents: data.agents },
      run,
      selectedRunId: selectedRunId || null,
      history: historySummaries(),
      previousRoster: data.previousRoster
        ? {
            at: data.previousRoster.at || 0,
            reason: data.previousRoster.reason || '',
            teamName: data.previousRoster.team ? data.previousRoster.team.name : '',
            agentCount: Array.isArray(data.previousRoster.agents) ? data.previousRoster.agents.length : 0,
          }
        : null,
      storageProfile: profileDir(),
    }
  }

  function callTimeoutMs() {
    return Math.max(30, Number(data.team.callTimeoutSec) || DEFAULT_TIMEOUT_SEC) * 1000
  }

  function timeoutSignal(signal) {
    const timeout = AbortSignal.timeout(callTimeoutMs())
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }

  function usableRoute(meta, provider, model) {
    const entry = (meta.providers || []).find((item) => item.id === provider && item.models.length > 0)
    if (!entry) return null
    const resolved = entry.models.some((item) => item.id === model) ? model : entry.models[0].id
    return { provider: entry.id, model: resolved }
  }

  function leadRoute(meta) {
    const configured = usableRoute(meta, data.team.leadProvider, data.team.leadModel)
    return configured || architectRoute(meta)
  }

  function fallbackLeadRoute(meta, exclude) {
    const finalizer = data.team.finalizerId ? findAgent(data.team.finalizerId) : null
    const candidates = [finalizer, ...enabledAgents()]
    for (const agent of candidates) {
      if (!agent || !agent.provider) continue
      if (exclude && agent.provider === exclude.provider && agent.model === exclude.model) continue
      const route = usableRoute(meta, agent.provider, agent.model)
      if (route) return route
    }
    return null
  }

  function addUsage(run, usage, bucket) {
    if (!usage) return
    if (!run.tokens) run.tokens = { input: 0, output: 0, judge: 0, plan: 0 }
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    run.tokens.input += input
    run.tokens.output += output
    if (bucket && Object.prototype.hasOwnProperty.call(run.tokens, bucket)) {
      run.tokens[bucket] += input + output
    }
  }

  function snapshotRoster(reason) {
    data.previousRoster = {
      team: JSON.parse(JSON.stringify(data.team)),
      agents: JSON.parse(JSON.stringify(data.agents)),
      at: Date.now(),
      reason: reason || '',
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return ''
    if (bytes < 1024) return bytes + 'B'
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + 'KB'
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
  }

  async function readWorkspaceContext(workspace) {
    const target = clampText(workspace, 2048).trim()
    if (!target) return ''
    let info = null
    try {
      info = await stat(target)
    } catch {
      return ''
    }
    if (!info.isDirectory()) return ''
    const lines = []
    let count = 0
    async function walk(dir, prefix, depth) {
      if (count >= MAX_WORKSPACE_LIST || depth > 2) return
      let entries = []
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (count >= MAX_WORKSPACE_LIST) return
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
        if (entry.isSymbolicLink()) continue
        if (IGNORE_DIRS.has(entry.name)) continue
        const rel = prefix ? prefix + '/' + entry.name : entry.name
        if (entry.isDirectory()) {
          lines.push('- ' + rel + '/')
          count += 1
          await walk(path.join(dir, entry.name), rel, depth + 1)
        } else if (entry.isFile()) {
          let size = 0
          try {
            size = (await stat(path.join(dir, entry.name))).size
          } catch {
            size = 0
          }
          lines.push('- ' + rel + (size ? ' (' + formatBytes(size) + ')' : ''))
          count += 1
        }
      }
    }
    await walk(target, '', 0)
    const keyNames = [
      'AGENTS.md',
      'README.md',
      'README_ZH.md',
      'package.json',
      'pyproject.toml',
      'Cargo.toml',
      'go.mod',
      'composer.json',
      'requirements.txt',
      'Makefile',
    ]
    const chunks = []
    let budget = MAX_WORKSPACE_TEXT
    for (const name of keyNames) {
      if (budget <= 0) break
      let text = ''
      try {
        text = await readFile(path.join(target, name), 'utf8')
      } catch {
        continue
      }
      const clipped = text.slice(0, Math.min(6000, budget))
      if (!clipped.trim()) continue
      budget -= clipped.length
      chunks.push('### ' + name + '\n' + clipped)
    }
    const header = '工作区：' + target
    const tree = '目录结构（最多 ' + MAX_WORKSPACE_LIST + ' 项）：\n' + lines.join('\n')
    const files = chunks.length ? '\n\n关键文件摘录：\n' + chunks.join('\n\n') : ''
    return (header + '\n' + tree + files).slice(0, MAX_WORKSPACE_TEXT + 1200)
  }

  function runMarkdown(run) {
    if (!run) return ''
    const team = run.teamSnapshot && run.teamSnapshot.team ? run.teamSnapshot.team : data.team
    const agents = run.teamSnapshot && Array.isArray(run.teamSnapshot.agents) ? run.teamSnapshot.agents : data.agents
    const lines = []
    lines.push('# ' + (team.name || '智能体团队') + ' · 协作记录')
    lines.push('')
    lines.push('- 任务：' + (run.mission || ''))
    if (run.acceptance) lines.push('- 验收标准：' + run.acceptance)
    lines.push('- 状态：' + run.status + (run.delivered ? ' · 已交付' : ''))
    lines.push('- 成员：' + agents.map((agent) => agent.name).join('、'))
    if (run.tokens) {
      lines.push(
        '- Token：输入 ' +
          run.tokens.input +
          ' / 输出 ' +
          run.tokens.output +
          (run.tokens.judge ? ' / 判定 ' + run.tokens.judge : ''),
      )
    }
    lines.push('')
    lines.push('## 对话')
    lines.push('')
    let lastRound = 0
    for (const message of run.messages || []) {
      if (message.kind === 'system') {
        lines.push('> ' + (message.text || ''))
        lines.push('')
        continue
      }
      if (message.round && message.round !== lastRound) {
        lastRound = message.round
        lines.push('### 第 ' + message.round + ' 轮')
        lines.push('')
      }
      if (message.kind === 'user') {
        lines.push('**你**：' + (message.text || ''))
        lines.push('')
        continue
      }
      if (message.kind === 'verdict') {
        lines.push('**主 Agent · 交付判定**：' + (message.text || ''))
        lines.push('')
        continue
      }
      if (message.kind === 'plan') {
        lines.push('**主 Agent · 自动组队**：')
        lines.push('')
        lines.push(message.text || '')
        lines.push('')
        continue
      }
      lines.push('**' + (message.agentName || '成员') + '（' + (message.role || '') + '）**：')
      lines.push('')
      lines.push(message.text || '')
      if (message.error) lines.push('')
      if (message.error) lines.push('> 错误：' + message.error)
      lines.push('')
    }
    return lines.join('\n')
  }

  function buildSystemPrompt(agent, run) {
    const members = enabledAgents()
      .map((a) => '- ' + a.name + '（' + a.role + '）')
      .join('\n')
    const extra = []
    if (run.acceptance) extra.push('验收标准（必须逐条满足）：' + run.acceptance)
    if (run.workspaceContext) extra.push('工作区上下文：\n' + run.workspaceContext)
    if (run.executionMode === 'agent') {
      extra.push(
        '真实执行模式：你可以使用工具读写工作区文件、执行命令。需要动手时直接调用工具，不要只描述步骤；完成后用文字汇报结果。',
      )
    }
    return [
      agent.persona,
      '',
      '你正在一个多智能体协作团队中工作，必须始终以「' + agent.name + '」的第一人称身份发言。',
      '团队名称：' + data.team.name,
      '你的角色：' + agent.role,
      '团队成员：',
      members,
      '当前任务：' + run.mission,
      ...extra,
      '协作规则：',
      '1. 只代表自己发言，不要代替其他成员说话，也不要转述“某某说：”。',
      '2. 发言不超过 8 句：先给结论，再给理由或步骤。',
      '3. 承接上文观点：补充、修正或质疑，不要重复已经说过的内容。',
      '4. 不确定时明确说出不确定点与需要的信息。',
      '5. 团队会持续多轮协作，直到主 Agent 判定任务已交付或用户主动停止；每轮只推进尚未完成的部分。',
      '6. 用简体中文回答，不要输出角色标签、括号说明或 Markdown 标题。',
    ].join('\n')
  }

  function buildTranscript(run, excludeId, options) {
    const recent = options && options.recent ? options.recent : 0
    const maxChars = options && options.maxChars ? options.maxChars : 0
    const entries = []
    let lastRound = 0
    for (const message of run.messages) {
      if (message.id === excludeId) continue
      if (!message.text || message.streaming) continue
      if (message.kind === 'plan' || message.kind === 'verdict') continue
      const lines = []
      if (message.round && message.round !== lastRound) {
        lastRound = message.round
        lines.push('— 第 ' + message.round + ' 轮 —')
      }
      if (message.kind === 'system') lines.push('系统：' + message.text)
      else if (message.kind === 'user') lines.push('用户：' + message.text)
      else lines.push(message.agentName + '（' + message.role + '）：' + message.text)
      entries.push(lines.join('\n'))
    }
    const chosen = recent > 0 ? entries.slice(-recent) : entries
    let joined = chosen.join('\n')
    if (maxChars > 0 && joined.length > maxChars) {
      joined = '…（更早的内容已省略）\n' + joined.slice(joined.length - maxChars)
    }
    return joined.trim()
  }

  function providerAvailable(agent) {
    const service = llm()
    if (!service || !agent.provider) return false
    try {
      return (service.listProviders() || []).some((p) => p.id === agent.provider)
    } catch {
      return false
    }
  }

  function runnableAgents() {
    return enabledAgents().filter((agent) => agent.model && providerAvailable(agent))
  }

  function selectRoundAgents(run) {
    const runnable = runnableAgents()
    if (
      data.team.orchestration === 'lead-picks' &&
      Array.isArray(run.nextSpeakers) &&
      run.nextSpeakers.length
    ) {
      const chosen = runnable.filter((agent) => run.nextSpeakers.includes(agent.name))
      if (chosen.length) return chosen
    }
    return runnable
  }

  async function runTurn(run, agent, options, signal) {
    const kind = options && options.kind ? options.kind : 'agent'
    const isSummary = kind === 'summary'
    const message = {
      id: newId('msg'),
      kind,
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      emoji: agent.emoji,
      color: agent.color,
      text: '',
      reasoning: '',
      error: '',
      at: Date.now(),
      round: run.currentRound || 1,
      usage: null,
      streaming: true,
    }
    run.messages.push(message)
    run.currentAgentId = agent.id

    const transcript = buildTranscript(run, message.id, {
      recent: isSummary ? 0 : 14,
      maxChars: isSummary ? 14000 : 7000,
    })
    let prompt
    if (isSummary) {
      prompt =
        (transcript ? '团队完整对话：\n\n' + transcript + '\n\n' : '') +
        (options.instruction ||
          '现在由你做收尾总结。请用 5-8 行要点总结：已达成的结论、关键分歧、主要风险、下一步建议。')
    } else {
      const focus = run.nextFocus
        ? '主 Agent 在上一轮交付判定后给出的本轮重点：' + run.nextFocus + '\n\n'
        : ''
      prompt =
        (transcript ? '团队到目前为止的对话：\n\n' + transcript + '\n\n' : '团队对话还没有开始。\n\n') +
        focus +
        '现在轮到你发言。请基于上面的对话，给出你作为「' +
        agent.name +
        '」（' +
        agent.role +
        '）最重要的一条新贡献。'
    }

    let streamed = false
    if (!isSummary && run.executionMode === 'agent') {
      try {
        await runAgentTurn(run, agent, message, prompt, signal)
        run.tokens && addUsage(run, message.usage)
        return message
      } catch (error) {
        run.executionMode = 'chat'
        message.text = ''
        message.reasoning = ''
        message.error = ''
        pushSystem(run, '真实执行模式不可用（' + String((error && error.message) || error) + '），本场改用对话模式继续。')
      }
    }
    try {
      const service = llm()
      if (!service) throw new Error('模型服务不可用（llm）')
      const request = {
        provider: agent.provider,
        model: agent.model,
        system: buildSystemPrompt(agent, run),
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        signal: timeoutSignal(signal),
      }
      if (agent.temperature !== undefined && agent.temperature !== null) {
        request.temperature = agent.temperature
      }
      if (agent.maxTokens) request.maxTokens = agent.maxTokens
      if (agent.reasoningEffort) request.reasoningEffort = agent.reasoningEffort
      const blocks = []
      for await (const chunk of service.stream(request)) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') {
          streamed = true
          message.text += chunk.text
          if (message.text.length > MAX_TEXT) message.text = message.text.slice(0, MAX_TEXT)
        } else if (chunk.type === 'reasoning-delta') {
          message.reasoning += chunk.text
          if (message.reasoning.length > MAX_TEXT) message.reasoning = message.reasoning.slice(0, MAX_TEXT)
        } else if (chunk.type === 'block-end') {
          if (chunk.block && chunk.block.type === 'text') blocks.push(chunk.block.text)
        } else if (chunk.type === 'usage') {
          message.usage = {
            inputTokens: chunk.usage.inputTokens || 0,
            outputTokens: chunk.usage.outputTokens || 0,
          }
          addUsage(run, message.usage)
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason || {}
          if (reason.kind === 'error') {
            message.error = (reason.failure && reason.failure.message) || '模型调用失败'
          } else if (reason.kind === 'aborted') {
            run.stopRequested = true
          }
        }
      }
      if (!streamed && blocks.length) message.text = blocks.join('\n').slice(0, MAX_TEXT)
    } catch (error) {
      message.error = String((error && error.message) || error)
      if (message.error.includes('aborted') && !run.stopRequested) message.error = '调用超时'
    } finally {
      message.streaming = false
      if (!message.text && !message.error) message.error = '本轮没有返回内容'
    }
    return message
  }

  /** One-shot real subagent turn: inherits the live session's tools and cwd. */
  async function runAgentTurn(run, agent, message, prompt, signal) {
    const service = ctx.get('subagents')
    const agents = ctx.get('agents')
    if (!service || !agents) throw new Error('当前 profile 没有 subagent 服务')
    const parent =
      (agents.currentInitiator && agents.currentInitiator()) ||
      agents.roots()[agents.roots().length - 1]
    if (!parent) throw new Error('没有可作为父级的主会话')
    const providers = service.list ? service.list() : []
    const provider =
      providers.find((name) => /local|builtin|dsh/i.test(name)) || (providers.length ? providers[0] : '')
    if (!provider) throw new Error('没有可用的 subagent provider')
    const childId = newId('subagent')
    const activation = await service.startActivation({
      provider,
      label: agent.name,
      childId,
      request: {
        prompt: [
          {
            type: 'text',
            text:
              '（忽略父会话中与本任务无关的历史内容，只按下面的角色设定与任务执行。）\n\n' +
              '你的角色设定：' +
              (agent.persona || '') +
              '\n\n' +
              prompt,
          },
        ],
        parent,
        signal: timeoutSignal(signal),
        cwd: run.workspace || undefined,
        agentOptions: {
          provider: agent.provider,
          model: agent.model,
          ...(agent.maxTokens ? { maxTokens: agent.maxTokens } : {}),
          ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
        },
      },
      signal: timeoutSignal(signal),
      delivery: 'caller',
    })
    let result = null
    try {
      result = await activation.result
    } finally {
      await activation.dispose().catch(() => {})
    }
    const text = (result && result.output ? result.output : [])
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (!text) throw new Error('真实执行没有返回文本结果')
    message.text = text.slice(0, MAX_TEXT)
    message.execution = 'agent'
    message.streaming = false
    return message
  }

  function agentRoute(agent) {
    if (!agent || !agent.provider || !agent.model) return null
    if (!providerAvailable(agent)) return null
    return { provider: agent.provider, model: agent.model }
  }

  function judgeRoute(meta) {
    return leadRoute(meta) || fallbackLeadRoute(meta, null)
  }

  /**
   * The main Agent checks, after every round, whether the team can deliver.
   * No round cap exists: the loop runs until this verdict is delivered, the
   * user stops it, or repeated infrastructure failures make progress impossible.
   */
  async function judgeDelivery(run, signal) {
    const service = llm()
    if (!service) return { failed: true, reason: '模型服务不可用' }
    let meta = { providers: [], defaultSelection: { provider: '', model: '' } }
    try {
      meta = await readMeta()
    } catch {
      /* fall through to a member route */
    }
    const primary = judgeRoute(meta)
    if (!primary) return { failed: true, reason: '没有可用于交付判定的模型' }
    const fallback = fallbackLeadRoute(meta, primary)
    const routes = [primary, fallback].filter(
      (route, index, list) =>
        route && list.findIndex((item) => item.provider === route.provider && item.model === route.model) === index,
    )
    const transcript = buildTranscript(run, null, { recent: 10, maxChars: 6000 })
    const brief =
      run.brief && run.brief.length ? '项目进展摘要：\n' + run.brief.slice(-10).join('\n') + '\n\n' : ''
    const isLeadPicks = data.team.orchestration === 'lead-picks'
    const prompt = [
      '任务目标：',
      run.mission,
      ...(run.acceptance ? ['', '验收标准（必须逐条满足）：', run.acceptance] : []),
      ...(run.workspaceContext ? ['', run.workspaceContext] : []),
      '',
      brief + '团队最近几轮的对话：',
      transcript || '（暂无可读内容）',
      '',
      '请验收当前协作成果，并只输出一个 JSON 对象：',
      isLeadPicks
        ? '{"delivered":true|false,"progress":true|false,"reason":"...","nextFocus":"...","speakers":["成员名"]}'
        : '{"delivered":true|false,"progress":true|false,"reason":"...","nextFocus":"..."}',
      '判断规则：',
      '1. 只有当任务目标已被完整、可执行地交付（结论明确，关键步骤/方案/验收方式齐全；有验收标准时必须逐条满足）时，才把 delivered 设为 true；不要以“还可以更好”为由无限推迟，也不要只有提纲就宣布交付。',
      '2. progress 表示本轮是否产生了新的实质进展（不是重复或仅改写措辞）。',
      '3. 未交付时，nextFocus 用一句具体的话指出下一轮必须补齐的缺口；已交付时 nextFocus 留空。',
      '4. reason 用一句中文说明判定理由。',
      ...(isLeadPicks
        ? ['5. speakers 是下一轮应该发言的成员名称数组，只选真正能推进 nextFocus 的成员；留空数组表示全员发言。']
        : []),
      '只输出 JSON，不要代码块或其他文字。',
    ].join('\n')

    let failure = ''
    let usage = null
    for (const route of routes) {
      let text = ''
      failure = ''
      try {
        for await (const chunk of service.stream({
          provider: route.provider,
          model: route.model,
          system:
            '你是多智能体团队的主控 Agent，负责验收交付：判断任务是否已经可以交付给用户，只输出严格 JSON。',
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          temperature: 0.1,
          maxTokens: 900,
          signal: timeoutSignal(signal),
        })) {
          if (!chunk) continue
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
            failure = (chunk.reason.failure && chunk.reason.failure.message) || '交付判定调用失败'
          }
        }
      } catch (error) {
        failure = String((error && error.message) || error)
      }
      if (failure) continue
      const parsed = extractJsonObject(text)
      if (!parsed || typeof parsed.delivered !== 'boolean') {
        failure = '交付判定输出无法解析'
        continue
      }
      const names = Array.isArray(parsed.speakers)
        ? parsed.speakers
            .filter((name) => typeof name === 'string')
            .map((name) => name.trim())
            .filter((name) => enabledAgents().some((agent) => agent.name === name))
        : []
      return {
        delivered: parsed.delivered === true,
        progress: parsed.progress === true,
        reason: clampText(parsed.reason, 400).trim() || '（无说明）',
        nextFocus: clampText(parsed.nextFocus, 300).trim(),
        speakers: names,
        usage,
      }
    }
    return { failed: true, reason: failure || '交付判定失败' }
  }

  async function deliverySummary(run, verdict, signal) {
    const finalizer = data.team.finalizerId ? findAgent(data.team.finalizerId) : null
    let agent = finalizer && finalizer.enabled && agentRoute(finalizer) ? finalizer : null
    if (!agent) agent = enabledAgents().find((candidate) => agentRoute(candidate)) || null
    if (!agent) return
    await runTurn(
      run,
      agent,
      {
        kind: 'summary',
        instruction:
          '主 Agent 已判定任务可以交付。请输出最终交付说明，用 5-8 行覆盖：交付物或结论、关键实现/步骤、验收方式、已知风险与后续建议。判定理由：' +
          verdict.reason,
      },
      signal,
    )
  }

  function pushSystem(run, text, round) {
    run.messages.push({
      id: newId('msg'),
      kind: 'system',
      text,
      at: Date.now(),
      round: round || run.currentRound || 0,
      streaming: false,
    })
  }

  async function executeRun(run, controller, options) {
    try {
      run.executionMode = data.team.mode === 'agent' ? 'agent' : 'chat'
      run.workspaceContext = await readWorkspaceContext(data.team.workspace).catch(() => '')
      if (options && options.autoPlan && !controller.signal.aborted) {
        run.phase = 'planning'
        const planning = {
          id: newId('msg'),
          kind: 'system',
          text: '主 Agent 正在分析任务内容与难度，规划团队成员…',
          at: Date.now(),
          round: 0,
          streaming: false,
        }
        run.messages.push(planning)
        try {
          snapshotRoster('auto-plan')
          const planned = await planTeam(run.mission, {
            signal: controller.signal,
            acceptance: run.acceptance,
            workspace: run.workspace,
          })
          addUsage(run, planned.usage, 'plan')
          data.team = planned.config.team
          data.agents = planned.config.agents
          run.executionMode = data.team.mode === 'agent' ? 'agent' : 'chat'
          run.teamSnapshot = {
            team: JSON.parse(JSON.stringify(data.team)),
            agents: JSON.parse(JSON.stringify(data.agents)),
          }
          const lines = planned.config.agents.map(
            (agent, index) =>
              (index + 1) + '. ' + agent.emoji + ' ' + agent.name + '（' + agent.role + '）· ' + agent.model,
          )
          const finalizer = data.agents.find((agent) => agent.id === data.team.finalizerId)
          planning.text =
            '主 Agent 按任务难度组建了 ' +
            data.agents.length +
            ' 人小队' +
            (planned.rationale ? '：' + planned.rationale : '') +
            '\n' +
            lines.join('\n') +
            (finalizer ? '\n收尾总结：' + finalizer.name : '')
          planning.kind = 'plan'
          planning.agentName = '主 Agent'
          planning.role = '自动组队'
          planning.emoji = '🧠'
          planning.color = '#6366f1'
          archiveRun(run)
          await persist().catch(() => {})
          metaCache = null
        } catch (planError) {
          planning.text =
            '自动组队未完成（' +
            String((planError && planError.message) || planError) +
            '），沿用现有团队继续协作。'
          planning.kind = 'system'
        }
      }
      if (controller.signal.aborted) {
        run.status = 'stopped'
        return
      }

      const skipped = enabledAgents()
        .filter((agent) => !agentRoute(agent))
        .map((agent) => agent.name)
      if (skipped.length) {
        pushSystem(run, '以下成员缺少可用模型或服务，本场不会发言：' + skipped.join('、'), 0)
      }

      let round = 0
      let judgeFailures = 0
      let emptyRounds = 0
      let noProgressRounds = 0
      while (!disposed && !controller.signal.aborted) {
        if (run.pauseRequested) {
          pushSystem(run, '协作已暂停，等待继续。', run.currentRound || 0)
          run.status = 'paused'
          return
        }
        const agents = selectRoundAgents(run)
        if (agents.length === 0) {
          run.status = 'error'
          run.error = '没有可发言的成员：请为成员配置可用模型，或开启自动组队'
          return
        }
        round += 1
        run.currentRound = round
        run.phase = 'working'
        run.currentAgentId = null
        let producedThisRound = false

        if (data.team.orchestration === 'parallel') {
          const messages = await Promise.all(
            agents.map((agent) => runTurn(run, agent, { parallel: true }, controller.signal)),
          )
          producedThisRound = messages.some((message) => message && message.text)
          run.currentAgentId = null
        } else {
          for (const agent of agents) {
            if (disposed || controller.signal.aborted) {
              run.status = 'stopped'
              return
            }
            const message = await runTurn(run, agent, null, controller.signal)
            if (message && message.text) producedThisRound = true
            if (run.pauseRequested) {
              pushSystem(run, '协作已暂停，等待继续。', round)
              run.status = 'paused'
              return
            }
            if (controller.signal.aborted) {
              run.status = 'stopped'
              return
            }
          }
        }

        if (controller.signal.aborted) {
          run.status = 'stopped'
          return
        }
        if (!producedThisRound) {
          emptyRounds += 1
          if (emptyRounds >= 2) {
            run.status = 'error'
            run.error = '连续多轮没有任何成员产出内容，协作已中断'
            return
          }
        } else {
          emptyRounds = 0
        }

        run.phase = 'judging'
        run.currentAgentId = null
        const verdict = await judgeDelivery(run, controller.signal)
        addUsage(run, verdict.usage, 'judge')
        if (controller.signal.aborted) {
          run.status = 'stopped'
          return
        }
        if (verdict.failed) {
          judgeFailures += 1
          pushSystem(run, '交付判定暂时失败（' + verdict.reason + '），继续下一轮协作。', round)
          if (judgeFailures >= 3) {
            run.status = 'error'
            run.error = '连续三次无法完成交付判定：' + verdict.reason
            return
          }
          continue
        }
        judgeFailures = 0
        run.brief.push(
          '第 ' +
            round +
            ' 轮：' +
            (verdict.delivered ? '已交付 · ' : '') +
            verdict.reason +
            (verdict.nextFocus ? '；下一步：' + verdict.nextFocus : ''),
        )
        run.messages.push({
          id: newId('msg'),
          kind: 'verdict',
          agentId: null,
          agentName: '主 Agent',
          role: '交付判定',
          emoji: '🧠',
          color: '#6366f1',
          text:
            (verdict.delivered ? '已具备交付条件' : '尚未交付') +
            ' · ' +
            verdict.reason +
            (verdict.nextFocus ? '\n下一轮重点：' + verdict.nextFocus : ''),
          at: Date.now(),
          round,
          streaming: false,
          delivered: verdict.delivered,
        })

        if (verdict.delivered) {
          run.delivered = true
          run.phase = 'summary'
          await deliverySummary(run, verdict, controller.signal)
          const produced = run.messages.some(
            (message) => (message.kind === 'agent' || message.kind === 'summary') && message.text,
          )
          if (controller.signal.aborted) run.status = 'stopped'
          else if (run.pauseRequested) run.status = 'paused'
          else if (produced) run.status = 'done'
          else {
            run.status = 'error'
            run.error = '协作没有产生任何内容'
          }
          return
        }

        if (!verdict.progress) noProgressRounds += 1
        else noProgressRounds = 0
        if (noProgressRounds === 4) {
          pushSystem(run, '已连续 4 轮没有实质进展：建议补充信息或调整任务，团队会继续推进。', round)
          noProgressRounds = 0
        }
        run.nextFocus = verdict.nextFocus
        if (data.team.orchestration === 'lead-picks') {
          run.nextSpeakers = verdict.speakers || []
        }
        archiveRun(run)
        await persist().catch(() => {})
      }
      run.status = run.pauseRequested ? 'paused' : 'stopped'
    } catch (error) {
      run.status = controller.signal.aborted ? 'stopped' : 'error'
      run.error = run.status === 'stopped' ? run.error || '' : String((error && error.message) || error)
    } finally {
      run.endedAt = Date.now()
      run.currentAgentId = null
      run.phase = ''
      if (run.status === 'running') run.status = controller.signal.aborted ? 'stopped' : 'paused'
      archiveRun(run)
      active = null
      await persist().catch(() => {})
    }
  }

  async function startRun(mission, options) {
    if (active) return { ok: false, error: '已有协作正在进行中' }
    if (!data) return { ok: false, error: '插件仍在初始化，请稍后再试' }
    const text = clampText(mission, 4000).trim()
    if (!text) return { ok: false, error: '请先填写任务目标' }
    const acceptance = clampText(options && options.acceptance, 2000).trim()
    const wantPlan = Boolean(options && options.autoPlan)
    if (wantPlan) {
      if (!llm()) return { ok: false, error: '模型服务不可用，无法自动组队' }
      const meta = await readMeta()
      if (!leadRoute(meta)) return { ok: false, error: '没有可用于组队的主 Agent 模型' }
    } else {
      const runnable = runnableAgents()
      if (enabledAgents().length === 0) return { ok: false, error: '没有启用的团队成员' }
      if (runnable.length === 0) {
        return { ok: false, error: '没有可用模型：请到「团队设置」为成员选择服务与模型' }
      }
    }
    selectedRunId = null
    const run = {
      id: newId('run'),
      mission: text,
      acceptance,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      resumedAt: 0,
      currentRound: 1,
      currentAgentId: null,
      phase: wantPlan ? 'planning' : 'working',
      delivered: false,
      nextFocus: '',
      nextSpeakers: [],
      brief: [],
      tokens: { input: 0, output: 0, judge: 0, plan: 0 },
      executionMode: data.team.mode === 'agent' ? 'agent' : 'chat',
      workspace: data.team.workspace || '',
      teamSnapshot: {
        team: JSON.parse(JSON.stringify(data.team)),
        agents: JSON.parse(JSON.stringify(data.agents)),
      },
      error: '',
      autoPlan: wantPlan,
      stopRequested: false,
      pauseRequested: false,
      messages: [
        {
          id: newId('msg'),
          kind: 'system',
          text:
            '协作开始 · 任务：' +
            text +
            (acceptance ? ' · 验收标准：' + acceptance : '') +
            ' · 持续到交付、暂停或手动停止',
          at: Date.now(),
          round: 0,
          streaming: false,
        },
      ],
    }
    const controller = new AbortController()
    active = { run, controller }
    void executeRun(run, controller, { autoPlan: wantPlan })
    return { ok: true }
  }

  async function resumeRun(options) {
    if (active) return { ok: false, error: '已有协作正在进行中' }
    const id = options && options.id ? String(options.id) : data.lastRunId
    const record = id ? findRun(id) : null
    if (!record) return { ok: false, error: '没有可继续的协作记录' }
    if (!['paused', 'stopped'].includes(record.status)) {
      return { ok: false, error: '只有已暂停或已停止的协作可以继续' }
    }
    const run = JSON.parse(JSON.stringify(record))
    run.status = 'running'
    run.delivered = false
    run.error = ''
    run.resumedAt = Date.now()
    run.endedAt = null
    run.phase = 'working'
    run.pauseRequested = false
    run.stopRequested = false
    run.nextSpeakers = []
    if (!run.tokens) run.tokens = { input: 0, output: 0, judge: 0, plan: 0 }
    run.messages.push({
      id: newId('msg'),
      kind: 'system',
      text: '继续上一场协作。',
      at: Date.now(),
      round: run.currentRound || 0,
      streaming: false,
    })
    selectedRunId = null
    const controller = new AbortController()
    active = { run, controller }
    void executeRun(run, controller, { autoPlan: false, resume: true })
    return { ok: true, id: run.id }
  }

  function pauseRun() {
    if (!active) return { ok: false, error: '当前没有运行中的协作' }
    active.run.pauseRequested = true
    active.run.phase = 'pausing'
    return { ok: true }
  }

  function stopRun() {
    if (!active) return { ok: false, error: '当前没有运行中的协作' }
    active.run.stopRequested = true
    try {
      active.controller.abort()
    } catch {
      /* noop */
    }
    return { ok: true }
  }

  const handler = async (req, res) => {
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
      return
    }
    const url = new URL(req.url || '/', 'http://localhost')
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const method = (req.method || 'GET').toUpperCase()

    try {
      await ready
      if (method === 'GET' && route === '/state') {
        sendJson(res, 200, statePayload())
        return
      }
      if (method === 'GET' && route === '/meta') {
        const meta = await readMeta()
        sendJson(res, 200, Object.assign({ ok: true }, meta))
        return
      }
      if (method === 'POST' && route === '/config') {
        if (active) {
          sendJson(res, 409, { ok: false, error: '协作进行中，请先停止再修改团队配置' })
          return
        }
        const body = await readJsonBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        if (body.snapshot === true) snapshotRoster('manual-apply')
        const sanitized = sanitizeConfig(body, { team: data.team, agents: data.agents })
        data.team = sanitized.team
        data.agents = sanitized.agents
        await persist()
        metaCache = null
        sendJson(res, 200, {
          ok: true,
          config: { team: data.team, agents: data.agents },
          previousRoster: Boolean(data.previousRoster),
        })
        return
      }
      if (method === 'GET' && route === '/model-info') {
        const provider = clampText(url.searchParams.get('provider'), 120).trim()
        const model = clampText(url.searchParams.get('model'), 160).trim()
        const service = llm()
        if (!service || !provider || !model) {
          sendJson(res, 400, { ok: false, error: '缺少 provider/model，或模型服务不可用' })
          return
        }
        try {
          const info = await service.resolveModelInfo(provider, model)
          sendJson(res, 200, {
            ok: true,
            provider,
            model,
            reasoning: info.reasoning || null,
            defaultMaxTokens: info.defaultMaxTokens || 0,
            context: info.context || null,
          })
        } catch (error) {
          sendJson(res, 502, { ok: false, error: String((error && error.message) || error) })
        }
        return
      }
      if (method === 'POST' && route === '/plan') {
        const body = await readJsonBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const mission = clampText(body.mission, 4000).trim()
        if (!mission) {
          sendJson(res, 400, { ok: false, error: '请先填写任务目标' })
          return
        }
        try {
          const plan = await planTeam(mission, {
            signal: AbortSignal.timeout(150000),
            acceptance: body.acceptance,
            workspace: data.team.workspace,
          })
          sendJson(res, 200, {
            ok: true,
            config: plan.config,
            rationale: plan.rationale,
            route: plan.route,
          })
        } catch (error) {
          sendJson(res, 502, { ok: false, error: String((error && error.message) || error) })
        }
        return
      }
      if (method === 'POST' && route === '/start') {
        const body = await readJsonBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const wantPlan = typeof body.autoPlan === 'boolean' ? body.autoPlan : data.team.autoPlan === true
        const result = await startRun(body.mission, {
          autoPlan: wantPlan,
          acceptance: body.acceptance,
        })
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }
      if (method === 'POST' && route === '/pause') {
        const result = pauseRun()
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }
      if (method === 'POST' && route === '/resume') {
        const body = await readJsonBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const result = await resumeRun({ id: body.id })
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }
      if (method === 'POST' && route === '/history/open') {
        if (active) {
          sendJson(res, 409, { ok: false, error: '协作进行中，先停止后才能查看历史' })
          return
        }
        const body = await readJsonBody(req)
        const id = body && body.id ? String(body.id) : ''
        const run = id ? findRun(id) : null
        if (!run) {
          sendJson(res, 404, { ok: false, error: '没有这条协作记录' })
          return
        }
        selectedRunId = id
        sendJson(res, 200, { ok: true, run })
        return
      }
      if (method === 'POST' && route === '/history/close') {
        selectedRunId = null
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && route === '/history/delete') {
        const body = await readJsonBody(req)
        const id = body && body.id ? String(body.id) : ''
        if (!id) {
          sendJson(res, 400, { ok: false, error: '缺少记录 id' })
          return
        }
        if (active && active.run.id === id) {
          sendJson(res, 409, { ok: false, error: '协作进行中，不能删除当前记录' })
          return
        }
        const index = data.runs.findIndex((run) => run.id === id)
        if (index < 0) {
          sendJson(res, 404, { ok: false, error: '没有这条协作记录' })
          return
        }
        data.runs.splice(index, 1)
        if (data.lastRunId === id) data.lastRunId = data.runs.length ? data.runs[data.runs.length - 1].id : null
        if (selectedRunId === id) selectedRunId = null
        await persist()
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && route === '/roster/undo') {
        if (active) {
          sendJson(res, 409, { ok: false, error: '协作进行中，不能恢复阵容' })
          return
        }
        if (!data.previousRoster) {
          sendJson(res, 404, { ok: false, error: '没有可恢复的阵容' })
          return
        }
        const restored = sanitizeConfig(
          { team: data.previousRoster.team, agents: data.previousRoster.agents },
          { team: data.team, agents: data.agents },
        )
        data.team = restored.team
        data.agents = restored.agents
        data.previousRoster = null
        await persist()
        sendJson(res, 200, { ok: true, config: { team: data.team, agents: data.agents } })
        return
      }
      if (method === 'GET' && route === '/export') {
        const id = url.searchParams.get('id')
        const run = id ? findRun(id) : currentRun()
        if (!run) {
          sendJson(res, 404, { ok: false, error: '还没有可导出的记录' })
          return
        }
        sendJson(res, 200, { ok: true, markdown: runMarkdown(run), id: run.id })
        return
      }
      if (method === 'POST' && route === '/save') {
        const body = await readJsonBody(req)
        const id = body && body.id ? String(body.id) : ''
        const run = id ? findRun(id) : currentRun()
        if (!run) {
          sendJson(res, 404, { ok: false, error: '还没有可保存的记录' })
          return
        }
        const workspace = (run.workspace || data.team.workspace || '').trim()
        if (!workspace) {
          sendJson(res, 400, { ok: false, error: '请先在团队设置里选择工作区目录' })
          return
        }
        try {
          await mkdir(workspace, { recursive: true })
          const file = path.join(workspace, 'agent-team-room-' + run.id + '.md')
          await writeFile(file, runMarkdown(run), 'utf8')
          sendJson(res, 200, { ok: true, path: file })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
        return
      }
      if (method === 'POST' && route === '/stop') {
        const result = stopRun()
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }
      if (method === 'POST' && route === '/message') {
        if (!active) {
          sendJson(res, 409, { ok: false, error: '协作未运行，无法插话' })
          return
        }
        const body = await readJsonBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const text = clampText(body.text, 2000).trim()
        if (!text) {
          sendJson(res, 400, { ok: false, error: '插话内容为空' })
          return
        }
        active.run.messages.push({
          id: newId('msg'),
          kind: 'user',
          agentName: '用户',
          text,
          at: Date.now(),
          round: active.run.currentRound,
          streaming: false,
        })
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && route === '/reset') {
        if (active) {
          sendJson(res, 409, { ok: false, error: '协作进行中，请先停止再清空记录' })
          return
        }
        const body = await readJsonBody(req)
        const id = (body && body.id) || selectedRunId || data.lastRunId
        if (id) {
          const index = data.runs.findIndex((run) => run.id === id)
          if (index >= 0) data.runs.splice(index, 1)
          if (selectedRunId === id) selectedRunId = null
          if (data.lastRunId === id) {
            data.lastRunId = data.runs.length ? data.runs[data.runs.length - 1].id : null
          }
        }
        await persist()
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { ok: false, error: '未知接口：' + method + ' ' + route })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler,
    }),
  )

  // ── Agent-facing tool: let the session's main Agent size and configure the
  // team for a mission, or start the collaboration itself. The page and the
  // tool share planTeam/startRun, so both callers apply the same rules.
  ctx.effect(() => {
    const tools = ctx.get('tools')
    if (!tools) return
    return tools.register({
      name: 'agent_team_room',
      description:
        '智能体团队（Agent Team Room）。主 Agent 可据此按任务内容与难度自动决定子 Agent 的数量与配置（角色、人设、模型、温度、轮次），也可查看协作状态或直接发起一次真实的多 Agent 协作。用户的页面在左侧栏「智能体团队」。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['plan', 'start', 'status'],
            description:
              'plan=分析任务并给出组队方案（默认不保存，apply=true 时保存）；start=自动组队、保存并立即开始协作；status=读取当前或最近一次协作状态。',
          },
          mission: {
            type: 'string',
            description: '任务描述；plan 与 start 必填。',
          },
          acceptance: {
            type: 'string',
            description: '可选验收标准；判定与总结会逐条核对。',
          },
          apply: {
            type: 'boolean',
            description: '仅 plan 使用：true 时把方案直接保存为团队配置。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            rationale: { type: 'string' },
            team: { type: 'array' },
          },
          required: ['ok', 'message'],
          additionalProperties: true,
        },
        render(args, value) {
          const text = value && typeof value.message === 'string' ? value.message : ''
          return [{ type: 'text', text: text || 'agent_team_room: done' }]
        },
      },
      async execute(args, exec) {
        await ready
        const action = args && typeof args.action === 'string' ? args.action : ''
        if (action === 'plan' || action === 'start') {
          const mission = clampText(args.mission, 4000).trim()
          if (!mission) throw new Error('mission 不能为空')
          const acceptance = clampText(args.acceptance, 2000).trim()
          if (action === 'start' && active) throw new Error('已有协作正在进行中')
          const plan = await planTeam(mission, {
            signal: exec.signal,
            acceptance,
            workspace: data.team.workspace,
          })
          const roster = plan.config.agents.map((agent) => ({
            name: agent.name,
            role: agent.role,
            model: agent.provider + '/' + agent.model,
          }))
          const lines = plan.config.agents.map(
            (agent, index) =>
              (index + 1) + '. ' + agent.emoji + ' ' + agent.name + '（' + agent.role + '）· ' + agent.provider + '/' + agent.model,
          )
          const rationale = plan.rationale ? '理由：' + plan.rationale + '\n' : ''
          const rosterText = '团队「' + plan.config.team.name + '」· 持续到交付\n' + lines.join('\n')
          if (action === 'plan' && args.apply !== true) {
            return {
              ok: true,
              message: '组队方案（未保存）：\n' + rationale + rosterText,
              rationale: plan.rationale,
              team: roster,
              config: plan.config,
            }
          }
          if (active) throw new Error('协作进行中，不能修改团队配置')
          snapshotRoster(action === 'start' ? 'tool-start' : 'tool-plan')
          data.team = plan.config.team
          data.agents = plan.config.agents
          metaCache = null
          await persist()
          if (action === 'plan') {
            return {
              ok: true,
              message: '已按任务难度保存团队配置：\n' + rationale + rosterText,
              rationale: plan.rationale,
              team: roster,
              config: plan.config,
            }
          }
          const result = await startRun(mission, { autoPlan: false, acceptance })
          if (!result.ok) throw new Error(result.error)
          return {
            ok: true,
            message: '已自动组队并开始协作：\n' + rationale + rosterText,
            rationale: plan.rationale,
            team: roster,
          }
        }
        if (action === 'status') {
          const run = currentRun()
          if (!run) return { ok: true, message: '还没有协作记录。' }
          const speaking = run.currentAgentId ? findAgent(run.currentAgentId) : null
          return {
            ok: true,
            message:
              '状态：' + run.status +
              ' · 第 ' + (run.currentRound || 0) + ' 轮（无轮次上限，运行到交付或停止）' +
              (run.delivered ? ' · 已交付' : '') +
              (run.phase ? ' · 阶段：' + run.phase : '') +
              (speaking ? ' · 当前发言：' + speaking.name : '') +
              ' · 消息 ' + (run.messages || []).length + ' 条' +
              ' · 历史 ' + data.runs.length + ' 场' +
              (run.mission ? '\n任务：' + run.mission : ''),
            run: {
              status: run.status,
              currentRound: run.currentRound,
              delivered: run.delivered === true,
              phase: run.phase || '',
              mission: run.mission,
              messages: (run.messages || []).length,
            },
          }
        }
        throw new Error('未知 action：' + action)
      },
    })
  })
}
