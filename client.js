/**
 * dsh-power-meter — browser half.
 *
 * Renders one ambient row under the composer: total wall energy the machine
 * has drawn, how long it has been up, and the average power of the last hour.
 * Clicking the row expands the readings the host derives from the SMC power
 * telemetry counters.
 *
 * All numbers come from the host half's `/api/power-meter` route; this file
 * only formats them with the host theme and locale.
 */

window.__ModuleLoader__.load({
  id: 'dsh-power-meter',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'power-meter'
    /** Route served by the host half. */
    const ENDPOINT = '/api/power-meter'
    /** Fallback refresh cadence; the host reports its own interval. */
    /** Fallback only used before the first host payload arrives. */
    const DEFAULT_INTERVAL_MS = 300_000

    /** Preset observation windows, in minutes (5m … 6h). */
    const WINDOW_STEPS = [5, 15, 30, 60, 120, 240, 360]
    const MIN_WINDOW_MINUTES = 5
    const MAX_WINDOW_MINUTES = 360

    const zh = {
      'label.energy': '总耗电',
      'label.energyShort': '耗电',
      'label.railTitle': '总耗电 {energy} · 已开机 {uptime} · 近{window} {power}',
      'label.uptime': '已开机',
      'label.hour': '近1小时',
      'label.hourPartial': '近 {window}',
      'label.window': '近{window}',
      'label.windowShort': '近 1 小时',
      'label.hourShort': '近1h',
      'title': '整机电源遥测',
      'open': '展开电源详情',
      'close': '收起电源详情',
      'loading': '正在读取电源遥测…',
      'unavailable': '暂时读不到电源遥测',
      'unsupported': '当前系统不提供这组电源遥测数据',
      'refresh': '立即刷新',
      'refreshing': '正在刷新…',
      'updated': '更新于 {time}',
      'panel.energy': '墙端累计耗电',
      'panel.energyHint': '固件估算，含适配器损耗',
      'panel.system': '主机内部消耗',
      'panel.loss': '适配器损耗',
      'panel.efficiency': '适配器效率',
      'panel.window': '{window}平均功率',
      'panel.windowSpan': '实际统计 {window}',
      'panel.windowPick': '统计窗口',
      'panel.load': '系统负载',
      'panel.loadHint': 'PSTR 实测',
      'panel.instantSmc': 'PDTR 实测 · DC in',
      'panel.instantFallback': '回退到 ioreg 快照',
      'panel.lossHint': '固件模型常数',
      'panel.hourWindow': '统计窗口 {window}',
      'panel.hourShort': '样本不足 10 分钟，暂不给平均',
      'panel.last': '最近一次采样间隔',
      'panel.series': '各采样间隔的平均功率',
      'panel.sinceBoot': '自开机以来平均功率',
      'panel.sampleMean': '近 1 小时瞬时均值',
      'panel.sampleMeanHint': '{count} 个瞬时读数',
      'panel.instant': '瞬时功率',
      'panel.voltage': '输入电压',
      'panel.current': '输入电流',
      'panel.boot': '开机时间',
      'panel.uptime': '运行时长',
      'panel.interval': '采样间隔',
      'panel.samples': '保留样本',
      'panel.model': '机型',
      'panel.source': '数据来源：macOS SMC 电源遥测（AppleSmartBattery / PowerTelemetryData），由 DSH 主进程采样。',
      'unit.day': '天',
      'unit.hour': '小时',
      'unit.minute': '分',
      'unknown': '—',
    }

    const en = {
      'label.energy': 'Drawn',
      'label.energyShort': 'Drawn',
      'label.railTitle': 'Drawn {energy} · up {uptime} · last {window} {power}',
      'label.uptime': 'Uptime',
      'label.hour': 'Last 1h',
      'label.hourPartial': 'Last {window}',
      'label.window': '{window} avg',
      'label.windowShort': 'last 1h',
      'label.hourShort': '1h',
      'title': 'Machine power telemetry',
      'open': 'Show power details',
      'close': 'Hide power details',
      'loading': 'Reading power telemetry…',
      'unavailable': 'Power telemetry is unavailable',
      'unsupported': 'This system exposes no power telemetry',
      'refresh': 'Refresh now',
      'refreshing': 'Refreshing…',
      'updated': 'Updated {time}',
      'panel.energy': 'Wall energy (cumulative)',
      'panel.energyHint': 'firmware estimate, adapter losses included',
      'panel.system': 'Machine internal draw',
      'panel.loss': 'Adapter loss',
      'panel.efficiency': 'Adapter efficiency',
      'panel.window': 'Average power, {window}',
      'panel.windowSpan': 'measured over {window}',
      'panel.windowPick': 'Window',
      'panel.load': 'System load',
      'panel.loadHint': 'PSTR measured',
      'panel.instantSmc': 'PDTR measured · DC in',
      'panel.instantFallback': 'fell back to ioreg snapshot',
      'panel.lossHint': 'firmware model constant',
      'panel.hourWindow': 'Window {window}',
      'panel.hourShort': 'Under 10 minutes of samples; no average yet',
      'panel.last': 'Latest sample interval',
      'panel.series': 'Average power per sample interval',
      'panel.sinceBoot': 'Average since boot',
      'panel.sampleMean': 'Instantaneous mean, last hour',
      'panel.sampleMeanHint': '{count} readings',
      'panel.instant': 'Instantaneous power',
      'panel.voltage': 'Input voltage',
      'panel.current': 'Input current',
      'panel.boot': 'Boot time',
      'panel.uptime': 'Uptime',
      'panel.interval': 'Sample interval',
      'panel.samples': 'Samples kept',
      'panel.model': 'Model',
      'panel.source': 'Source: macOS SMC power telemetry (AppleSmartBattery / PowerTelemetryData), sampled by the DSH host process.',
      'unit.day': 'd',
      'unit.hour': 'h',
      'unit.minute': 'm',
      'unknown': '—',
    }

    /** Header pill and detail popover; every color is a host theme token. */
    const CSS = `
.dsh-pm-pill {
  box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; flex: none;
  height: 24px; padding: 0 9px; margin: 0; font: inherit; font-size: 11.5px; line-height: 1;
  white-space: nowrap; font-variant-numeric: tabular-nums; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  transition: border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out),
    color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out),
    background-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out);
}
.dsh-pm-pill:hover { border-color: var(--dsw-alias-label-secondary); color: var(--dsw-alias-label-primary); }
.dsh-pm-pill[aria-expanded="true"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-pm-pill:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-pm-bolt { width: 12px; height: 12px; flex: none; color: var(--dsw-alias-brand-primary); }
.dsh-pm-num { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsh-pm-sep { color: var(--dsw-alias-label-secondary); opacity: .4; }
.dsh-pm-flat { color: var(--dsw-alias-label-secondary); }
@media (max-width: 1180px) { .dsh-pm-uptime { display: none; } .dsh-pm-uptime-sep { display: none; } }

.dsh-pm-mask { position: fixed; inset: 0; z-index: 900; background: transparent; }
.dsh-pm-pop {
  position: fixed; z-index: 901; box-sizing: border-box; width: min(320px, calc(100vw - 16px));
  display: flex; flex-direction: column; gap: 9px; padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-overlay); box-shadow: var(--dsw-elevation-prominent, 0 8px 24px #0003);
  color: var(--dsw-alias-label-primary);
}
.dsh-pm-head { display: flex; align-items: center; gap: 8px; }
.dsh-pm-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-pm-refresh {
  margin-left: auto; font: inherit; font-size: 11px; cursor: pointer; padding: 1px 9px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
}
.dsh-pm-refresh:hover:enabled { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-secondary); }
.dsh-pm-refresh:disabled { opacity: .55; cursor: default; }
.dsh-pm-window { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.dsh-pm-window-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dsh-pm-window-label { font-size: 11px; opacity: 0.62; }
.dsh-pm-window-value { font-size: 11px; font-variant-numeric: tabular-nums; opacity: 0.9; }
.dsh-pm-steps { display: flex; flex-wrap: wrap; gap: 4px; }
.dsh-pm-step {
  padding: 2px 7px; font: inherit; font-size: 11px; line-height: 1.5; cursor: pointer;
  color: inherit; background: transparent; border: 1px solid rgba(127, 127, 127, 0.34);
  border-radius: 999px; font-variant-numeric: tabular-nums;
}
.dsh-pm-step:hover:not(:disabled) { border-color: rgba(127, 127, 127, 0.62); }
.dsh-pm-step-on { border-color: currentColor; font-weight: 600; }
.dsh-pm-step:disabled { cursor: default; opacity: 0.5; }
.dsh-pm-slider { width: 100%; margin: 0; accent-color: currentColor; height: 16px; cursor: pointer; }
.dsh-pm-slider:disabled { cursor: default; opacity: 0.5; }
.dsh-pm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
.dsh-pm-stat { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dsh-pm-stat-label { font-size: 10.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-pm-stat-value { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dsh-pm-stat-hint { font-size: 10px; color: var(--dsw-alias-label-secondary); opacity: .85; }
.dsh-pm-spark {
  width: 100%; height: 34px; display: block; border-radius: 6px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent);
}
.dsh-pm-note { margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsh-pm-source { margin: 0; font-size: 10px; line-height: 1.5; color: var(--dsw-alias-label-secondary); opacity: .75; }
`

    /**
     * Fill `{name}` placeholders.
     * @param template - text with placeholders.
     * @param values - replacement values.
     * @returns the filled text.
     */
    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (whole, key) =>
        key in values ? String(values[key]) : whole,
      )
    }

    /**
     * Format watt-hours, switching to kWh once the number gets long.
     * @param wh - watt-hours.
     * @returns text such as `1043.6 Wh`.
     */
    function formatEnergy(wh) {
      if (!Number.isFinite(wh)) return '—'
      if (wh >= 1000) return `${(wh / 1000).toFixed(2)} kWh`
      if (wh >= 10) return `${wh.toFixed(1)} Wh`
      return `${wh.toFixed(2)} Wh`
    }

    /**
     * Format a power reading.
     * @param watts - watts.
     * @param digits - decimals to keep.
     * @returns text such as `3.09 W`.
     */
    function formatPower(watts, digits = 2) {
      if (!Number.isFinite(watts)) return '—'
      if (Math.abs(watts) >= 100) return `${watts.toFixed(0)} W`
      return `${watts.toFixed(digits)} W`
    }

    /**
     * Format a duration as days/hours/minutes.
     * @param seconds - duration.
     * @param t - translate function.
     * @returns text such as `38 天 20 小时`.
     */
    function formatUptime(seconds, t) {
      if (!Number.isFinite(seconds) || seconds < 0) return '—'
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      const parts = []
      if (days > 0) parts.push(`${days} ${t('unit.day')}`)
      if (days > 0 || hours > 0) parts.push(`${hours} ${t('unit.hour')}`)
      if (days === 0) parts.push(`${minutes} ${t('unit.minute')}`)
      return parts.join(' ')
    }

    /**
     * Compact uptime for the header pill: `38d 20h` / `5h 12m` / `12m`.
     * @param seconds - duration.
     * @param t - translate function.
     * @returns a space-free short form.
     */
    function formatUptimeShort(seconds, t) {
      if (!Number.isFinite(seconds) || seconds < 0) return '—'
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      if (days > 0) return `${days}${t('unit.day')} ${hours}${t('unit.hour')}`
      if (hours > 0) return `${hours}${t('unit.hour')} ${minutes}${t('unit.minute')}`
      return `${minutes}${t('unit.minute')}`
    }

    /**
     * Format a short duration for a statistics window.
     * @param seconds - duration.
     * @param t - translate function.
     * @returns text such as `1 小时` or `42 分`.
     */
    function formatWindow(seconds, t) {
      if (!Number.isFinite(seconds)) return '—'
      if (seconds >= 5400) return `${Math.round(seconds / 3600)} ${t('unit.hour')}`
      if (seconds >= 3600) return `1 ${t('unit.hour')}`
      return `${Math.max(1, Math.round(seconds / 60))} ${t('unit.minute')}`
    }

    /**
     * Format a clock time in the browser's zone.
     * @param epochMs - instant.
     * @returns text such as `09-15 02:41`.
     */
    function formatClock(epochMs) {
      if (!Number.isFinite(epochMs)) return '—'
      const date = new Date(epochMs)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * Shared polling store: one fetch per page, shared by every mounted row.
     * @returns the store handle used through useSyncExternalStore.
     */
    function createStore() {
      let snapshot = { kind: 'loading' }
      const listeners = new Set()
      let timer
      let inflight
      let mounts = 0
      /** Window the user picked, in minutes; undefined uses the host default. */
      let windowMinutes

      const emit = () => {
        for (const listener of listeners) {
          try {
            listener()
          } catch {
            /* a broken listener must not stop the others */
          }
        }
      }

      const intervalMs = () => {
        const seconds = snapshot.kind === 'ready' ? snapshot.data?.sampling?.intervalSeconds : undefined
        return Number.isFinite(seconds) && seconds >= 30 ? seconds * 1000 : DEFAULT_INTERVAL_MS
      }

      const arm = () => {
        if (timer !== undefined) clearTimeout(timer)
        if (mounts === 0) {
          timer = undefined
          return
        }
        // A short delay after each read keeps the schedule drifting with real
        // elapsed time instead of assuming the request itself was instant.
        timer = setTimeout(() => {
          timer = undefined
          void load(false)
        }, intervalMs())
      }

      const load = (fresh) => {
        if (inflight !== undefined) return inflight
        const query = new URLSearchParams()
        if (fresh) query.set('fresh', '1')
        if (windowMinutes !== undefined) query.set('window', String(windowMinutes))
        const suffix = query.toString()
        inflight = fetch(suffix === '' ? ENDPOINT : `${ENDPOINT}?${suffix}`, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((data) => {
            snapshot = { kind: 'ready', data, at: Date.now() }
          })
          .catch((error) => {
            if (snapshot.kind === 'ready') {
              snapshot = { ...snapshot, staleError: String(error?.message ?? error) }
            } else {
              snapshot = { kind: 'error', error: String(error?.message ?? error) }
            }
          })
          .finally(() => {
            inflight = undefined
            emit()
            arm()
          })
        emit()
        return inflight
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot() {
          return snapshot
        },
        /**
         * Count one mounted row and make sure polling runs.
         * @param initial - whether this mount should refresh immediately.
         */
        acquire(initial) {
          mounts += 1
          if (mounts === 1) void load(initial)
        },
        release() {
          mounts = Math.max(0, mounts - 1)
          if (mounts === 0) {
            if (timer !== undefined) clearTimeout(timer)
            timer = undefined
          }
        },
        refresh() {
          if (timer !== undefined) clearTimeout(timer)
          timer = undefined
          return load(true)
        },
        /**
         * Select the averaging window and re-read with it.
         * @param minutes - window in minutes, or undefined for the host default.
         */
        setWindow(minutes) {
          if (minutes === windowMinutes) return undefined
          windowMinutes = minutes
          if (timer !== undefined) clearTimeout(timer)
          timer = undefined
          return load(true)
        },
        getWindow() {
          return windowMinutes
        },
      }
    }

    /** The single polling store every mounted instance shares. */
    const sharedStore = createStore()

    /** One interval sparkline of the per-sample average power. */
    function Sparkline({ series, t }) {
      if (!Array.isArray(series) || series.length < 2) return null
      const width = 220
      const height = 34
      const values = series.map((point) => point.w)
      const max = Math.max(...values)
      const min = Math.min(...values)
      const span = max - min === 0 ? 1 : max - min
      const step = series.length > 1 ? width / (series.length - 1) : width
      const points = series.map((point, index) => {
        const x = index * step
        const y = height - ((point.w - min) / span) * (height - 6) - 3
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      const line = `M${points.join(' L')}`
      const area = `${line} L${width},${height} L0,${height} Z`
      return h(
        'svg',
        {
          className: 'dsh-pm-spark',
          viewBox: `0 0 ${width} ${height}`,
          preserveAspectRatio: 'none',
          role: 'img',
          'aria-label': t('panel.series'),
        },
        h('path', { d: area, fill: 'var(--dsw-alias-brand-primary)', opacity: 0.12 }),
        h('path', {
          d: line,
          fill: 'none',
          stroke: 'var(--dsw-alias-brand-primary)',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
          vectorEffect: 'non-scaling-stroke',
        }),
      )
    }

    /** One label/value pair in the detail grid. */
    function Stat({ label, value, hint }) {
      return h(
        'div',
        { className: 'dsh-pm-stat' },
        h('span', { className: 'dsh-pm-stat-label' }, label),
        h('span', { className: 'dsh-pm-stat-value' }, value),
        hint === undefined ? null : h('span', { className: 'dsh-pm-stat-hint' }, hint),
      )
    }

    /**
     * The dock row plus its expanded detail panel.
     * @param props - the slot passes `t` because the registration names the namespace.
     * @returns the row element tree.
     */
    /**
     * Window selector: seven presets plus a continuous slider.
     *
     * The presets give one-click access to the common spans; the slider fills
     * the gaps in between so any value from 5 minutes to 6 hours is reachable.
     */
    function WindowPicker({ value, fallback, onPick, t, disabled }) {
      const current = Number.isFinite(value) ? value : fallback
      return h(
        'div',
        { className: 'dsh-pm-window' },
        h(
          'div',
          { className: 'dsh-pm-window-head' },
          h('span', { className: 'dsh-pm-window-label' }, t('panel.windowPick')),
          h('span', { className: 'dsh-pm-window-value' }, formatWindow(current * 60, t)),
        ),
        h(
          'div',
          { className: 'dsh-pm-steps', role: 'group', 'aria-label': t('panel.windowPick') },
          ...WINDOW_STEPS.map((minutes) =>
            h(
              'button',
              {
                key: minutes,
                type: 'button',
                className: 'dsh-pm-step' + (minutes === current ? ' dsh-pm-step-on' : ''),
                'aria-pressed': minutes === current,
                disabled,
                onClick: () => onPick(minutes),
              },
              formatWindow(minutes * 60, t),
            ),
          ),
        ),
        h('input', {
          className: 'dsh-pm-slider',
          type: 'range',
          min: MIN_WINDOW_MINUTES,
          max: MAX_WINDOW_MINUTES,
          step: 5,
          value: current,
          disabled,
          'aria-label': t('panel.windowPick'),
          onInput: (event) => onPick(Number(event.target.value)),
        }),
      )
    }

    function PowerMeter(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => (zh[key] ?? key)
      // Module-level singleton: a slot that mounts once per row or per message
      // (sidebar.session.row.leading, conversation.chat.*) would otherwise give
      // every instance its own poller. The store ref-counts mounts itself.
      const store = sharedStore
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [anchor, setAnchor] = React.useState(undefined)
      const [windowMinutes, setWindowMinutes] = React.useState(() => store.getWindow())
      const buttonRef = React.useRef(null)

      React.useEffect(() => {
        store.acquire(true)
        return () => store.release()
      }, [store])

      const data = snapshot.kind === 'ready' ? snapshot.data : undefined
      const ready = data?.ok === true
      const energy = ready ? data.energy : undefined
      const boot = ready ? data.boot : undefined
      const power = ready ? data.power : undefined

      const refresh = React.useCallback(async () => {
        setBusy(true)
        try {
          await store.refresh()
        } finally {
          setBusy(false)
        }
      }, [store])

      const headline = (() => {
        if (snapshot.kind === 'loading') return t('loading')
        if (snapshot.kind === 'error') return t('unavailable')
        if (!ready) {
          return data?.reason === 'unsupported-platform' || data?.platform !== 'darwin'
            ? t('unsupported')
            : t('unavailable')
        }
        return ''
      })()

      const pickWindow = (minutes) => {
        setWindowMinutes(minutes)
        void store.setWindow(minutes)
      }
      const windowChoiceLabel = formatWindow(
        (Number.isFinite(windowMinutes) ? windowMinutes : data?.power?.windowMinutes ?? 60) * 60,
        t,
      )

      const windowLabel =
        ready && Number.isFinite(power.windowSeconds)
          ? fill(t('label.window'), { window: formatWindow(power.windowSeconds, t) })
          : t('label.windowShort')
      const energyText = ready ? formatEnergy(energy.wallWh) : t('unknown')
      const uptimeText = ready ? formatUptime(boot.uptimeSeconds, t) : t('unknown')
      const hourText = ready && Number.isFinite(power.windowW) ? formatPower(power.windowW) : t('unknown')
      const windowText = ready ? formatWindow(power.windowSeconds, t) : t('unknown')

      // Until real numbers exist, the tooltip carries the status instead of a
      // row of placeholders.
      const pillTitle =
        ready && headline === ''
          ? fill(t('label.railTitle'), {
              energy: energyText,
              uptime: uptimeText,
              window: windowText,
              power: hourText,
            })
          : headline

      const placePanel = React.useCallback(() => {
        const node = buttonRef.current
        if (node === null || node === undefined) return
        const rect = node.getBoundingClientRect()
        const width = Math.min(320, window.innerWidth - 16)
        // Right-aligned to the pill, pulled back inside the viewport.
        const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
        // The pill sits in the header, so the panel opens downward beneath it.
        const top = Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - 160))
        setAnchor({ left, top, width, maxHeight: Math.max(160, window.innerHeight - top - 12) })
      }, [])

      const close = React.useCallback(() => {
        setOpen(false)
        const node = buttonRef.current
        if (node !== null && node !== undefined) node.focus()
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        placePanel()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        const onReflow = () => placePanel()
        document.addEventListener('keydown', onKeyDown)
        window.addEventListener('resize', onReflow)
        window.addEventListener('scroll', onReflow, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('resize', onReflow)
          window.removeEventListener('scroll', onReflow, true)
        }
      }, [open, placePanel, close])

      const toggle = () => {
        setOpen((value) => {
          const next = !value
          if (next) placePanel()
          return next
        })
      }

      const panel = open && ReactDOM?.createPortal
        ? ReactDOM.createPortal(
            h(
              React.Fragment,
              null,
              h('div', { className: 'dsh-pm-mask', role: 'presentation', onClick: close }),
              h(
                'div',
                {
                  className: 'dsh-pm-pop',
                  role: 'dialog',
                  'aria-label': t('title'),
                  style:
                    anchor === undefined
                      ? { left: 8, top: 8, width: 300 }
                      : {
                          left: anchor.left,
                          top: anchor.top,
                          width: anchor.width,
                          maxHeight: anchor.maxHeight,
                          overflowY: 'auto',
                        },
                },
                h(
                  'div',
                  { className: 'dsh-pm-head' },
                  h('span', { className: 'dsh-pm-title' }, t('title')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-pm-refresh',
                      onClick: () => void refresh(),
                      disabled: busy,
                    },
                    busy ? t('refreshing') : t('refresh'),
                  ),
                ),
                ready
                  ? h(WindowPicker, {
                      value: windowMinutes,
                      fallback: power.windowMinutes,
                      onPick: pickWindow,
                      t,
                      disabled: busy,
                    })
                  : null,
                ready
                  ? h(
                      'div',
                      { className: 'dsh-pm-grid' },
                      h(Stat, {
                        label: t('panel.energy'),
                        value: formatEnergy(energy.wallWh),
                        hint: t('panel.energyHint'),
                      }),
                      h(Stat, {
                        label: t('panel.system'),
                        value: formatEnergy(energy.systemWh),
                        hint:
                          energy.wallWh > 0
                            ? `${t('panel.efficiency')} ${Math.round((energy.systemWh / energy.wallWh) * 1000) / 10}%`
                            : undefined,
                      }),
                      h(Stat, {
                        label: t('panel.loss'),
                        value: formatEnergy(energy.adapterLossWh),
                        hint: t('panel.lossHint'),
                      }),
                      h(Stat, {
                        label: fill(t('panel.window'), { window: windowChoiceLabel }),
                        value: Number.isFinite(power.windowW) ? formatPower(power.windowW) : t('unknown'),
                        hint: Number.isFinite(power.windowSeconds)
                          ? fill(t('panel.windowSpan'), { window: formatWindow(power.windowSeconds, t) })
                          : undefined,
                      }),
                      h(Stat, { label: t('panel.uptime'), value: formatUptime(boot.uptimeSeconds, t) }),
                      h(Stat, { label: t('panel.boot'), value: formatClock(boot.epochMs) }),
                      h(Stat, {
                        label: t('panel.instant'),
                        value: formatPower(power.instantW),
                        hint:
                          power.instantSource === 'smc'
                            ? t('panel.instantSmc')
                            : t('panel.instantFallback'),
                      }),
                      h(Stat, {
                        label: t('panel.load'),
                        value: Number.isFinite(power.loadW) ? formatPower(power.loadW) : t('unknown'),
                        hint: t('panel.loadHint'),
                      }),
                      h(Stat, {
                        label: t('panel.last'),
                        value: Number.isFinite(power.lastIntervalW)
                          ? formatPower(power.lastIntervalW)
                          : t('unknown'),
                      }),
                      h(Stat, {
                        label: t('panel.sinceBoot'),
                        value: Number.isFinite(power.sinceBootW) ? formatPower(power.sinceBootW) : t('unknown'),
                      }),
                      h(Stat, {
                        label: t('panel.voltage'),
                        value: `${power.voltageV.toFixed(2)} V`,
                        hint: `${(power.currentA * 1000).toFixed(0)} mA · ${t('panel.current')}`,
                      }),
                      h(Stat, {
                        label: t('panel.interval'),
                        value: `${data.sampling.intervalSeconds} s`,
                        hint: `${t('panel.samples')} ${data.sampling.samples}`,
                      }),
                    )
                  : h('p', { className: 'dsh-pm-note' }, headline === '' ? t('unavailable') : headline),
                ready ? h(Sparkline, { series: data.series, t }) : null,
                h(
                  'p',
                  { className: 'dsh-pm-source' },
                  t('panel.source'),
                  snapshot.at === undefined
                    ? ''
                    : ` ${fill(t('updated'), { time: formatClock(snapshot.at) })}`,
                ),
              ),
            ),
            document.body,
          )
        : null

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            className: 'dsh-pm-pill',
            'aria-expanded': open,
            'aria-haspopup': 'dialog',
            'aria-label': pillTitle,
            title: pillTitle,
            onClick: toggle,
          },
          h(
            'svg',
            {
              className: 'dsh-pm-bolt',
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
            },
            h('path', { d: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z' }),
          ),
          ready && headline === ''
            ? h(
                React.Fragment,
                null,
                h('span', { className: 'dsh-pm-flat' }, t('label.energyShort')),
                h('span', { className: 'dsh-pm-num' }, energyText),
                h('span', { className: 'dsh-pm-uptime-sep dsh-pm-sep', 'aria-hidden': true }, '·'),
                h('span', { className: 'dsh-pm-uptime' }, formatUptimeShort(boot.uptimeSeconds, t)),
                h('span', { className: 'dsh-pm-sep', 'aria-hidden': true }, '·'),
                h('span', { className: 'dsh-pm-flat' }, windowLabel),
                h('span', { className: 'dsh-pm-num' }, hourText),
              )
            : h('span', { className: 'dsh-pm-flat' }, headline),
        ),
        panel,
      )
    }

    PowerMeter.displayName = 'PowerMeter'

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-power-meter: dictionaries')
        ctx.effect(
          () =>
            (function styles() {
              const element = document.createElement('style')
              element.dataset.plugin = 'dsh-power-meter'
              element.textContent = CSS
              document.head.appendChild(element)
              return () => element.remove()
            })(),
          'dsh-power-meter: styles',
        )
        // Session header, right-aligned utilities: a full-width bar, so the
        // readings fit on one line beside the existing header icons.
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'power-meter',
              order: 10,
              locale: NS,
            },
            PowerMeter,
          ),
        )
      },
    }
  },
})
