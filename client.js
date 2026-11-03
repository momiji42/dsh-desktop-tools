// Client half of dsh-desktop-tools.
//
// Plain hand-written bundle, exactly like the ones DSH ships: no build step, no
// import/export keywords, no JSX. The page loads it as a script, the module
// loader below hands it a `require`, and the modules it may ask for are React
// plus the injected Harness Client packages (the Switch primitive comes from
// `@deepseek-ai/dsh-client-ui-primitives`, declared under `dsh.client.inject`).
//
// Two features, one module:
//
//   1. A **Restart** button appended to the Windows title-bar menu bar. That bar
//      is shadow DOM mounted by the desktop preload (`[data-windows-menu]`), and
//      the popup menus it opens are a native Electron menu this plugin cannot
//      extend - it runs in the Host child process, not in the Electron main
//      process. Appending one more button to the same bar gives the restart the
//      same chrome and weight as the app-level menus without touching app.asar.
//   2. A **Start with Windows** row in Settings → General, driving the Host's
//      HKCU Run routes.
//
// The factory id below must equal the package name: the page requests a bundle
// by package name and executes it, so a different id makes the bundle run twice
// and the duplicate factory registration takes the whole web boot down.

window.__ModuleLoader__.load({
  id: 'dsh-desktop-tools',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const NS = 'dsh-desktop-tools'
    const STATUS_ROUTE = '/api/dsh-desktop-tools/status'
    const RESTART_ROUTE = '/api/dsh-desktop-tools/restart'
    const AUTOSTART_ROUTE = '/api/dsh-desktop-tools/autostart'
    const JSON_HEADERS = { 'content-type': 'application/json' }

    /** Bilingual copy. Registered on the locale service so it follows the UI language. */
    const zh = {
      'restart.label': '重启',
      'restart.title': '重启应用',
      'restart.aria': '重启 DeepSeek Harness',
      'restart.confirm': '重启 DeepSeek Harness？\n\n正在执行的任务会被打断；应用退出后会自动重新启动。',
      'restart.progress': '正在重启…',
      'restart.unavailable': '暂时无法重启：',
      'restart.failed': '重启失败：',
      'autostart.title': '开机自启',
      'autostart.description': '登录 Windows 后自动启动 DSH。',
      'autostart.unsupported': '当前环境无法管理 Windows 启动项。',
      'autostart.failed': '操作失败，请重试。',
    }

    const en = {
      'restart.label': 'Restart',
      'restart.title': 'Restart the app',
      'restart.aria': 'Restart DeepSeek Harness',
      'restart.confirm': 'Restart DeepSeek Harness?\n\nTasks that are running will be interrupted. The app will start again on its own.',
      'restart.progress': 'Restarting…',
      'restart.unavailable': 'Cannot restart right now: ',
      'restart.failed': 'Restart failed: ',
      'autostart.title': 'Start with Windows',
      'autostart.description': 'Launch DSH automatically after you sign in to Windows.',
      'autostart.unsupported': 'This environment cannot manage Windows startup entries.',
      'autostart.failed': 'The change failed. Try again.',
    }

    /**
     * The translator the two features share.
     *
     * It is rebound when the locale preference changes; the fallback is Chinese
     * first because that is the language this bundle was written for, and a
     * locale service that is missing must not leave raw keys on screen.
     */
    let translate = (key) => zh[key] ?? key

    const makeTranslator = (locale) => {
      let bound = null
      const refresh = () => {
        bound = locale !== undefined && locale !== null && typeof locale.bind === 'function' ? locale.bind(NS) : null
      }
      refresh()
      return {
        refresh,
        t(key) {
          const value = bound === null ? undefined : bound(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
          return zh[key] ?? en[key] ?? key
        },
      }
    }

    /**
     * Read the combined status payload.
     *
     * @returns the payload, or null when the Host route is not answering.
     */
    async function readStatus() {
      try {
        const response = await fetch(STATUS_ROUTE, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        if (!response.ok) return null
        return await response.json()
      } catch {
        return null
      }
    }

    /**
     * Mount a small "restart" button beside the native 应用 / 编辑 caption menus.
     *
     * @returns a disposer that removes the button and stops the polling.
     */
    const installCaptionButton = () => {
      const BUTTON_ID = 'dsh-desktop-tools-restart-caption'
      let poll = 0
      let timer = 0
      let attempts = 0
      let disposed = false

      const label = () => translate('restart.label')

      const restart = async (button) => {
        const status = await readStatus()
        const restartStatus = status === null ? null : status.restart
        if (restartStatus === null || restartStatus === undefined || restartStatus.ready !== true) {
          const reason = restartStatus === null || restartStatus === undefined
            ? STATUS_ROUTE
            : String(restartStatus.detail ?? restartStatus.reason ?? '')
          window.alert(translate('restart.unavailable') + reason)
          return
        }
        if (!window.confirm(translate('restart.confirm'))) return

        button.textContent = translate('restart.progress')
        button.disabled = true
        try {
          const response = await fetch(RESTART_ROUTE, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: '{}',
          })
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}))
            throw new Error(payload.error ?? String(response.status))
          }
          const beforeBoot = typeof status.bootId === 'string' ? status.bootId : null
          let attempts = 0
          let sawDown = false
          const tick = async () => {
            if (disposed) return
            attempts += 1
            const next = await readStatus()
            if (next !== null) {
              const id = next.bootId
              const replaced = beforeBoot === null ? sawDown : typeof id === 'string' && id !== beforeBoot
              if (replaced) {
                window.location.reload()
                return
              }
            } else {
              sawDown = true
            }
            if (attempts >= 90) {
              button.textContent = label()
              button.disabled = false
              return
            }
            timer = window.setTimeout(tick, 700)
          }
          timer = window.setTimeout(tick, 700)
        } catch (error) {
          button.textContent = label()
          button.disabled = false
          window.alert(translate('restart.failed') + String(error instanceof Error ? error.message : error))
        }
      }

      const mount = () => {
        if (disposed) return false
        attempts += 1
        const host = document.querySelector('[data-windows-menu]')
        if (host === null || host === undefined) {
          // A desktop build without the preload's menu bar never grows one; poll
          // for a while, then stop quietly instead of ticking forever.
          if (attempts > 120) {
            window.clearInterval(poll)
            poll = 0
            console.warn('dsh-desktop-tools: [data-windows-menu] not found; the title-bar Restart button stays unavailable')
          }
          return false
        }
        const shadow = host.shadowRoot
        const bar = shadow === null ? null : shadow.querySelector('[role="menubar"]')
        if (bar === null) {
          if (attempts > 120) {
            window.clearInterval(poll)
            poll = 0
            console.warn('dsh-desktop-tools: title-bar menubar not found; the Restart button stays unavailable')
          }
          return false
        }
        if (poll !== 0) {
          window.clearInterval(poll)
          poll = 0
        }
        if (bar.querySelector('#' + BUTTON_ID) !== null) return true
        const button = document.createElement('button')
        button.type = 'button'
        button.id = BUTTON_ID
        button.setAttribute('role', 'menuitem')
        button.tabIndex = -1
        button.textContent = label()
        button.title = translate('restart.title')
        button.setAttribute('aria-label', translate('restart.aria'))
        button.addEventListener('click', () => {
          void restart(button)
        })
        bar.append(button)
        return true
      }

      if (mount() !== true) poll = window.setInterval(mount, 700)
      return () => {
        disposed = true
        if (poll !== 0) window.clearInterval(poll)
        if (timer !== 0) window.clearTimeout(timer)
        const host = document.querySelector('[data-windows-menu]')
        const shadow = host === null || host === undefined ? null : host.shadowRoot
        const button = shadow === null ? null : shadow.querySelector('#' + BUTTON_ID)
        if (button !== null) button.remove()
      }
    }

    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '10px 0',
    }
    const TEXT_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }
    const TITLE_STYLE = { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '1.45' }
    const DESCRIPTION_STYLE = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '1.5' }

    /**
     * The single preference row in Settings → General: label, hint, host Switch.
     */
    function AutostartRow() {
      const [state, setState] = React.useState({
        loading: true,
        supported: true,
        enabled: false,
        error: null,
      })
      const [busy, setBusy] = React.useState(false)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        readStatus()
          .then((payload) => {
            if (!alive.current) return
            if (payload === null) {
              setState({ loading: false, supported: true, enabled: false, error: STATUS_ROUTE })
              return
            }
            const autostart = payload.autostart ?? {}
            setState({
              loading: false,
              supported: autostart.supported !== false,
              enabled: Boolean(autostart.enabled),
              error: typeof autostart.error === 'string' ? autostart.error : null,
            })
          })
          .catch((error) => {
            if (!alive.current) return
            setState({ loading: false, supported: true, enabled: false, error: String(error?.message ?? error) })
          })
        return () => {
          alive.current = false
        }
      }, [])

      const change = (next) => {
        if (busy) return
        setBusy(true)
        setState((previous) => ({ ...previous, enabled: next, error: null }))
        fetch(AUTOSTART_ROUTE, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ enabled: next }),
        })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`)
            return body
          })
          .then((body) => {
            if (!alive.current) return
            setState({
              loading: false,
              supported: body.supported !== false,
              enabled: Boolean(body.enabled),
              error: typeof body.error === 'string' ? body.error : null,
            })
          })
          .catch((error) => {
            if (!alive.current) return
            setState((previous) => ({ ...previous, enabled: !next, error: String(error?.message ?? error) }))
          })
          .finally(() => {
            if (alive.current) setBusy(false)
          })
      }

      const description = state.supported === false
        ? translate('autostart.unsupported')
        : state.error ?? translate('autostart.description')

      return h(
        'div',
        { style: ROW_STYLE },
        h(
          'div',
          { style: TEXT_STYLE },
          h('div', { style: TITLE_STYLE }, translate('autostart.title')),
          h('div', { style: DESCRIPTION_STYLE, title: description }, description),
        ),
        h(primitives.Switch, {
          checked: state.enabled,
          disabled: busy || state.loading || state.supported === false,
          label: translate('autostart.title'),
          onChange: change,
        }),
      )
    }

    function apply(ctx) {
      const translator = makeTranslator(ctx.locale)
      translate = translator.t
      ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'dsh-desktop-tools: zh dictionary')
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'dsh-desktop-tools: en dictionary')
      const unsubscribe = typeof ctx.locale.subscribe === 'function'
        ? ctx.locale.subscribe(() => translator.refresh())
        : undefined
      if (typeof unsubscribe === 'function') ctx.effect(() => unsubscribe, 'dsh-desktop-tools: locale subscription')

      ctx.effect(() => installCaptionButton(), 'dsh-desktop-tools: caption button')

      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register({ name: 'settings.general.item', id: 'dsh-autostart', order: 45 }, AutostartRow),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
