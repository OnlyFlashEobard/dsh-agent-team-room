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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
const MAX_TEXT = 8000

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

function storePath() {
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
    version: 1,
    team: {
      name: '智能体小队',
      finalizerId: 'agent-planner',
      autoPlan: false,
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

  return {
    team: {
      name: clampText(teamIn.name, 60).trim() || '智能体小队',
      finalizerId,
      autoPlan: teamIn.autoPlan === true,
    },
    agents,
  }
}

function serializeRun(run) {
  if (!run) return null
  return {
    id: run.id,
    mission: run.mission,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    currentRound: run.currentRound,
    currentAgentId: run.currentAgentId,
    phase: run.phase || '',
    delivered: run.delivered === true,
    nextFocus: run.nextFocus || '',
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
      usage: m.usage || null,
      streaming: false,
    })),
  }
}

export function apply(ctx) {
  let data = null
  let active = null // { run, controller }
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
        version: 1,
        team: data.team,
        agents: data.agents,
        lastRun: serializeRun(data.lastRun),
      },
      null,
      2,
    )
    await mkdir(path.dirname(storePath()), { recursive: true })
    const tmp = storePath() + '.' + process.pid + '.tmp'
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, storePath())
  }

  const ready = (async () => {
    let loaded = null
    try {
      loaded = JSON.parse(await readFile(storePath(), 'utf8'))
    } catch {
      loaded = null
    }
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
    data = {
      team: sanitized.team,
      agents: sanitized.agents,
      lastRun: previous && previous.lastRun ? previous.lastRun : null,
    }
    if (!previous) {
      // Fill seeded members with the profile's current default route.
      for (const agent of data.agents) {
        if (!agent.provider && defaultSelection.provider) agent.provider = defaultSelection.provider
        if (!agent.model && defaultSelection.model) agent.model = defaultSelection.model
      }
      await persist().catch(() => {})
    } else if (data.lastRun && data.lastRun.status === 'running') {
      // A long-running project does not survive a Host restart; mark it clearly
      // instead of showing a run that can never advance.
      data.lastRun.status = 'stopped'
      data.lastRun.error = '协作在 DSH 关闭或插件重载时中断'
      await persist().catch(() => {})
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
    const route = architectRoute(meta)
    if (!route) throw new Error('没有可用于组队的主 Agent 模型，请先配置模型服务')
    const catalog = catalogText(meta)
    if (!catalog) throw new Error('没有可用的模型服务，请先配置模型服务')
    const prompt = [
      '任务描述：',
      mission,
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

    let text = ''
    let failure = ''
    try {
      for await (const chunk of service.stream({
        provider: route.provider,
        model: route.model,
        system:
          '你是 DeepSeek Harness 多智能体团队的主控 Agent（team architect）。你擅长按任务难度设计协作小队，只输出严格 JSON。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature: 0.2,
        maxTokens: 2400,
        signal: options && options.signal,
      })) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          failure = (chunk.reason.failure && chunk.reason.failure.message) || '组队模型调用失败'
        }
      }
    } catch (error) {
      failure = String((error && error.message) || error)
    }
    if (failure) throw new Error(failure)
    const parsed = extractJsonObject(text)
    if (!parsed) throw new Error('主 Agent 未能产出可解析的组队方案')
    const normalized = normalizePlannedTeam(parsed, meta, route)
    if (!normalized) throw new Error('主 Agent 的组队方案没有有效成员')
    return {
      config: { team: normalized.team, agents: normalized.agents },
      rationale: normalized.rationale,
      route,
    }
  }

  function currentRun() {
    if (active) return active.run
    return data.lastRun || null
  }

  function statePayload() {
    return {
      ok: true,
      status: active ? 'running' : 'idle',
      config: { team: data.team, agents: data.agents },
      run: currentRun(),
    }
  }

  function buildSystemPrompt(agent, run) {
    const members = enabledAgents()
      .map((a) => '- ' + a.name + '（' + a.role + '）')
      .join('\n')
    return [
      agent.persona,
      '',
      '你正在一个多智能体协作团队中工作，必须始终以「' + agent.name + '」的第一人称身份发言。',
      '团队名称：' + data.team.name,
      '你的角色：' + agent.role,
      '团队成员：',
      members,
      '当前任务：' + run.mission,
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
    try {
      const service = llm()
      if (!service) throw new Error('模型服务不可用（llm）')
      const request = {
        provider: agent.provider,
        model: agent.model,
        system: buildSystemPrompt(agent, run),
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        signal,
      }
      if (agent.temperature !== undefined && agent.temperature !== null) {
        request.temperature = agent.temperature
      }
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
    } finally {
      message.streaming = false
      if (!message.text && !message.error) message.error = '本轮没有返回内容'
    }
    return message
  }

  function agentRoute(agent) {
    if (!agent || !agent.provider || !agent.model) return null
    if (!providerAvailable(agent)) return null
    return { provider: agent.provider, model: agent.model }
  }

  async function judgeRoute(meta) {
    const fromArchitect = architectRoute(meta)
    if (fromArchitect) return fromArchitect
    const finalizer = data.team.finalizerId ? findAgent(data.team.finalizerId) : null
    const finalizerRoute = agentRoute(finalizer)
    if (finalizerRoute) return finalizerRoute
    for (const agent of enabledAgents()) {
      const route = agentRoute(agent)
      if (route) return route
    }
    return null
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
    const route = await judgeRoute(meta)
    if (!route) return { failed: true, reason: '没有可用于交付判定的模型' }
    const transcript = buildTranscript(run, null, { recent: 10, maxChars: 6000 })
    const brief =
      run.brief && run.brief.length ? '项目进展摘要：\n' + run.brief.slice(-10).join('\n') + '\n\n' : ''
    const prompt = [
      '任务目标：',
      run.mission,
      '',
      brief + '团队最近几轮的对话：',
      transcript || '（暂无可读内容）',
      '',
      '请验收当前协作成果，并只输出一个 JSON 对象：',
      '{"delivered":true|false,"progress":true|false,"reason":"...","nextFocus":"..."}',
      '判断规则：',
      '1. 只有当任务目标已被完整、可执行地交付（结论明确，关键步骤/方案/验收方式齐全）时，才把 delivered 设为 true；不要以“还可以更好”为由无限推迟，也不要只有提纲就宣布交付。',
      '2. progress 表示本轮是否产生了新的实质进展（不是重复或仅改写措辞）。',
      '3. 未交付时，nextFocus 用一句具体的话指出下一轮必须补齐的缺口；已交付时 nextFocus 留空。',
      '4. reason 用一句中文说明判定理由。',
      '只输出 JSON，不要代码块或其他文字。',
    ].join('\n')

    let text = ''
    let failure = ''
    try {
      for await (const chunk of service.stream({
        provider: route.provider,
        model: route.model,
        system:
          '你是多智能体团队的主控 Agent，负责验收交付：判断任务是否已经可以交付给用户，只输出严格 JSON。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature: 0.1,
        maxTokens: 900,
        signal,
      })) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          failure = (chunk.reason.failure && chunk.reason.failure.message) || '交付判定调用失败'
        }
      }
    } catch (error) {
      failure = String((error && error.message) || error)
    }
    if (failure) return { failed: true, reason: failure }
    const parsed = extractJsonObject(text)
    if (!parsed || typeof parsed.delivered !== 'boolean') {
      return { failed: true, reason: '交付判定输出无法解析' }
    }
    return {
      delivered: parsed.delivered === true,
      progress: parsed.progress === true,
      reason: clampText(parsed.reason, 400).trim() || '（无说明）',
      nextFocus: clampText(parsed.nextFocus, 300).trim(),
    }
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
          const planned = await planTeam(run.mission, { signal: controller.signal })
          data.team = planned.config.team
          data.agents = planned.config.agents
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

      let round = 0
      let judgeFailures = 0
      let emptyRounds = 0
      let noProgressRounds = 0
      while (!disposed && !controller.signal.aborted) {
        const agents = enabledAgents()
        if (agents.length === 0) {
          run.status = 'error'
          run.error = '没有启用的团队成员'
          return
        }
        round += 1
        run.currentRound = round
        run.phase = 'working'
        let producedThisRound = false

        for (const agent of agents) {
          if (disposed || controller.signal.aborted) {
            run.status = 'stopped'
            return
          }
          if (!agent.provider || !agent.model) {
            pushSystem(run, '「' + agent.name + '」尚未配置模型，已跳过本轮发言。', round)
            continue
          }
          if (!providerAvailable(agent)) {
            pushSystem(
              run,
              '「' + agent.name + '」配置的服务「' + agent.provider + '」当前未启用，已跳过本轮发言。',
              round,
            )
            continue
          }
          const message = await runTurn(run, agent, null, controller.signal)
          if (message && message.text) producedThisRound = true
          if (controller.signal.aborted) {
            run.status = 'stopped'
            return
          }
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
        const verdict = await judgeDelivery(run, controller.signal)
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
        data.lastRun = serializeRun(run)
        await persist().catch(() => {})
      }
      run.status = 'stopped'
    } catch (error) {
      run.status = 'error'
      run.error = String((error && error.message) || error)
    } finally {
      run.endedAt = Date.now()
      run.currentAgentId = null
      run.phase = ''
      data.lastRun = serializeRun(run)
      active = null
      await persist().catch(() => {})
    }
  }

  async function startRun(mission, options) {
    if (active) return { ok: false, error: '已有协作正在进行中' }
    if (!data) return { ok: false, error: '插件仍在初始化，请稍后再试' }
    const text = clampText(mission, 4000).trim()
    if (!text) return { ok: false, error: '请先填写任务目标' }
    const wantPlan = Boolean(options && options.autoPlan)
    if (wantPlan) {
      if (!llm()) return { ok: false, error: '模型服务不可用，无法自动组队' }
      const meta = await readMeta()
      if (!architectRoute(meta)) return { ok: false, error: '没有可用于组队的主 Agent 模型' }
    } else {
      const agents = enabledAgents()
      if (agents.length === 0) return { ok: false, error: '没有启用的团队成员' }
      const runnable = agents.filter((a) => a.model && providerAvailable(a))
      if (runnable.length === 0) {
        return { ok: false, error: '没有可用模型：请到「团队设置」为成员选择服务与模型' }
      }
    }
    const run = {
      id: newId('run'),
      mission: text,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      currentRound: 1,
      currentAgentId: null,
      phase: wantPlan ? 'planning' : 'working',
      delivered: false,
      nextFocus: '',
      brief: [],
      error: '',
      autoPlan: wantPlan,
      stopRequested: false,
      messages: [
        {
          id: newId('msg'),
          kind: 'system',
          text: '协作开始 · 任务：' + text + ' · 持续到交付或手动停止',
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
        const sanitized = sanitizeConfig(body, { team: data.team, agents: data.agents })
        data.team = sanitized.team
        data.agents = sanitized.agents
        await persist()
        metaCache = null
        sendJson(res, 200, { ok: true, config: { team: data.team, agents: data.agents } })
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
          const plan = await planTeam(mission, { signal: AbortSignal.timeout(150000) })
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
        const result = await startRun(body.mission, { autoPlan: wantPlan })
        sendJson(res, result.ok ? 200 : 409, result)
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
        data.lastRun = null
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
          const plan = await planTeam(mission, { signal: exec.signal })
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
          const result = await startRun(mission, { autoPlan: false })
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
