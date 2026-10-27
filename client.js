/**
 * Agent Team Room — browser half.
 *
 * Registers a left-sidebar panel entry and its main panel page. The page has
 * two surfaces: the collaboration space (members, mission, live transcript)
 * and the team settings (per-agent name / role / emoji / color / model /
 * temperature / persona). All data comes from this package's Host half over
 * same-origin `/api/agent-room/*` routes; nothing else in the page is shared.
 */
window.__ModuleLoader__.load({
  id: '@local/agent-team-room',
  factory(require) {
    'use strict'
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    var API = '/api/agent-room'
    var ctxRef = null
    var POLL_MS = 800

    // ───────────────────────── i18n ─────────────────────────
    function isZh() {
      try {
        if (ctxRef && ctxRef.locale) {
          var snapshot = ctxRef.locale.getLocale()
          if (snapshot && snapshot.active) return /^zh/i.test(snapshot.active)
        }
      } catch (error) {
        /* fall through to the document language */
      }
      var lang = typeof document !== 'undefined' && document.documentElement ? document.documentElement.lang : ''
      return !lang || /^zh/i.test(lang)
    }
    function T(zh, en) {
      return isZh() ? zh : en
    }

    // ───────────────────────── data helpers ─────────────────────────
    function api(pathname, body, method) {
      var options = { method: method || (body ? 'POST' : 'GET'), headers: {} }
      if (body) {
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      return fetch(API + pathname, options).then(function (response) {
        return response
          .json()
          .catch(function () {
            return { ok: false, error: 'HTTP ' + response.status }
          })
          .then(function (data) {
            if (!data || data.ok === false) {
              throw new Error((data && data.error) || 'HTTP ' + response.status)
            }
            return data
          })
      })
    }

    function clone(value) {
      return value ? JSON.parse(JSON.stringify(value)) : value
    }

    function formatTime(ts) {
      if (!ts) return ''
      try {
        return new Date(ts).toLocaleTimeString(isZh() ? 'zh-CN' : 'en-US', {
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch (error) {
        return ''
      }
    }

    function formatDuration(ms) {
      var seconds = Math.max(0, Math.round(ms / 1000))
      if (seconds < 60) return seconds + 's'
      var minutes = Math.floor(seconds / 60)
      return minutes + (isZh() ? '分' : 'm') + (seconds % 60) + 's'
    }

    function shortModel(model) {
      if (!model) return T('未选择模型', 'No model')
      return model.length > 26 ? model.slice(0, 24) + '…' : model
    }

    var STATUS_TEXT = {
      idle: function () {
        return T('空闲', 'Idle')
      },
      running: function () {
        return T('协作中', 'In progress')
      },
      done: function () {
        return T('已完成', 'Done')
      },
      delivered: function () {
        return T('已交付', 'Delivered')
      },
      stopped: function () {
        return T('已停止', 'Stopped')
      },
      error: function () {
        return T('出错', 'Error')
      },
    }

    var PHASE_TEXT = {
      planning: function () {
        return T('主 Agent 组队中', 'Planning team')
      },
      working: function () {
        return T('成员协作中', 'Working')
      },
      judging: function () {
        return T('主 Agent 交付判定中', 'Reviewing delivery')
      },
      summary: function () {
        return T('整理交付说明', 'Writing delivery note')
      },
    }

    // ───────────────────────── store ─────────────────────────
    var store = {
      state: {
        loading: true,
        ready: false,
        error: '',
        notice: '',
        noticeKind: 'info',
        config: null,
        run: null,
        running: false,
        meta: null,
        tab: 'chat',
        selectedAgentId: null,
        missionDraft: '',
        planning: false,
        plan: null,
        planError: '',
      },
      listeners: [],
    }

    function subscribe(listener) {
      store.listeners.push(listener)
      return function () {
        var index = store.listeners.indexOf(listener)
        if (index >= 0) store.listeners.splice(index, 1)
      }
    }

    function emit() {
      for (var i = 0; i < store.listeners.length; i += 1) {
        try {
          store.listeners[i]()
        } catch (error) {
          /* a broken consumer must not stop the others */
        }
      }
    }

    function patch(next) {
      Object.assign(store.state, next)
      emit()
    }

    function useStore() {
      var bump = useState(0)[1]
      useEffect(function () {
        return subscribe(function () {
          bump(function (n) {
            return n + 1
          })
        })
      }, [])
      return store.state
    }

    function notify(text, kind) {
      patch({ notice: text, noticeKind: kind || 'info' })
      setTimeout(function () {
        if (store.state.notice === text) patch({ notice: '' })
      }, 4000)
    }

    var pollHandle = null
    var metaRequested = false
    var planSeq = 0

    function pollOnce() {
      api('/state')
        .then(function (data) {
          patch({
            config: data.config,
            run: data.run,
            running: data.status === 'running',
            loading: false,
            ready: true,
            error: '',
          })
        })
        .catch(function (error) {
          patch({
            loading: false,
            ready: true,
            running: false,
            error: String((error && error.message) || error),
          })
        })
    }

    function startPolling() {
      if (pollHandle) return
      pollOnce()
      pollHandle = setInterval(pollOnce, POLL_MS)
    }

    function stopPolling() {
      if (pollHandle) {
        clearInterval(pollHandle)
        pollHandle = null
      }
    }

    function loadMeta() {
      if (metaRequested || store.state.meta) return
      metaRequested = true
      api('/meta')
        .then(function (meta) {
          patch({ meta: meta })
        })
        .catch(function () {
          metaRequested = false
        })
        .then(function () {
          metaRequested = false
        })
    }

    function startRun(mission, options) {
      if (store.state.running) return
      var text = (mission || '').trim()
      if (!text) {
        notify(T('请先填写任务目标', 'Enter a mission first'), 'warn')
        return
      }
      var autoPlan =
        options && typeof options.autoPlan === 'boolean'
          ? options.autoPlan
          : Boolean(store.state.config && store.state.config.team && store.state.config.team.autoPlan)
      planSeq += 1
      patch({ notice: '', running: true, plan: null, planError: '' })
      api('/start', { mission: text, autoPlan: autoPlan })
        .then(function () {
          patch({ missionDraft: '' })
          pollOnce()
        })
        .catch(function (error) {
          patch({ running: false })
          notify(String((error && error.message) || error), 'error')
        })
    }

    function requestPlan() {
      if (store.state.planning) return
      var text = (store.state.missionDraft || '').trim()
      if (!text) {
        notify(T('先写一个任务目标，主 Agent 才能组队', 'Write a mission first'), 'warn')
        return
      }
      var seq = (planSeq += 1)
      patch({ planning: true, plan: null, planError: '' })
      api('/plan', { mission: text })
        .then(function (data) {
          if (planSeq !== seq) return
          patch({
            planning: false,
            plan: {
              mission: text,
              config: data.config,
              rationale: data.rationale || '',
            },
          })
        })
        .catch(function (error) {
          if (planSeq !== seq) return
          patch({ planning: false, planError: String((error && error.message) || error) })
          notify(String((error && error.message) || error), 'error')
        })
    }

    function cancelPlan() {
      planSeq += 1
      patch({ planning: false, plan: null, planError: '' })
    }

    function applyPlan(andStart) {
      var plan = store.state.plan
      if (!plan) return
      var mission = (store.state.missionDraft || '').trim() || plan.mission
      api('/config', plan.config)
        .then(function (data) {
          patch({ config: data.config, plan: null })
          if (andStart) startRun(mission, { autoPlan: false })
          else notify(T('已采用主 Agent 的组队方案', 'Roster applied'), 'success')
        })
        .catch(function (error) {
          notify(String((error && error.message) || error), 'error')
        })
    }

    function setAutoPlan(enabled) {
      if (store.state.running) return
      var next = clone(store.state.config)
      next.team.autoPlan = Boolean(enabled)
      patch({ config: next })
      api('/config', next)
        .then(function (data) {
          patch({ config: data.config })
        })
        .catch(function (error) {
          notify(String((error && error.message) || error), 'error')
          pollOnce()
        })
    }

    function stopRun() {
      api('/stop', {})
        .then(function () {
          pollOnce()
        })
        .catch(function (error) {
          notify(String((error && error.message) || error), 'error')
        })
    }

    function sendInterjection(text) {
      var value = (text || '').trim()
      if (!value) return Promise.resolve()
      return api('/message', { text: value })
        .then(function () {
          pollOnce()
        })
        .catch(function (error) {
          notify(String((error && error.message) || error), 'error')
        })
    }

    function resetRun() {
      var ok = typeof window !== 'undefined' ? window.confirm(T('清空本场协作记录？', 'Clear this collaboration record?')) : true
      if (!ok) return
      api('/reset', {})
        .then(function () {
          patch({ selectedAgentId: null })
          pollOnce()
        })
        .catch(function (error) {
          notify(String((error && error.message) || error), 'error')
        })
    }

    function saveTeam(draft) {
      return api('/config', draft).then(function (data) {
        patch({ config: data.config })
        notify(T('团队设置已保存', 'Team settings saved'), 'success')
      })
    }

    function agentById(state, id) {
      if (!state.config || !id) return null
      for (var i = 0; i < state.config.agents.length; i += 1) {
        if (state.config.agents[i].id === id) return state.config.agents[i]
      }
      return null
    }

    // ───────────────────────── icons ─────────────────────────
    function TeamMark(props) {
      var size = props && props.size ? props.size : 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        h('circle', { cx: 12, cy: 5.5, r: 2.4 }),
        h('circle', { cx: 5, cy: 18, r: 2.4 }),
        h('circle', { cx: 19, cy: 18, r: 2.4 }),
        h('path', { d: 'M10.4 7.6 6.4 15.6M13.6 7.6l4 8M7.4 18h9.2' }),
      )
    }

    function Icon(props) {
      var name = props.name
      var common = {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }
      if (name === 'send') return h('svg', common, h('path', { d: 'M4 12 20 4l-7 16-2.2-6.2L4 12Z' }))
      if (name === 'stop') return h('svg', common, h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }))
      if (name === 'plus') return h('svg', common, h('path', { d: 'M12 5v14M5 12h14' }))
      if (name === 'trash')
        return h('svg', common, h('path', { d: 'M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v6M14 11v6' }))
      if (name === 'spark')
        return h('svg', common, h('path', { d: 'M12 3v5M12 16v5M3 12h5M16 12h5M6.3 6.3l2.4 2.4M15.3 15.3l2.4 2.4M17.7 6.3l-2.4 2.4M8.7 15.3l-2.4 2.4' }))
      return null
    }

    // ───────────────────────── shared pieces ─────────────────────────
    function Avatar(props) {
      var agent = props.agent
      var size = props.size || 30
      var style = {
        width: size,
        height: size,
        background: agent && agent.color ? agent.color : '#64748b',
        fontSize: Math.round(size * 0.48),
      }
      return h(
        'span',
        { className: 'atr-avatar', style: style, title: agent ? agent.name : '' },
        (agent && agent.emoji) || '🤖',
      )
    }

    function StatusPill(props) {
      var value = props.value
      var label = (STATUS_TEXT[value] || STATUS_TEXT.idle)()
      return h(
        'span',
        { className: 'atr-pill atr-pill-' + value },
        h('i', { className: 'atr-pill-dot' }),
        label,
      )
    }

    function Notice(props) {
      var notice = props.notice
      if (!notice || !notice.text) return null
      return h('div', { className: 'atr-notice atr-notice-' + notice.kind }, notice.text)
    }

    // ───────────────────────── header ─────────────────────────
    function Header(props) {
      var state = props.state
      var status = state.running
        ? 'running'
        : state.run
          ? state.run.delivered
            ? 'delivered'
            : state.run.status || 'idle'
          : 'idle'
      return h(
        'header',
        { className: 'atr-head' },
        h(
          'div',
          { className: 'atr-brand' },
          h('span', { className: 'atr-brand-mark' }, h(TeamMark, { size: 20 })),
          h(
            'div',
            { className: 'atr-brand-text' },
            h('h1', null, T('智能体团队', 'Agent Team')),
            h(
              'p',
              null,
              T('配置成员 · 下达任务 · 观看协作出结果', 'Configure agents, assign a mission, watch them work'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'atr-head-right' },
          h(StatusPill, { value: status }),
          h(
            'div',
            { className: 'atr-seg', role: 'tablist' },
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                'aria-selected': state.tab === 'chat',
                className: state.tab === 'chat' ? 'on' : '',
                onClick: function () {
                  patch({ tab: 'chat' })
                },
              },
              T('协作空间', 'Workspace'),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                'aria-selected': state.tab === 'settings',
                className: state.tab === 'settings' ? 'on' : '',
                onClick: function () {
                  patch({ tab: 'settings' })
                },
              },
              T('团队设置', 'Team settings'),
            ),
          ),
        ),
      )
    }

    // ───────────────────────── member rail ─────────────────────────
    function MemberRail(props) {
      var state = props.state
      var config = state.config
      var speaking = state.running && state.run ? state.run.currentAgentId : null
      return h(
        'aside',
        { className: 'atr-left' },
        h(
          'div',
          { className: 'atr-side-head' },
          T('团队成员', 'Members'),
          h('span', { className: 'atr-side-count' }, String(config.agents.length)),
        ),
        h(
          'div',
          { className: 'atr-members' },
          config.agents.map(function (agent) {
            var selected = state.selectedAgentId === agent.id
            var isSpeaking = speaking === agent.id
            return h(
              'button',
              {
                type: 'button',
                key: agent.id,
                className: 'atr-member' + (selected ? ' on' : '') + (agent.enabled ? '' : ' off'),
                onClick: function () {
                  patch({ selectedAgentId: selected ? null : agent.id })
                },
              },
              h(Avatar, { agent: agent, size: 30 }),
              h(
                'span',
                { className: 'atr-member-text' },
                h(
                  'span',
                  { className: 'atr-member-name' },
                  agent.name,
                  isSpeaking
                    ? h('i', { className: 'atr-live-dot', title: T('正在发言', 'Speaking') })
                    : null,
                ),
                h('span', { className: 'atr-member-role' }, agent.role),
              ),
            )
          }),
        ),
        h(
          'div',
          { className: 'atr-left-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'atr-link',
              onClick: function () {
                patch({ tab: 'settings' })
              },
            },
            h(Icon, { name: 'plus' }),
            T('管理成员', 'Manage members'),
          ),
          h('span', { className: 'atr-left-hint' }, T('点击成员查看详情', 'Click a member for details')),
        ),
      )
    }

    // ───────────────────────── mission bar ─────────────────────────
    function MissionBar(props) {
      var state = props.state
      var config = state.config
      var enabled = config.agents.filter(function (a) {
        return a.enabled
      }).length
      var finalizer = agentById(state, config.team.finalizerId)
      var autoPlan = Boolean(config.team.autoPlan)
      return h(
        'section',
        { className: 'atr-mission' },
        h(
          'div',
          { className: 'atr-mission-top' },
          h(
            'div',
            { className: 'atr-mission-topline' },
            h('span', { className: 'atr-mission-label' }, T('任务目标', 'Mission')),
            h(
              'label',
              {
                className: 'atr-chip' + (autoPlan ? ' on' : ''),
                title: T(
                  '开始协作时，先由主 Agent 按任务难度调整成员数量与配置',
                  'Before each run, the main Agent sizes and configures the team',
                ),
              },
              h('input', {
                type: 'checkbox',
                checked: autoPlan,
                disabled: state.running,
                onChange: function (event) {
                  setAutoPlan(event.target.checked)
                },
              }),
              T('按任务自动组队', 'Auto team'),
            ),
          ),
          h(
            'span',
            { className: 'atr-mission-meta' },
            T('成员 ', 'Members ') + enabled,
            ' · ',
            T('收尾 ', 'Wrap-up ') + (finalizer ? finalizer.name : T('不总结', 'none')),
            ' · ',
            T('持续到交付', 'until delivery'),
          ),
        ),
        h(
          'div',
          { className: 'atr-mission-row' },
          h('input', {
            className: 'atr-input atr-mission-input',
            value: state.missionDraft,
            disabled: state.running,
            placeholder: T(
              '例如：为团队协作插件设计页面结构与协作流程，给出可执行方案',
              'e.g. Design the page structure and workflow for a team-collaboration plugin',
            ),
            onChange: function (event) {
              patch({ missionDraft: event.target.value })
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter' && !state.running) {
                event.preventDefault()
                startRun(state.missionDraft)
              }
            },
          }),
          state.running
            ? h(
                'button',
                { type: 'button', className: 'atr-btn atr-btn-danger', onClick: stopRun },
                h(Icon, { name: 'stop' }),
                T('停止协作', 'Stop'),
              )
            : [
                h(
                  'button',
                  {
                    key: 'plan',
                    type: 'button',
                    className: 'atr-btn atr-btn-ghost',
                    disabled: state.planning,
                    onClick: requestPlan,
                    title: T(
                      '让主 Agent 分析任务难度并规划团队，先预览再采用',
                      'Let the main Agent size and configure the team, preview first',
                    ),
                  },
                  state.planning
                    ? h('i', { className: 'atr-spinner atr-spinner-sm' })
                    : h(Icon, { name: 'spark' }),
                  T('AI 组队', 'Plan team'),
                ),
                h(
                  'button',
                  {
                    key: 'start',
                    type: 'button',
                    className: 'atr-btn atr-btn-primary',
                    onClick: function () {
                      startRun(state.missionDraft)
                    },
                  },
                  h(Icon, { name: 'spark' }),
                  T('开始协作', 'Start'),
                ),
              ],
        ),
        state.run && !state.running
          ? h(
              'div',
              { className: 'atr-mission-foot' },
              h(
                'span',
                null,
                state.run.mission
                  ? T('上一场：', 'Last run: ') + state.run.mission
                  : '',
              ),
              h(
                'button',
                { type: 'button', className: 'atr-link', onClick: resetRun },
                h(Icon, { name: 'trash' }),
                T('清空记录', 'Clear'),
              ),
            )
          : null,
      )
    }

    // ───────────────────────── transcript ─────────────────────────
    function EmptyState() {
      var examples = [
        T(
          '设计一个团队协作插件的页面结构，列出关键模块与交互',
          'Design the page structure for a team-collaboration plugin',
        ),
        T(
          '评估把现有命令行工具接入 Web 面板的风险，并给出迁移步骤',
          'Assess the risk of exposing an existing CLI tool in a web panel',
        ),
        T(
          '为一个新功能写技术方案草案：目标、方案、风险、验证',
          'Draft a technical proposal: goal, approach, risk, verification',
        ),
      ]
      return h(
        'div',
        { className: 'atr-empty' },
        h(
          'div',
          { className: 'atr-empty-art' },
          h(TeamMark, { size: 54 }),
        ),
        h('h2', null, T('把一支小队拉进同一个任务', 'Put a small team on one mission')),
        h(
          'p',
          null,
          T(
            '成员按轮次持续协作，直到主 Agent 判定任务已交付或你主动停止。每个人都能看到前面的对话，你可以随时插话。',
            'Members keep collaborating until the main Agent judges the task deliverable or you stop. Everyone sees the conversation, and you can interject anytime.',
          ),
        ),
        h(
          'div',
          { className: 'atr-examples' },
          examples.map(function (example, index) {
            return h(
              'button',
              {
                type: 'button',
                key: index,
                className: 'atr-example',
                onClick: function () {
                  patch({ missionDraft: example })
                },
              },
              example,
            )
          }),
        ),
      )
    }

    function Message(props) {
      var message = props.message
      if (message.kind === 'plan') {
        return h(
          'div',
          { className: 'atr-plan-msg' },
          h(
            'div',
            { className: 'atr-plan-head' },
            h('span', { className: 'atr-plan-badge' }, '🧠 ' + T('主 Agent', 'Main Agent')),
            h('span', { className: 'atr-plan-sub' }, T('自动组队', 'Auto roster')),
            h('span', { className: 'atr-msg-time' }, formatTime(message.at)),
          ),
          h('div', { className: 'atr-plan-body' }, message.text),
        )
      }
      if (message.kind === 'verdict') {
        return h(
          'div',
          { className: 'atr-verdict' + (message.delivered ? ' is-delivered' : '') },
          h(
            'div',
            { className: 'atr-verdict-head' },
            h('span', { className: 'atr-plan-badge' }, '🧠 ' + T('主 Agent', 'Main Agent')),
            h(
              'span',
              { className: 'atr-verdict-state' },
              message.delivered ? T('已交付', 'Delivered') : T('继续协作', 'Continue'),
            ),
            h('span', { className: 'atr-msg-time' }, formatTime(message.at)),
          ),
          h('div', { className: 'atr-plan-body' }, message.text),
        )
      }
      if (message.kind === 'system') {
        return h(
          'div',
          { className: 'atr-sys' },
          h('span', null, message.text),
          h('em', null, formatTime(message.at)),
        )
      }
      if (message.kind === 'user') {
        return h(
          'div',
          { className: 'atr-msg atr-msg-user' },
          h(
            'div',
            { className: 'atr-msg-body' },
            h(
              'div',
              { className: 'atr-msg-head atr-msg-head-user' },
              h('span', { className: 'atr-msg-name' }, T('你', 'You')),
              h('span', null, formatTime(message.at)),
            ),
            h('div', { className: 'atr-bubble atr-bubble-user' }, message.text),
          ),
        )
      }
      var agent = props.agent || {
        name: message.agentName,
        role: message.role,
        emoji: message.emoji,
        color: message.color,
      }
      var isSummary = message.kind === 'summary'
      return h(
        'div',
        { className: 'atr-msg' + (isSummary ? ' atr-msg-summary' : '') },
        h(Avatar, { agent: agent, size: 30 }),
        h(
          'div',
          { className: 'atr-msg-body' },
          h(
            'div',
            { className: 'atr-msg-head' },
            h('span', { className: 'atr-msg-name' }, message.agentName),
            h('span', { className: 'atr-msg-role' }, message.role),
            isSummary ? h('span', { className: 'atr-badge' }, T('总结', 'Summary')) : null,
            h('span', { className: 'atr-msg-time' }, formatTime(message.at)),
          ),
          message.reasoning
            ? h(
                'details',
                { className: 'atr-reasoning' },
                h('summary', null, T('思考过程', 'Reasoning')),
                h('div', { className: 'atr-reasoning-body' }, message.reasoning),
              )
            : null,
          h(
            'div',
            { className: 'atr-bubble' },
            message.text
              ? message.text
              : h(
                  'span',
                  { className: 'atr-thinking' },
                  T('正在思考', 'Thinking'),
                  h('i', null, '.'),
                  h('i', null, '.'),
                  h('i', null, '.'),
                ),
            message.streaming ? h('span', { className: 'atr-cursor' }) : null,
          ),
          message.error
            ? h('div', { className: 'atr-msg-error' }, T('本轮失败：', 'Failed: ') + message.error)
            : null,
        ),
      )
    }

    function Transcript(props) {
      var state = props.state
      var run = state.run
      var scroller = useRef(null)
      var messages = run && Array.isArray(run.messages) ? run.messages : []
      var last = messages.length ? messages[messages.length - 1] : null
      var lastSignal = last ? last.id + ':' + (last.text ? last.text.length : 0) : ''

      useEffect(
        function () {
          var element = scroller.current
          if (!element) return
          element.scrollTop = element.scrollHeight
        },
        [lastSignal, messages.length],
      )

      return h(
        'div',
        { className: 'atr-chat', ref: scroller },
        messages.length === 0 ? h(EmptyState, null) : null,
        messages.map(function (message, index) {
          var previous = index > 0 ? messages[index - 1] : null
          var showDivider =
            message.round > 0 &&
            message.kind !== 'verdict' &&
            message.kind !== 'plan' &&
            (!previous || previous.round !== message.round || previous.kind === 'verdict')
          var roundDivider = showDivider
            ? h(
                'div',
                { className: 'atr-round', key: 'round-' + message.id },
                message.kind === 'summary'
                  ? T('交付总结', 'Delivery')
                  : T('第 ', 'Round ') + message.round + T(' 轮', ''),
              )
            : null
          return h(
            React.Fragment,
            { key: message.id },
            roundDivider,
            h(Message, {
              message: message,
              agent: agentById(state, message.agentId),
            }),
          )
        }),
        run && run.status === 'error'
          ? h('div', { className: 'atr-run-error' }, T('协作中断：', 'Run failed: ') + (run.error || ''))
          : null,
      )
    }

    // ───────────────────────── composer ─────────────────────────
    function Composer(props) {
      var state = props.state
      var pair = useState('')
      var value = pair[0]
      var setValue = pair[1]
      function submit() {
        var text = value.trim()
        if (!text) return
        setValue('')
        sendInterjection(text)
      }
      return h(
        'div',
        { className: 'atr-composer' },
        h(
          'div',
          { className: 'atr-compose-box' + (state.running ? '' : ' atr-compose-disabled') },
          h('textarea', {
            rows: 1,
            value: value,
            disabled: !state.running,
            placeholder: state.running
              ? T('在协作中插话，团队会在下一轮看到…', 'Interject — the team sees it next turn…')
              : T('开始协作后即可向团队插话', 'Start a run to interject'),
            onChange: function (event) {
              setValue(event.target.value)
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'atr-send',
              disabled: !state.running || !value.trim(),
              onClick: submit,
              title: T('发送插话', 'Send'),
              'aria-label': T('发送插话', 'Send'),
            },
            h(Icon, { name: 'send' }),
          ),
        ),
        h(
          'div',
          { className: 'atr-compose-hint' },
          state.running
            ? T('成员会在下一轮发言时读到你的插话 · Shift+Enter 换行', 'Members read it next turn · Shift+Enter for a new line')
            : T('协作进行中才能插话', 'Interjections are available during a run'),
        ),
      )
    }

    // ───────────────────────── inspector ─────────────────────────
    function Inspector(props) {
      var state = props.state
      var run = state.run
      var agent = agentById(state, state.selectedAgentId)
      var speaking = run && state.running ? agentById(state, run.currentAgentId) : null
      var counts = {}
      var tokens = 0
      if (run && Array.isArray(run.messages)) {
        run.messages.forEach(function (message) {
          if (message.kind !== 'agent' && message.kind !== 'summary') return
          counts[message.agentId] = (counts[message.agentId] || 0) + 1
          if (message.usage) tokens += (message.usage.inputTokens || 0) + (message.usage.outputTokens || 0)
        })
      }
      var maxCount = 1
      Object.keys(counts).forEach(function (id) {
        maxCount = Math.max(maxCount, counts[id])
      })
      var elapsed =
        run && run.startedAt ? formatDuration((run.endedAt || Date.now()) - run.startedAt) : '—'

      return h(
        'aside',
        { className: 'atr-right' },
        agent
          ? h(
              'section',
              { className: 'atr-side-sec' },
              h(
                'div',
                { className: 'atr-sec-title' },
                T('成员详情', 'Member'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'atr-link atr-sec-close',
                    onClick: function () {
                      patch({ selectedAgentId: null })
                    },
                  },
                  T('收起', 'Close'),
                ),
              ),
              h(
                'div',
                { className: 'atr-detail-head' },
                h(Avatar, { agent: agent, size: 40 }),
                h(
                  'div',
                  null,
                  h('div', { className: 'atr-detail-name' }, agent.name),
                  h('div', { className: 'atr-detail-role' }, agent.role),
                ),
              ),
              h(
                'div',
                { className: 'atr-kv' },
                h('span', null, T('服务', 'Provider')),
                h('span', null, agent.provider || '—'),
              ),
              h(
                'div',
                { className: 'atr-kv' },
                h('span', null, T('模型', 'Model')),
                h('span', { title: agent.model }, shortModel(agent.model)),
              ),
              h(
                'div',
                { className: 'atr-kv' },
                h('span', null, T('温度', 'Temperature')),
                h('span', null, String(agent.temperature)),
              ),
              h(
                'div',
                { className: 'atr-kv' },
                h('span', null, T('本场发言', 'Turns')),
                h('span', null, String(counts[agent.id] || 0)),
              ),
              h('div', { className: 'atr-persona' }, agent.persona),
              h(
                'button',
                {
                  type: 'button',
                  className: 'atr-btn atr-btn-ghost atr-btn-block',
                  onClick: function () {
                    patch({ tab: 'settings', selectedAgentId: agent.id })
                  },
                },
                T('在团队设置中编辑', 'Edit in team settings'),
              ),
            )
          : null,
        h(
          'section',
          { className: 'atr-side-sec' },
          h('div', { className: 'atr-sec-title' }, T('本场运行', 'This run')),
          h(
            'div',
            { className: 'atr-kv' },
            h('span', null, T('状态', 'Status')),
            h(
              'span',
              null,
              run
                ? run.delivered
                  ? STATUS_TEXT.delivered()
                  : (STATUS_TEXT[run.status] || STATUS_TEXT.idle)()
                : T('尚未开始', 'Not started'),
            ),
          ),
          h(
            'div',
            { className: 'atr-kv' },
            h('span', null, T('进度', 'Progress')),
            h(
              'span',
              null,
              run
                ? state.running
                  ? T('第 ', 'Round ') + (run.currentRound || 0) + T(' 轮', '') + ' · ' + T('持续到交付', 'until delivery')
                  : T('共 ', 'Rounds: ') + (run.currentRound || 0) + T(' 轮', '')
                : '—',
            ),
          ),
          h(
            'div',
            { className: 'atr-kv' },
            h('span', null, T('阶段', 'Phase')),
            h(
              'span',
              null,
              run && (state.running || run.phase)
                ? (PHASE_TEXT[run.phase] ||
                    function () {
                      return '—'
                    })()
                : '—',
            ),
          ),
          h(
            'div',
            { className: 'atr-kv' },
            h('span', null, T('当前发言', 'Speaking')),
            h(
              'span',
              { className: 'atr-kv-agent' },
              speaking
                ? [h('i', { key: 'd', className: 'atr-live-dot' }), speaking.name]
                : run && state.running && run.phase === 'judging'
                  ? T('主 Agent', 'Main Agent')
                  : '—',
            ),
          ),
          h(
            'div',
            { className: 'atr-kv' },
            h('span', null, T('用时', 'Elapsed')),
            h('span', null, elapsed),
          ),
          h(
            'div',
            { className: 'atr-kv' },
            h('span', null, T('Token', 'Tokens')),
            h('span', null, tokens ? String(tokens) : '—'),
          ),
        ),
        h(
          'section',
          { className: 'atr-side-sec' },
          h('div', { className: 'atr-sec-title' }, T('发言分布', 'Speaking share')),
          state.config.agents.map(function (item) {
            var count = counts[item.id] || 0
            return h(
              'div',
              { className: 'atr-stat', key: item.id },
              h(
                'div',
                { className: 'atr-stat-head' },
                h('span', null, item.name),
                h('span', null, String(count)),
              ),
              h(
                'div',
                { className: 'atr-bar' },
                h('i', {
                  style: {
                    width: Math.round((count / maxCount) * 100) + '%',
                    background: item.color,
                  },
                }),
              ),
            )
          }),
        ),
        h(
          'section',
          { className: 'atr-side-sec' },
          h(
            'button',
            {
              type: 'button',
              className: 'atr-btn atr-btn-ghost atr-btn-block',
              disabled: state.running || !run,
              onClick: resetRun,
            },
            h(Icon, { name: 'trash' }),
            T('清空本场记录', 'Clear record'),
          ),
        ),
      )
    }

    // ───────────────────────── chat view ─────────────────────────
    function ChatView(props) {
      var state = props.state
      return h(
        'div',
        { className: 'atr-body' },
        h(MemberRail, { state: state }),
        h(
          'main',
          { className: 'atr-main' },
          h(MissionBar, { state: state }),
          h(PlanInline, { state: state }),
          h(Transcript, { state: state }),
          h(Composer, { state: state }),
        ),
        h(Inspector, { state: state }),
      )
    }

    // ───────────────────────── settings view ─────────────────────────
    function providerModels(meta, providerId) {
      if (!meta || !Array.isArray(meta.providers)) return []
      for (var i = 0; i < meta.providers.length; i += 1) {
        if (meta.providers[i].id === providerId) return meta.providers[i].models || []
      }
      return []
    }

    function AgentCard(props) {
      var draft = props.draft
      var index = props.index
      var agent = draft.agents[index]
      var meta = props.meta
      var onField = props.onField
      var providerOptions = (meta && Array.isArray(meta.providers) ? meta.providers : []).slice()
      var models = providerModels(meta, agent.provider)
      var colors = ['#3b82f6', '#0ea5e9', '#14b8a6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#64748b']

      return h(
        'div',
        { className: 'atr-agent-card' + (agent.enabled ? '' : ' atr-agent-off') },
        h(
          'div',
          { className: 'atr-ac-head' },
          h(Avatar, { agent: agent, size: 36 }),
          h('input', {
            className: 'atr-input atr-ac-name',
            value: agent.name,
            placeholder: T('成员名称', 'Agent name'),
            onChange: function (event) {
              onField(index, 'name', event.target.value)
            },
          }),
          h(
            'label',
            { className: 'atr-switch', title: T('启用该成员', 'Enable this member') },
            h('input', {
              type: 'checkbox',
              checked: agent.enabled,
              onChange: function (event) {
                onField(index, 'enabled', event.target.checked)
              },
            }),
            h('i', null),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'atr-icon-btn',
              disabled: draft.agents.length <= 1,
              title: T('删除成员', 'Remove member'),
              'aria-label': T('删除成员', 'Remove member'),
              onClick: function () {
                props.onRemove(index)
              },
            },
            h(Icon, { name: 'trash' }),
          ),
        ),
        h(
          'label',
          { className: 'atr-label' },
          T('角色', 'Role'),
          h('input', {
            className: 'atr-input',
            value: agent.role,
            placeholder: T('例如：评审者 · 找风险', 'e.g. Reviewer · finds risks'),
            onChange: function (event) {
              onField(index, 'role', event.target.value)
            },
          }),
        ),
        h(
          'div',
          { className: 'atr-ac-grid' },
          h(
            'label',
            { className: 'atr-label' },
            T('头像表情', 'Emoji'),
            h('input', {
              className: 'atr-input',
              value: agent.emoji,
              maxLength: 4,
              onChange: function (event) {
                onField(index, 'emoji', event.target.value)
              },
            }),
          ),
          h(
            'label',
            { className: 'atr-label' },
            T('温度 ', 'Temp ') + agent.temperature,
            h('input', {
              type: 'range',
              className: 'atr-range',
              min: 0,
              max: 1,
              step: 0.05,
              value: agent.temperature,
              onChange: function (event) {
                onField(index, 'temperature', Number(event.target.value))
              },
            }),
          ),
        ),
        h(
          'div',
          { className: 'atr-colors' },
          colors.map(function (color) {
            return h('button', {
              type: 'button',
              key: color,
              className: 'atr-color' + (agent.color === color ? ' on' : ''),
              style: { background: color },
              title: color,
              'aria-label': color,
              onClick: function () {
                onField(index, 'color', color)
              },
            })
          }),
        ),
        h(
          'div',
          { className: 'atr-ac-grid' },
          h(
            'label',
            { className: 'atr-label' },
            T('服务', 'Provider'),
            providerOptions.length
              ? h(
                  'select',
                  {
                    className: 'atr-select',
                    value: agent.provider,
                    onChange: function (event) {
                      var provider = event.target.value
                      var nextModels = providerModels(meta, provider)
                      onField(index, 'provider', provider)
                      onField(index, 'model', nextModels.length ? nextModels[0].id : '')
                    },
                  },
                  agent.provider && !providerOptions.some(function (p) { return p.id === agent.provider })
                    ? h('option', { value: agent.provider }, agent.provider)
                    : null,
                  providerOptions.map(function (provider) {
                    return h('option', { key: provider.id, value: provider.id }, provider.name)
                  }),
                )
              : h('input', {
                  className: 'atr-input',
                  value: agent.provider,
                  placeholder: T('服务 id', 'Provider id'),
                  onChange: function (event) {
                    onField(index, 'provider', event.target.value)
                  },
                }),
          ),
          h(
            'label',
            { className: 'atr-label' },
            T('模型', 'Model'),
            models.length
              ? h(
                  'select',
                  {
                    className: 'atr-select',
                    value: agent.model,
                    onChange: function (event) {
                      onField(index, 'model', event.target.value)
                    },
                  },
                  agent.model && !models.some(function (m) { return m.id === agent.model })
                    ? h('option', { value: agent.model }, agent.model)
                    : null,
                  models.map(function (model) {
                    return h('option', { key: model.id, value: model.id }, model.name)
                  }),
                )
              : h('input', {
                  className: 'atr-input',
                  value: agent.model,
                  placeholder: T('模型 id', 'Model id'),
                  onChange: function (event) {
                    onField(index, 'model', event.target.value)
                  },
                }),
          ),
        ),
        h(
          'label',
          { className: 'atr-label' },
          T('人设 / 系统提示词', 'Persona / system prompt'),
          h('textarea', {
            className: 'atr-textarea',
            rows: 4,
            value: agent.persona,
            placeholder: T('描述这个成员如何思考、如何发言…', 'How this member thinks and speaks…'),
            onChange: function (event) {
              onField(index, 'persona', event.target.value)
            },
          }),
        ),
      )
    }

    function SettingsView(props) {
      var state = props.state
      var pair = useState(function () {
        return clone(state.config)
      })
      var draft = pair[0]
      var setDraft = pair[1]
      var saveState = useState(false)
      var saving = saveState[0]
      var setSaving = saveState[1]
      var errorState = useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var meta = state.meta

      function modify(next) {
        setDraft(function (previous) {
          return Object.assign({}, previous, typeof next === 'function' ? next(previous) : next)
        })
      }
      function updateAgent(index, mutate) {
        setDraft(function (previous) {
          var agents = previous.agents.map(function (agent, i) {
            if (i !== index) return agent
            var copy = Object.assign({}, agent)
            mutate(copy)
            return copy
          })
          return Object.assign({}, previous, { agents: agents })
        })
      }
      function onField(index, key, value) {
        updateAgent(index, function (agent) {
          agent[key] = value
        })
      }
      function addAgent() {
        if (draft.agents.length >= 6) return
        var base = state.meta && state.meta.defaultSelection ? state.meta.defaultSelection : { provider: '', model: '' }
        modify(function (previous) {
          return {
            agents: previous.agents.concat([
              {
                id: 'agent-' + Date.now().toString(36),
                name: T('新成员', 'New member') + ' ' + (previous.agents.length + 1),
                role: T('补充视角', 'Extra perspective'),
                emoji: '🙂',
                color: '#64748b',
                provider: base.provider || '',
                model: base.model || '',
                temperature: 0.7,
                enabled: true,
                persona: T(
                  '你是团队中的新成员。先说明你能补充的独特视角，再给出具体贡献。',
                  'You are a new member. State the unique angle you add, then contribute concretely.',
                ),
              },
            ]),
          }
        })
      }
      function removeAgent(index) {
        if (draft.agents.length <= 1) return
        var removed = draft.agents[index]
        modify(function (previous) {
          return {
            agents: previous.agents.filter(function (_, i) {
              return i !== index
            }),
            team: Object.assign({}, previous.team, {
              finalizerId: previous.team.finalizerId === removed.id ? null : previous.team.finalizerId,
            }),
          }
        })
      }

      var dirty = JSON.stringify(draft) !== JSON.stringify(state.config)
      var defaultRole = meta && meta.providers && meta.providers.length === 0

      return h(
        'div',
        { className: 'atr-settings' },
        error ? h('div', { className: 'atr-notice atr-notice-error' }, error) : null,
        defaultRole
          ? h(
              'div',
              { className: 'atr-notice atr-notice-warn' },
              T(
                '未检测到已启用的模型服务：请先在「设置 → 模型」中添加服务，或直接填写服务与模型 id。',
                'No model provider detected. Add one in Settings → Models, or type provider/model ids.',
              ),
            )
          : null,
        h(
          'section',
          { className: 'atr-set-team' },
          h('div', { className: 'atr-set-title' }, T('团队设置', 'Team settings')),
          h(
            'div',
            { className: 'atr-set-grid' },
            h(
              'label',
              { className: 'atr-label' },
              T('团队名称', 'Team name'),
              h('input', {
                className: 'atr-input',
                value: draft.team.name,
                onChange: function (event) {
                  modify({ team: Object.assign({}, draft.team, { name: event.target.value }) })
                },
              }),
            ),
            h(
              'label',
              { className: 'atr-label' },
              T('收尾总结', 'Wrap-up'),
              h(
                'select',
                {
                  className: 'atr-select',
                  value: draft.team.finalizerId || '',
                  onChange: function (event) {
                    modify({
                      team: Object.assign({}, draft.team, { finalizerId: event.target.value || null }),
                    })
                  },
                },
                h('option', { value: '' }, T('不总结', 'None')),
                draft.agents.map(function (agent) {
                  return h('option', { key: agent.id, value: agent.id }, agent.name)
                }),
              ),
            ),
          ),
          h(
            'div',
            { className: 'atr-set-toggle' },
            h(
              'div',
              { className: 'atr-set-toggle-text' },
              h('b', null, T('自动组队', 'Auto team')),
              h(
                'span',
                null,
                T(
                  '开始协作时，先由主 Agent 按任务内容与难度调整成员数量、角色与模型，再执行协作；关闭时严格使用当前配置。',
                  'Before each run the main Agent sizes and configures the team for the mission; off means use this roster exactly.',
                ),
              ),
            ),
            h(
              'label',
              { className: 'atr-switch' },
              h('input', {
                type: 'checkbox',
                checked: Boolean(draft.team.autoPlan),
                onChange: function (event) {
                  modify({
                    team: Object.assign({}, draft.team, { autoPlan: event.target.checked }),
                  })
                },
              }),
              h('i', null),
            ),
          ),
        ),
        h(
          'div',
          { className: 'atr-agent-grid' },
          draft.agents.map(function (agent, index) {
            return h(AgentCard, {
              key: agent.id,
              draft: draft,
              index: index,
              meta: meta,
              onField: onField,
              onRemove: removeAgent,
            })
          }),
          draft.agents.length < 6
            ? h(
                'button',
                { type: 'button', className: 'atr-add-agent', onClick: addAgent },
                h(Icon, { name: 'plus' }),
                h('span', null, T('添加成员', 'Add member')),
              )
            : null,
        ),
        h(
          'div',
          { className: 'atr-savebar' },
          h(
            'span',
            { className: 'atr-save-hint' },
            state.running
              ? T('协作进行中，停止后才能保存修改', 'Stop the run to save changes')
              : dirty
                ? T('有未保存的修改', 'Unsaved changes')
                : T('已保存', 'Saved'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'atr-btn atr-btn-ghost',
              disabled: !dirty || saving || state.running,
              onClick: function () {
                setDraft(clone(state.config))
                setError('')
              },
            },
            T('还原', 'Revert'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'atr-btn atr-btn-primary',
              disabled: !dirty || saving || state.running,
              onClick: function () {
                setSaving(true)
                setError('')
                saveTeam(draft)
                  .then(function () {
                    setDraft(clone(store.state.config))
                  })
                  .catch(function (err) {
                    setError(String((err && err.message) || err))
                  })
                  .then(function () {
                    setSaving(false)
                  })
              },
            },
            saving ? T('保存中…', 'Saving…') : T('保存团队设置', 'Save team settings'),
          ),
        ),
      )
    }

    // ───────────────────────── inline plan preview ─────────────────────────
    function PlanInline(props) {
      var state = props.state
      var plan = state.plan
      if (!state.planning && !plan && !state.planError) return null
      var agents = plan && plan.config ? plan.config.agents : []
      var team = plan && plan.config ? plan.config.team : null
      return h(
        'section',
        { className: 'atr-plan-inline' },
        h(
          'div',
          { className: 'atr-plan-inline-head' },
          h('span', { className: 'atr-plan-badge' }, '🧠 ' + T('主 Agent', 'Main Agent')),
          h('span', { className: 'atr-plan-inline-title' }, T('按任务难度组队', 'Sizing the team to the mission')),
          h(
            'button',
            {
              type: 'button',
              className: 'atr-icon-btn',
              onClick: cancelPlan,
              title: T('收起', 'Dismiss'),
              'aria-label': T('收起', 'Dismiss'),
            },
            '✕',
          ),
        ),
        state.planning
          ? h(
              'div',
              { className: 'atr-plan-loading' },
              h('i', { className: 'atr-spinner atr-spinner-sm' }),
              h(
                'span',
                null,
                T(
                  '正在分析任务内容与难度，决定成员数量与配置…',
                  'Analyzing the mission to size and configure the team…',
                ),
              ),
            )
          : null,
        state.planError
          ? h(
              'div',
              { className: 'atr-plan-error' },
              h('span', null, state.planError),
              h(
                'button',
                { type: 'button', className: 'atr-link', onClick: requestPlan },
                T('重试', 'Retry'),
              ),
            )
          : null,
        plan && plan.rationale
          ? h('div', { className: 'atr-plan-rationale' }, plan.rationale)
          : null,
        plan
          ? h(
              'div',
              { className: 'atr-plan-chiprow' },
              agents.map(function (agent, index) {
                return h(
                  'div',
                  { className: 'atr-plan-chip', key: agent.id || index },
                  h(Avatar, { agent: agent, size: 22 }),
                  h('span', { className: 'atr-plan-chipname' }, agent.name),
                  h('span', { className: 'atr-plan-chiprole' }, agent.role),
                  team && team.finalizerId === agent.id
                    ? h('span', { className: 'atr-badge' }, T('收尾', 'Wrap'))
                    : null,
                )
              }),
            )
          : null,
        plan
          ? h(
              'div',
              { className: 'atr-plan-inline-foot' },
              h(
                'span',
                { className: 'atr-plan-mission' },
                T('任务：', 'Mission: ') +
                  (plan.mission.length > 56 ? plan.mission.slice(0, 56) + '…' : plan.mission) +
                  ' · ' +
                  T('成员 ', 'Members ') +
                  agents.length +
                  ' · ' +
                  T('持续到交付', 'until delivery'),
              ),
              h(
                'div',
                { className: 'atr-plan-inline-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'atr-btn atr-btn-ghost',
                    onClick: function () {
                      applyPlan(false)
                    },
                  },
                  T('只采用配置', 'Apply roster'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'atr-btn atr-btn-primary',
                    onClick: function () {
                      applyPlan(true)
                    },
                  },
                  h(Icon, { name: 'spark' }),
                  T('采用并开始协作', 'Apply & start'),
                ),
              ),
            )
          : null,
      )
    }

    // ───────────────────────── page shell ─────────────────────────
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error, info) {
        console.error('[agent-team-room] page render failed', error, info)
      }
      render() {
        if (this.state.error) {
          var message = String((this.state.error && this.state.error.message) || this.state.error)
          return h(
            'div',
            { className: 'atr-page' },
            h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
            h(
              'div',
              { className: 'atr-loading' },
              h('h2', null, T('页面渲染出错', 'Page failed to render')),
              h('p', null, message),
              h(
                'button',
                {
                  type: 'button',
                  className: 'atr-btn atr-btn-ghost',
                  onClick: function () {
                    if (typeof window !== 'undefined') window.location.reload()
                  },
                },
                T('刷新页面', 'Reload page'),
              ),
            ),
          )
        }
        return this.props.children
      }
    }

    function Page() {
      var state = useStore()
      useEffect(function () {
        startPolling()
        loadMeta()
        return function () {
          stopPolling()
        }
      }, [])

      var content
      if (state.loading && !state.config) {
        content = h(
          'div',
          { className: 'atr-loading' },
          h('i', { className: 'atr-spinner' }),
          T('正在读取团队信息…', 'Loading team…'),
        )
      } else if (!state.config) {
        content = h(
          'div',
          { className: 'atr-loading' },
          h('p', null, state.error || T('无法读取团队信息', 'Cannot load team data')),
          h(
            'button',
            {
              type: 'button',
              className: 'atr-btn atr-btn-ghost',
              onClick: function () {
                pollOnce()
              },
            },
            T('重试', 'Retry'),
          ),
        )
      } else {
        content =
          state.tab === 'settings'
            ? h(SettingsView, { state: state })
            : h(ChatView, { state: state })
      }

      return h(
        'div',
        { className: 'atr-page' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(Header, { state: state }),
        state.notice
          ? h(Notice, { notice: { text: state.notice, kind: state.noticeKind } })
          : null,
        content,
      )
    }

    // ───────────────────────── styles ─────────────────────────
    var CSS = [
      '.atr-page{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;overflow:hidden;position:relative}',
      '.atr-head{display:flex;align-items:center;gap:16px;padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent),transparent)}',
      '.atr-brand{display:flex;align-items:center;gap:11px;min-width:0}',
      '.atr-brand-mark{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:11px;color:#fff;background:linear-gradient(135deg,#3b82f6,#0ea5e9);box-shadow:0 4px 14px rgba(59,130,246,.28);flex:0 0 auto}',
      '.atr-brand-text h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}',
      '.atr-brand-text p{margin:2px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.atr-head-right{margin-left:auto;display:flex;align-items:center;gap:10px}',
      '.atr-seg{display:flex;gap:2px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:2px}',
      '.atr-seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:5px 12px;border-radius:7px;cursor:pointer;transition:background .12s,color .12s}',
      '.atr-seg button:hover{color:var(--dsw-alias-label-primary)}',
      '.atr-seg button.on{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px rgba(0,0,0,.14)}',
      '.atr-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.atr-pill-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.atr-pill-running{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1))}',
      '.atr-pill-running .atr-pill-dot{background:var(--dsw-alias-state-warn-primary);animation:atr-pulse 1.4s ease-in-out infinite}',
      '.atr-pill-done{color:var(--dsw-alias-state-success-primary)}',
      '.atr-pill-done .atr-pill-dot{background:var(--dsw-alias-state-success-primary)}',
      '.atr-pill-error{color:var(--dsw-alias-state-error-primary)}',
      '.atr-pill-error .atr-pill-dot{background:var(--dsw-alias-state-error-primary)}',
      '.atr-notice{margin:10px 20px 0;padding:8px 12px;border-radius:9px;font-size:12.5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.atr-notice-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dsw-alias-border-l1))}',
      '.atr-notice-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,var(--dsw-alias-border-l1))}',
      '.atr-notice-success{color:var(--dsw-alias-state-success-primary)}',
      '.atr-body{flex:1;min-height:0;display:flex}',
      '.atr-left{width:236px;flex:0 0 236px;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.atr-side-head{display:flex;align-items:center;justify-content:space-between;padding:13px 15px 7px;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.atr-side-count{font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:1px 7px;font-size:10.5px}',
      '.atr-members{flex:1;min-height:0;overflow:auto;padding:2px 8px 8px}',
      '.atr-member{display:flex;align-items:center;gap:10px;width:100%;padding:8px;border-radius:9px;border:1px solid transparent;background:transparent;cursor:pointer;text-align:left;font:inherit;color:inherit;transition:background .12s,border-color .12s}',
      '.atr-member:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.atr-member.on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent)}',
      '.atr-member.off{opacity:.5}',
      '.atr-member-text{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.atr-member-name{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.atr-member-role{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.atr-left-foot{margin-top:auto;border-top:1px solid var(--dsw-alias-border-l1);padding:10px 14px;display:flex;flex-direction:column;gap:6px}',
      '.atr-left-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.atr-link{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11.5px;padding:2px;cursor:pointer;align-self:flex-start}',
      '.atr-link:hover{text-decoration:underline}',
      '.atr-live-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);animation:atr-pulse 1.2s ease-in-out infinite;flex:0 0 auto}',
      '.atr-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}',
      '.atr-mission{margin:12px 20px 2px;padding:11px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);flex:0 0 auto}',
      '.atr-mission-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:8px;flex-wrap:wrap}',
      '.atr-mission-label{font-size:11.5px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary)}',
      '.atr-mission-meta{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.atr-mission-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.atr-mission-input{flex:1 1 220px;width:auto;min-width:180px}',
      '.atr-mission-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.atr-mission-foot>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.atr-input,.atr-select,.atr-textarea{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:7px 9px;outline:none;transition:border-color .12s}',
      '.atr-input::placeholder,.atr-textarea::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}',
      '.atr-input:focus,.atr-select:focus,.atr-textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.atr-textarea{resize:vertical;min-height:76px;line-height:1.5}',
      '.atr-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;border-radius:8px;font:inherit;font-size:12.5px;font-weight:500;padding:7px 13px;cursor:pointer;white-space:nowrap;transition:filter .12s,background .12s,color .12s}',
      '.atr-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.atr-btn-primary{background:var(--dsw-alias-brand-primary);color:#fff}',
      '.atr-btn-primary:hover:not(:disabled){filter:brightness(1.08)}',
      '.atr-btn-ghost{background:transparent;border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.atr-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.atr-btn-danger{background:transparent;border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.atr-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
      '.atr-btn-block{width:100%;justify-content:center;margin-top:10px}',
      '.atr-chat{flex:1;min-height:0;overflow:auto;padding:4px 0 14px;scroll-behavior:smooth}',
      '.atr-chat::-webkit-scrollbar,.atr-members::-webkit-scrollbar,.atr-right::-webkit-scrollbar,.atr-settings::-webkit-scrollbar{width:8px}',
      '.atr-chat::-webkit-scrollbar-thumb,.atr-members::-webkit-scrollbar-thumb,.atr-right::-webkit-scrollbar-thumb,.atr-settings::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l1);border-radius:4px}',
      '.atr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;height:100%;min-height:280px;padding:24px 20px;gap:8px}',
      '.atr-empty-art{display:flex;align-items:center;justify-content:center;width:86px;height:86px;border-radius:24px;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent);margin-bottom:6px}',
      '.atr-empty h2{margin:0;font-size:16px;font-weight:600}',
      '.atr-empty p{margin:0;max-width:430px;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.atr-examples{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:14px;max-width:560px}',
      '.atr-example{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:6px 12px;font:inherit;font-size:11.5px;cursor:pointer;max-width:100%;text-align:left;transition:border-color .12s,color .12s}',
      '.atr-example:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.atr-round{display:flex;align-items:center;gap:10px;padding:14px 20px 4px;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.atr-round:before,.atr-round:after{content:"";height:1px;background:var(--dsw-alias-border-l1);flex:1}',
      '.atr-sys{display:flex;align-items:center;justify-content:center;gap:8px;padding:12px 20px 2px;font-size:11px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.atr-sys em{font-style:normal;opacity:.7}',
      '.atr-msg{display:flex;align-items:flex-start;gap:10px;padding:8px 20px}',
      '.atr-msg-user{flex-direction:row-reverse}',
      '.atr-msg-body{min-width:0;max-width:min(740px,86%);display:flex;flex-direction:column;gap:4px}',
      '.atr-msg-head{display:flex;align-items:baseline;gap:7px;font-size:11px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}',
      '.atr-msg-head-user{justify-content:flex-end}',
      '.atr-msg-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.atr-msg-role{font-size:10.5px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}',
      '.atr-msg-time{margin-left:2px;font-variant-numeric:tabular-nums;opacity:.8}',
      '.atr-badge{font-size:10px;padding:1px 6px;border-radius:999px;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent)}',
      '.atr-bubble{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.65;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:4px 12px 12px 12px;padding:10px 13px}',
      '.atr-bubble-user{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,var(--dsw-alias-border-l1));border-radius:12px 4px 12px 12px}',
      '.atr-msg-summary .atr-bubble{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1));box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent) inset}',
      '.atr-reasoning{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.atr-reasoning summary{cursor:pointer;user-select:none}',
      '.atr-reasoning-body{white-space:pre-wrap;margin-top:5px;padding:8px 10px;border-left:2px solid var(--dsw-alias-border-l2);line-height:1.55;font-size:11.5px}',
      '.atr-cursor{display:inline-block;width:2px;height:1em;margin-left:2px;vertical-align:text-bottom;background:var(--dsw-alias-brand-primary);animation:atr-blink 1s steps(2,start) infinite}',
      '.atr-thinking{color:var(--dsw-alias-label-secondary);font-size:12.5px}',
      '.atr-thinking i{font-style:normal;animation:atr-blink 1.2s infinite}',
      '.atr-thinking i:nth-child(2){animation-delay:.2s}',
      '.atr-thinking i:nth-child(3){animation-delay:.4s}',
      '.atr-msg-error{margin-top:2px;font-size:11.5px;color:var(--dsw-alias-state-error-primary);line-height:1.5}',
      '.atr-run-error{margin:12px 20px;padding:9px 12px;border-radius:9px;font-size:12px;color:var(--dsw-alias-state-error-primary);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}',
      '.atr-composer{flex:0 0 auto;padding:8px 20px 14px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.atr-compose-box{display:flex;align-items:flex-end;gap:8px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);transition:border-color .12s}',
      '.atr-compose-box:focus-within{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1))}',
      '.atr-compose-disabled{opacity:.72}',
      '.atr-compose-box textarea{flex:1;min-width:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.5;padding:4px 2px;resize:none;outline:none;max-height:110px}',
      '.atr-send{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;border:0;background:var(--dsw-alias-brand-primary);color:#fff;cursor:pointer;flex:0 0 auto}',
      '.atr-send:disabled{opacity:.35;cursor:not-allowed}',
      '.atr-compose-hint{margin-top:5px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.atr-right{width:268px;flex:0 0 268px;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow:auto}',
      '.atr-side-sec{padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.atr-sec-title{display:flex;align-items:center;justify-content:space-between;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin-bottom:9px}',
      '.atr-sec-close{font-size:10.5px}',
      '.atr-detail-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}',
      '.atr-detail-name{font-size:13px;font-weight:600}',
      '.atr-detail-role{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.atr-kv{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:3px 0;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.atr-kv>span:last-child{color:var(--dsw-alias-label-primary);text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.atr-kv-agent{display:inline-flex;align-items:center;gap:5px}',
      '.atr-persona{margin-top:9px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary);max-height:120px;overflow:auto;white-space:pre-wrap}',
      '.atr-stat{margin-bottom:9px}',
      '.atr-stat-head{display:flex;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px}',
      '.atr-stat-head>span:last-child{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.atr-bar{height:5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.atr-bar>i{display:block;height:100%;border-radius:3px;transition:width .3s ease}',
      '.atr-avatar{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:#fff;flex:0 0 auto;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);line-height:1;user-select:none}',
      '.atr-settings{flex:1;min-height:0;overflow:auto;padding:16px 22px 4px}',
      '.atr-set-team{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px}',
      '.atr-set-title{font-size:12.5px;font-weight:600;margin-bottom:10px}',
      '.atr-set-grid{display:grid;grid-template-columns:2fr 1fr;gap:12px}',
      '.atr-agent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:14px;margin-top:14px}',
      '.atr-agent-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:13px;display:flex;flex-direction:column;gap:9px}',
      '.atr-agent-off{opacity:.62}',
      '.atr-ac-head{display:flex;align-items:center;gap:8px}',
      '.atr-ac-name{font-weight:600;flex:1;min-width:0}',
      '.atr-ac-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.atr-label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.atr-colors{display:flex;gap:6px;flex-wrap:wrap}',
      '.atr-color{width:18px;height:18px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}',
      '.atr-color.on{border-color:var(--dsw-alias-label-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}',
      '.atr-range{width:100%;accent-color:var(--dsw-alias-brand-primary)}',
      '.atr-switch{position:relative;display:inline-flex;width:32px;height:18px;flex:0 0 auto;cursor:pointer}',
      '.atr-switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}',
      '.atr-switch i{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);transition:background .14s,border-color .14s}',
      '.atr-switch i:after{content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:left .14s,background .14s}',
      '.atr-switch input:checked+i{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-brand-primary)}',
      '.atr-switch input:checked+i:after{left:16px;background:var(--dsw-alias-brand-primary)}',
      '.atr-switch input:focus-visible+i{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.atr-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto}',
      '.atr-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l1)}',
      '.atr-icon-btn:disabled{opacity:.35;cursor:not-allowed}',
      '.atr-add-agent{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;min-height:150px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer;transition:border-color .12s,color .12s}',
      '.atr-add-agent:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.atr-savebar{position:sticky;bottom:0;display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:12px 0 14px;margin-top:8px;background:linear-gradient(0deg,var(--dsw-alias-bg-base) 62%,transparent)}',
      '.atr-save-hint{margin-right:auto;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.atr-loading{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.atr-spinner{width:18px;height:18px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);animation:atr-spin .8s linear infinite}',
      '.atr-spinner-sm{width:12px;height:12px;border-width:1.5px}',
      '.atr-mission-topline{display:flex;align-items:center;gap:9px;min-width:0}',
      '.atr-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;white-space:nowrap;transition:color .12s,border-color .12s,background .12s}',
      '.atr-chip:hover{color:var(--dsw-alias-label-primary)}',
      '.atr-chip.on{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,var(--dsw-alias-bg-layer-2))}',
      '.atr-chip input{appearance:none;-webkit-appearance:none;width:11px;height:11px;margin:0;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;flex:0 0 auto}',
      '.atr-chip input:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 2.5px var(--dsw-alias-bg-layer-2)}',
      '.atr-chip input:disabled{cursor:not-allowed;opacity:.5}',
      '.atr-plan-msg{margin:10px 20px;padding:11px 13px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,var(--dsw-alias-border-l1));border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-1))}',
      '.atr-plan-head{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}',
      '.atr-plan-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);white-space:nowrap}',
      '.atr-plan-sub{letter-spacing:.04em}',
      '.atr-plan-head .atr-msg-time{margin-left:auto}',
      '.atr-plan-body{white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.65}',
      '.atr-plan-rationale{margin:0 0 10px;padding:9px 11px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary)}',
      '.atr-plan-inline{margin:8px 20px 2px;padding:11px 13px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,var(--dsw-alias-border-l1));border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1));flex:0 0 auto;max-height:190px;overflow:auto}',
      '.atr-plan-inline-head{display:flex;align-items:center;gap:8px;margin-bottom:7px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.atr-plan-inline-title{letter-spacing:.04em}',
      '.atr-plan-inline-head .atr-icon-btn{margin-left:auto;width:22px;height:22px}',
      '.atr-plan-loading{display:flex;align-items:center;gap:8px;padding:2px 0 4px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.atr-plan-error{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.atr-plan-chiprow{display:flex;flex-wrap:wrap;gap:6px}',
      '.atr-plan-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:3px 8px 3px 4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:11px}',
      '.atr-plan-chipname{font-weight:600;font-size:11.5px}',
      '.atr-plan-chiprole{color:var(--dsw-alias-label-secondary);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}',
      '.atr-plan-inline-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:9px;flex-wrap:wrap}',
      '.atr-plan-mission{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.atr-plan-inline-actions{display:flex;gap:8px;margin-left:auto}',
      '.atr-verdict{margin:8px 20px;padding:10px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}',
      '.atr-verdict.is-delivered{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,var(--dsw-alias-bg-layer-1))}',
      '.atr-verdict-head{display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.atr-verdict-state{margin-left:auto;font-weight:600}',
      '.atr-verdict.is-delivered .atr-verdict-state{color:var(--dsw-alias-state-success-primary)}',
      '.atr-pill-delivered{color:var(--dsw-alias-state-success-primary)}',
      '.atr-pill-delivered .atr-pill-dot{background:var(--dsw-alias-state-success-primary)}',
      '.atr-set-toggle{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:12px;padding-top:11px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.atr-set-toggle-text{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.atr-set-toggle-text b{font-size:12px;font-weight:600}',
      '.atr-set-toggle-text span{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);max-width:520px}',
      '@keyframes atr-spin{to{transform:rotate(360deg)}}',
      '@keyframes atr-blink{50%{opacity:0}}',
      '@keyframes atr-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      '@media (max-width:1180px){.atr-right{display:none}}',
      '@media (max-width:900px){.atr-left{display:none}.atr-set-grid{grid-template-columns:1fr 1fr}}',
      '@media (max-width:680px){.atr-set-grid{grid-template-columns:1fr}.atr-brand-text p{display:none}}',
    ].join('\n')

    // ───────────────────────── registration ─────────────────────────
    function SidebarIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 20
      return h(
        'span',
        {
          className: 'atr-side-ico' + (props && props.active ? ' active' : ''),
          style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'currentColor' },
        },
        h(TeamMark, { size: size }),
      )
    }

    function apply(ctx) {
      ctxRef = ctx
      try {
        ctx.effect(function () {
          if (!ctx.locale) return
          return ctx.locale.subscribe(function () {
            emit()
          })
        })
      } catch (error) {
        /* locale is optional */
      }
      try {
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'agent-team-room',
              order: 12,
              label: function () {
                return T('智能体团队', 'Agent Team')
              },
            },
            function (props) {
              return h(SidebarIcon, props)
            },
          )
        })
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: 'agent-team-room' }, function () {
            return h(Boundary, null, h(Page))
          })
        })
        console.log('[agent-team-room] client ready: sidebar panel + team page')
      } catch (error) {
        console.error('[agent-team-room] slot registration failed', error)
      }
    }

    return { inject: ['slots'], apply: apply }
  },
})
