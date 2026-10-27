/**
 * Deterministic engine check for the collaboration loop (no real model calls).
 * Runs the Host plugin against a fake ctx + fake llm and a throwaway HOME.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempHome = await mkdtemp(path.join(tmpdir(), 'atr-test-'))
process.env.USERPROFILE = tempHome
process.env.HOME = tempHome

const { apply } = await import('./index.js')

let judgeCalls = 0
let judgeMode = 'eventual' // eventual | never
const agentPrompts = []
const summaryPrompts = []

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
      const deliver = judgeMode === 'eventual' && judgeCalls >= 2
      return streamOf([
        { type: 'text-delta', index: 0, text: JSON.stringify({
          delivered: deliver,
          progress: true,
          reason: deliver ? '产出已经覆盖要求' : '还缺验收方式',
          nextFocus: deliver ? '' : '补充验收方式与风险说明',
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

await rm(tempHome, { recursive: true, force: true })

console.log(failures.length ? '\nFAILURES:\n' + failures.join('\n') : '\nALL CHECKS PASSED')
process.exit(failures.length ? 1 : 0)
