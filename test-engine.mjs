/**
 * Deterministic engine check for the collaboration loop (no real model calls).
 * Runs the Host plugin against a fake ctx + fake llm and a throwaway HOME.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempHome = await mkdtemp(path.join(tmpdir(), 'atr-test-'))
process.env.USERPROFILE = tempHome
process.env.HOME = tempHome
process.env.DSH_PROFILE_DIR = path.join(tempHome, 'profile')

const { apply } = await import('./index.js')

let judgeCalls = 0
let judgeMode = 'eventual' // eventual | never
const agentPrompts = []
const summaryPrompts = []
const judgePrompts = []
const agentSystems = []

function streamOf(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        yield chunk
      }
    },
  }
}

const llm = {
  listProviders() {
    return [{ id: 'mock', name: 'Mock' }]
  },
  async listModels() {
    return [{ id: 'mock-1', name: 'Mock 1' }]
  },
  stream(options) {
    const system = options.system || ''
    const prompt = (options.messages && options.messages[0] && options.messages[0].content[0].text) || ''
    if (system.includes('负责验收交付')) {
      judgeCalls += 1
      judgePrompts.push(prompt)
      const deliver = judgeMode === 'eventual' && judgeCalls >= 2
      return streamOf([
        { type: 'text-delta', index: 0, text: JSON.stringify({
          delivered: deliver,
          progress: true,
          reason: deliver ? '产出已经覆盖要求' : '还缺验收方式',
          nextFocus: deliver ? '' : '补充验收方式与风险说明',
          speakers: deliver ? [] : ['乙'],
        }) },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
    }
    if (prompt.includes('最终交付说明')) {
      summaryPrompts.push(prompt)
      return streamOf([
        { type: 'text-delta', index: 0, text: '交付说明：结论、步骤、验收方式、风险均已给出。' },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
    }
    agentPrompts.push(prompt)
    agentSystems.push(system)
    return streamOf([
      { type: 'text-delta', index: 0, text: '本轮推进：按分工补齐一个具体缺口。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  },
}

let routeHandler = null
const ctx = {
  effect(fn) {
    const disposer = fn()
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
  get(name) {
    if (name === 'llm') return llm
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) }
    }
    if (name === 'agents') {
      return {
        currentInitiator: () => null,
        roots: () => [{ id: 'parent-session' }],
      }
    }
    if (name === 'subagents') {
      return {
        list: () => ['local'],
        startActivation: async () => ({
          result: Promise.resolve({ output: [{ type: 'text', text: '真实执行结果：已调用工具。' }] }),
          dispose: async () => {},
        }),
      }
    }
    if (name === 'tools') return undefined
    return undefined
  },
  webServer: {
    register(route) {
      routeHandler = route.handler
      return () => {
        routeHandler = null
      }
    },
  },
}

apply(ctx)

function call(method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = {
      method,
      url: '/api/agent-room' + route,
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:1' },
      async *[Symbol.asyncIterator]() {
        if (payload) yield payload
      },
    }
    const res = {
      status: 0,
      body: null,
      writeHead(code) {
        this.status = code
      },
      end(text) {
        try {
          this.body = JSON.parse(text)
        } catch (error) {
          reject(error)
          return
        }
        resolve({ status: this.status, body: this.body })
      },
    }
    Promise.resolve(routeHandler(req, res)).catch(reject)
  })
}

async function waitIdle(timeoutMs) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    const result = await call('GET', '/state')
    last = result.body
    if (last.status === 'idle') return last
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return last
}

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log('PASS ' + label)
  } else {
    failures.push(label + (detail ? ': ' + detail : ''))
    console.log('FAIL ' + label + (detail ? ': ' + detail : ''))
  }

}

const testConfig = {
  team: { name: '测试队', finalizerId: 'a1', autoPlan: false },
  agents: [
    { id: 'a1', name: '甲', role: '方案', emoji: '🅰', color: '#3b82f6', provider: 'mock', model: 'mock-1', temperature: 0.5, enabled: true, persona: '甲的人设' },
    { id: 'a2', name: '乙', role: '评审', emoji: '🅱', color: '#f59e0b', provider: 'mock', model: 'mock-1', temperature: 0.5, enabled: true, persona: '乙的人设' },
  ],
}

const configured = await call('POST', '/config', testConfig)
check('config saved', configured.body.ok === true, JSON.stringify(configured.body))

const started = await call('POST', '/start', { mission: '写一份两页的方案', autoPlan: false })
check('start ok', started.body.ok === true, JSON.stringify(started.body))

const done = await waitIdle(15000)
const messages = done.run.messages
const verdicts = messages.filter((message) => message.kind === 'verdict')
check('ran more than one round', done.run.currentRound >= 2, 'round=' + done.run.currentRound)
check('two delivery verdicts', verdicts.length === 2, 'verdicts=' + verdicts.length)
check('delivered', done.run.delivered === true && done.run.status === 'done', done.run.status)
check('summary produced', messages.some((message) => message.kind === 'summary'), 'no summary')
check('persisted delivered flag', verdicts.some((message) => message.delivered === true), 'no delivered verdict')
check(
  'second round used next focus',
  agentPrompts.some((prompt) => prompt.includes('补充验收方式与风险说明')),
  'focus missing from prompts',
)
check('summary used judge reason', summaryPrompts.length === 1, 'summaries=' + summaryPrompts.length)

// ── stop path: a judge that never delivers, stopped by the user ──────────────
judgeMode = 'never'
judgeCalls = 0
const startedAgain = await call('POST', '/start', { mission: '不会完成的任务', autoPlan: false })
check('second start ok', startedAgain.body.ok === true, JSON.stringify(startedAgain.body))

const running = await (async () => {
  const begin = Date.now()
  while (Date.now() - begin < 5000) {
    const state = await call('GET', '/state')
    if (state.body.status === 'running' && state.body.run.currentRound >= 2) return state.body
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return null
})()
check('kept going without a delivery verdict', Boolean(running), 'never reached round 2')
if (running) {
  const stopped = await call('POST', '/stop', {})
  check('stop accepted', stopped.body.ok === true, JSON.stringify(stopped.body))
  const final = await waitIdle(8000)
  check('stopped status', final.run.status === 'stopped', final.run.status)
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    const state = await call('GET', '/state')
    last = state.body
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return last
}

// ── acceptance + history + pause/resume + roster snapshot ───────────────────
const profileState = await call('GET', '/state')
check(
  'profile-scoped storage',
  profileState.body.storageProfile === process.env.DSH_PROFILE_DIR,
  profileState.body.storageProfile,
)
check('history recorded', (profileState.body.history || []).length >= 1, 'history empty')

judgeMode = 'eventual'
judgeCalls = 0
const historyCountBefore = (profileState.body.history || []).length
const acceptanceRun = await call('POST', '/start', {
  mission: '写一份带验收标准的方案',
  acceptance: '必须包含验收标准一节，并给出通过条件',
  autoPlan: false,
})
check('acceptance start ok', acceptanceRun.body.ok === true, JSON.stringify(acceptanceRun.body))
const acceptedState = await waitIdle(15000)
check('acceptance stored', acceptedState.run.acceptance.includes('验收标准'), acceptedState.run.acceptance)
check(
  'judge saw acceptance',
  judgePrompts.some((prompt) => prompt.includes('通过条件')),
  'acceptance missing from judge prompt',
)
const acceptedHistory = await call('GET', '/state')
check(
  'history grew',
  (acceptedHistory.body.history || []).length > historyCountBefore,
  'history did not grow',
)

const historyId = acceptedHistory.body.history[0].id
const opened = await call('POST', '/history/open', { id: historyId })
check('history open', opened.body.ok === true && opened.body.run.id === historyId, JSON.stringify(opened.body))
const afterOpen = await call('GET', '/state')
check('selected run exposed', afterOpen.body.selectedRunId === historyId, afterOpen.body.selectedRunId)
await call('POST', '/history/close', {})
const afterClose = await call('GET', '/state')
check('history close', afterClose.body.selectedRunId === null, afterClose.body.selectedRunId)

// pause / resume: a judge that never delivers, paused after a turn.
judgeMode = 'never'
judgeCalls = 0
const pauseStart = await call('POST', '/start', { mission: '暂停测试任务', autoPlan: false })
check('pause start ok', pauseStart.body.ok === true, JSON.stringify(pauseStart.body))
const pausing = await call('POST', '/pause', {})
check('pause accepted', pausing.body.ok === true, JSON.stringify(pausing.body))
const pausedState = await waitFor((state) => state.status === 'idle' && state.run.status === 'paused', 8000)
check('paused status', pausedState.run.status === 'paused', pausedState.run.status)
const resumed = await call('POST', '/resume', { id: pausedState.run.id })
check('resume accepted', resumed.body.ok === true, JSON.stringify(resumed.body))
const resumedState = await waitFor((state) => state.status === 'running', 3000)
check('resumed running', resumedState.status === 'running', resumedState.status)
await call('POST', '/stop', {})
const stoppedAgain = await waitIdle(8000)
check('stopped after resume', stoppedAgain.run.status === 'stopped', stoppedAgain.run.status)

// roster snapshot / undo
const currentConfig = (await call('GET', '/state')).body.config
const tempConfig = JSON.parse(JSON.stringify(currentConfig))
tempConfig.team.name = '临时阵容'
const snap = await call('POST', '/config', Object.assign({}, tempConfig, { snapshot: true }))
check('snapshot config saved', snap.body.ok === true, JSON.stringify(snap.body))
const undo = await call('POST', '/roster/undo', {})
check(
  'roster undo restored name',
  undo.body.ok === true && undo.body.config.team.name === currentConfig.team.name,
  JSON.stringify(undo.body),
)

// ── orchestration: lead picks the next speaker ──────────────────────────────
judgeMode = 'eventual'
judgeCalls = 0
const leadConfig = JSON.parse(JSON.stringify(currentConfig))
leadConfig.team.orchestration = 'lead-picks'
await call('POST', '/config', leadConfig)
await call('POST', '/start', { mission: '点名模式任务', autoPlan: false })
const leadRun = await waitIdle(15000)
const roundTwoAgents = (leadRun.run.messages || [])
  .filter((message) => message.kind === 'agent' && message.round === 2)
  .map((message) => message.agentName)
check(
  'lead-picks limited round two speakers',
  roundTwoAgents.length > 0 && roundTwoAgents.every((name) => name === '乙'),
  roundTwoAgents.join(','),
)

// ── workspace context is read into the agent system prompt ──────────────────
const workspace = await mkdtemp(path.join(tmpdir(), 'atr-workspace-'))
await mkdir(workspace, { recursive: true })
await writeFile(path.join(workspace, 'README.md'), '# WS_MARKER\n项目说明。', 'utf8')
agentSystems.length = 0
judgeMode = 'eventual'
judgeCalls = 0
const workspaceConfig = JSON.parse(JSON.stringify(currentConfig))
workspaceConfig.team.orchestration = 'round-robin'
workspaceConfig.team.workspace = workspace
await call('POST', '/config', workspaceConfig)
await call('POST', '/start', { mission: '读取工作区任务', autoPlan: false })
await waitIdle(15000)
check(
  'workspace context reached agents',
  agentSystems.some((system) => system.includes('工作区：') && system.includes('WS_MARKER')),
  'workspace context missing',
)

// ── unconfigured members are reported once, not once per round ──────────────
const skipConfig = JSON.parse(JSON.stringify(currentConfig))
skipConfig.team.workspace = ''
skipConfig.agents.push({
  id: 'a3',
  name: '缺模型',
  role: '观察',
  emoji: '🙂',
  color: '#64748b',
  provider: 'mock',
  model: '',
  temperature: 0.5,
  maxTokens: 0,
  reasoningEffort: '',
  enabled: true,
  persona: '观察者',
})
judgeMode = 'eventual'
judgeCalls = 0
await call('POST', '/config', skipConfig)
await call('POST', '/start', { mission: '跳过缺模型成员', autoPlan: false })
const skipRun = await waitIdle(15000)
const skipNotes = (skipRun.run.messages || []).filter(
  (message) => message.kind === 'system' && message.text.includes('不会发言'),
)
check('skip notice once', skipNotes.length === 1, 'notes=' + skipNotes.length)

// ── agent mode routes turns through a real subagent activation ──────────────
const agentConfig = JSON.parse(JSON.stringify(currentConfig))
agentConfig.team.mode = 'agent'
agentConfig.team.workspace = workspace
judgeMode = 'eventual'
judgeCalls = 0
await call('POST', '/config', agentConfig)
await call('POST', '/start', { mission: '真实执行模式任务', autoPlan: false })
const agentRun = await waitIdle(15000)
const executed = (agentRun.run.messages || []).filter(
  (message) => message.kind === 'agent' && message.execution === 'agent',
)
check(
  'agent mode executed through subagents',
  executed.length > 0 && executed.some((message) => message.text.includes('真实执行结果')),
  'executed=' + executed.length,
)

await rm(workspace, { recursive: true, force: true })
await rm(tempHome, { recursive: true, force: true })

console.log(failures.length ? '\nFAILURES:\n' + failures.join('\n') : '\nALL CHECKS PASSED')
process.exit(failures.length ? 1 : 0)
