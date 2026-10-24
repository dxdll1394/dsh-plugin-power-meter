/**
 * dsh-power-meter — host half.
 *
 * Two sources, measured against each other:
 *
 * 1. Live power comes from our own SMC reads of `PDTR` (power drawn from the
 *    external supply) and `PSTR` (system load), both float watts. These track
 *    real load in well under a second.
 * 2. Cumulative energy comes from the firmware's own micro-watt-hour counters,
 *    which carry history since boot that this plugin could never reconstruct
 *    by integrating live samples itself. `AccumulatedWallEnergyEstimate` is
 *    the wall-end total and is what the panel reports; `AccumulatedSystemEnergy
 *    Consumed` and `AccumulatedAdapterEfficiencyLoss` split it into internal
 *    draw and adapter loss.
 *
 * Note on the wall counter: measured against live DC input (`PDTR`) over a
 * 300 s window it reads ~55% high on this hardware, because the adapter-loss
 * term is a firmware model constant rather than a measurement. The panel
 * labels it as a firmware estimate for that reason.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

/** Absolute path: the Host process does not always inherit the login PATH. */
const IOREG = '/usr/sbin/ioreg'

/** Route the browser half polls; exact paths cannot collide with a prefix. */
const ROUTE_PATH = '/api/power-meter'

/** How many readings to keep regardless of the configured window. */
const MAX_SAMPLES = 1600

/**
 * Shortest window worth reporting. One full sample interval already gives a
 * true counter-based average, and the panel always states which window it
 * used, so the number never claims an hour it does not have.
 */
const MIN_WINDOW_SECONDS = 60

/** Bounds of the user-selectable averaging window, in minutes. */
const MIN_WINDOW_MINUTES = 5
const MAX_WINDOW_MINUTES = 360

/** The bundle's own SMC helper, resolved next to this module. */
const SMC_READER = fileURLToPath(new URL('./native/smc-read', import.meta.url))

/**
 * Normalize the row config. The row is user-editable, so every field falls
 * back to its default instead of throwing.
 * @param config - raw loader config.
 * @returns resolved settings.
 */
function resolveConfig(config) {
  const intervalSeconds = Number(config?.sampleSeconds)
  const historyHours = Number(config?.historyHours)
  const windowMinutes = Number(config?.windowMinutes)
  return {
    // Default 5-minute cadence. Below ~60 s the firmware counters (which
    // refresh in batches) simply repeat, so a denser ring buys nothing.
    sampleSeconds:
      Number.isFinite(intervalSeconds) && intervalSeconds >= 30
        ? Math.min(3600, Math.round(intervalSeconds))
        : 300,
    historyHours:
      Number.isFinite(historyHours) && historyHours >= 1
        ? Math.min(168, Math.round(historyHours))
        : 24,
    // Default observation window for the "average power" reading.
    windowMinutes:
      Number.isFinite(windowMinutes)
        ? Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, Math.round(windowMinutes)))
        : 60,
  }
}

/**
 * Clamp a window request to the supported range.
 * @param minutes - requested minutes, possibly a numeric string.
 * @returns whole minutes within bounds, falling back to the configured default.
 */
function clampWindowMinutes(minutes) {
  const value = Number(minutes)
  if (!Number.isFinite(value)) return 300
  const whole = Math.round(value)
  return Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, whole))
}

/**
 * Read one power telemetry reading.
 *
 * UNITS. The three energy counters are micro-watt-hours (µWh), not millijoules
 * as their byte size suggests. Two independent checks pin this down:
 * `AccumulatedSystemPowerIn` is in mJ (its delta over 120 s divided by 120 s
 * reproduces `SystemPowerIn` in mW), and that counter sits at exactly 3.6x
 * `AccumulatedSystemEnergyConsumed` — the mJ-per-µWh factor. Treating the
 * energy counters as mJ understates every number by 3.6x.
 *
 * Instantaneous fields (`SystemPowerIn` mW, `SystemVoltageIn` mV,
 * `SystemCurrentIn` mA) need no such correction.
 *
 * @returns the normalized reading, or a reason it is unavailable.
 */
async function readTelemetry() {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'unsupported-platform' }
  }
  let stdout
  try {
    // `-n` + `-r` addresses the node by name and prints just its subtree
    // (~2 KB); `-c` matches the class and dumps every property of every match
    // (~328 KB). Same PowerTelemetryData either way, a third of the CPU.
    const result = await execFileAsync(IOREG, ['-n', 'AppleSmartBattery', '-w0', '-r'], {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    })
    stdout = result.stdout
  } catch (error) {
    return { ok: false, reason: 'ioreg-failed', detail: String(error?.message ?? error) }
  }
  const match = /"PowerTelemetryData"\s*=\s*\{([^}]*)\}/.exec(stdout)
  if (match === null) {
    return { ok: false, reason: 'no-telemetry' }
  }
  const raw = {}
  for (const [, key, value] of match[1].matchAll(/"([A-Za-z0-9]+)"=(-?\d+)/g)) {
    raw[key] = Number(value)
  }
  const wallUwh = raw.AccumulatedWallEnergyEstimate
  if (!Number.isFinite(wallUwh)) {
    return { ok: false, reason: 'no-wall-counter' }
  }
  const smc = await readSmcPower()
  return {
    ok: true,
    t: Date.now(),
    // Firmware's cumulative counters, micro-watt-hours since boot.
    wallWh: wallUwh / 1e6,
    systemWh: (raw.AccumulatedSystemEnergyConsumed ?? 0) / 1e6,
    lossWh: (raw.AccumulatedAdapterEfficiencyLoss ?? 0) / 1e6,
    accumulatorCount: raw.SystemPowerInAccumulatorCount ?? 0,
    // Live watts from SMC; falls back to the coarse ioreg snapshot.
    instantW: smc?.pdtr ?? (raw.SystemPowerIn ?? 0) / 1000,
    loadW: smc?.pstr,
    instantSource: smc === undefined ? 'ioreg' : 'smc',
    voltageV: (raw.SystemVoltageIn ?? 0) / 1000,
    currentA: (raw.SystemCurrentIn ?? 0) / 1000,
  }
}

/**
 * Read live DC-input and system-load watts from the bundled SMC helper.
 *
 * `PDTR` is the power drawn from the external supply; `PSTR` is total system
 * load. Both are float watts refreshed roughly once a second, far finer than
 * the ioreg snapshot fields.
 *
 * @returns the reading, or undefined when the helper is unavailable.
 */
async function readSmcPower() {
  try {
    const { stdout } = await execFileAsync(SMC_READER, [], { timeout: 2000, maxBuffer: 64 * 1024 })
    const parsed = JSON.parse(stdout)
    if (parsed?.ok !== true) return undefined
    return {
      pdtr: Number(parsed.pdtr),
      pstr: Number.isFinite(parsed.pstr) && parsed.pstr >= 0 ? Number(parsed.pstr) : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * Read the machine model once; purely descriptive text for the detail panel.
 * @returns a short model string, or undefined.
 */
async function readModel() {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', 'hw.model'], { timeout: 3000 })
    const value = stdout.trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * Read the boot time.
 * @returns the boot instant in epoch milliseconds, or undefined.
 */
async function readBootTime() {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { timeout: 3000 })
    const seconds = /sec\s*=\s*(\d+)/.exec(stdout)
    if (seconds === null) return undefined
    const micros = /usec\s*=\s*(\d+)/.exec(stdout)
    return Number(seconds[1]) * 1000 + (micros === null ? 0 : Math.round(Number(micros[1]) / 1000))
  } catch {
    return undefined
  }
}

/**
 * Pick the sample closest to a target instant.
 * @param samples - ascending samples.
 * @param targetMs - instant to approach.
 * @returns the closest sample at or before the target, else the oldest sample.
 */
function nearestAtOrBefore(samples, targetMs) {
  let best
  for (const sample of samples) {
    if (sample.t <= targetMs) best = sample
    else break
  }
  return best ?? samples[0]
}

/**
 * Host plugin: sampling loop plus one JSON route.
 * @param ctx - host cordis context.
 * @param config - row config.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  /** Ascending telemetry samples, oldest first. */
  const samples = []
  const state = {
    model: undefined,
    bootMs: undefined,
    lastError: undefined,
    sampling: false,
    /** Whether the ring holds a usable first sample. */
    seeded: false,
  }

  const prune = (now) => {
    const cutoff = now - settings.historyHours * 3600_000
    while (samples.length > 0 && (samples[0].t < cutoff || samples.length > MAX_SAMPLES)) {
      samples.shift()
    }
  }

  /**
   * Read the meter once.
   * @param commit - append to the fixed-cadence ring; false only refreshes the
   * displayed instantaneous reading, so an ad-hoc read never distorts the
   * evenly spaced series the averages are computed from.
   * @returns the reading, or undefined when telemetry was unavailable.
   */
  const sampleNow = async (commit = true) => {
    if (state.sampling) return undefined
    state.sampling = true
    try {
      const reading = await readTelemetry()
      if (!reading.ok) {
        state.lastError = reading.reason
        return undefined
      }
      state.lastError = undefined
      if (!commit) {
        state.adhoc = reading
        return reading
      }
      const previous = samples[samples.length - 1]
      // The counter only moves forward; a drop means the SMC counter restarted
      // (or the machine rebooted), so the ring is no longer comparable.
      if (previous !== undefined && reading.wallWh < previous.wallWh) samples.length = 0
      if (previous !== undefined && reading.wallWh === previous.wallWh) {
        // The firmware refreshes its counters in batches about once a minute.
        // A read inside a batch repeats the last value; storing it would make
        // the interval look like 0 W. Skip it and only refresh the live view.
        //
        // The very first committed sample is the exception: without it the
        // ring stays empty and the panel would report "no sample" forever
        // whenever the host starts between two counter refreshes.
        if (!state.seeded) {
          state.seeded = true
          samples.push(reading)
          prune(reading.t)
          return reading
        }
        state.adhoc = reading
        return reading
      }
      state.seeded = true
      samples.push(reading)
      prune(reading.t)
      state.adhoc = undefined
      return reading
    } finally {
      state.sampling = false
    }
  }

  /**
   * Average wall power between two readings.
   * @param from - earlier reading.
   * @param to - later reading.
   * @returns watts, or undefined when the readings are too close in time.
   */
  const powerBetween = (from, to) => {
    const dt = (to.t - from.t) / 1000
    if (!(dt > 0)) return undefined
    // Wh gained over the interval, expressed as watts.
    return { w: ((to.wallWh - from.wallWh) * 3600) / dt, seconds: dt }
  }

  /**
   * Build the payload the browser renders.
   * @param windowMinutesOverride - window requested by this call, if any.
   * @returns the snapshot.
   */
  const snapshot = (windowMinutesOverride) => {
    const now = Date.now()
    const latest = samples[samples.length - 1]
    const bootMs = state.bootMs
    const uptimeSeconds = bootMs === undefined ? undefined : Math.max(0, (now - bootMs) / 1000)
    if (latest === undefined) {
      return {
        ok: false,
        available: false,
        reason: state.lastError ?? 'no-sample',
        platform: process.platform,
        now,
        sampleSeconds: settings.sampleSeconds,
      }
    }
    const adhoc = state.adhoc
    // Instantaneous values come from the freshest read; counter-derived
    // averages stay on the committed ring so the cadence stays honest.
    const freshest = adhoc !== undefined && adhoc.t > latest.t ? adhoc : latest
    const lastInterval = samples.length >= 2 ? powerBetween(samples[samples.length - 2], latest) : undefined

    // The observation window: as far back as the ring reaches, clipped to the
    // requested span, and always reported as the window it actually is.
    const windowMinutes = clampWindowMinutes(windowMinutesOverride ?? settings.windowMinutes)
    const windowMs = windowMinutes * 60_000
    const windowTarget = latest.t - windowMs
    const windowFrom = nearestAtOrBefore(samples, windowTarget)
    const windowSpan = powerBetween(windowFrom, latest)
    const averaged =
      windowSpan !== undefined && windowSpan.seconds >= MIN_WINDOW_SECONDS
        ? {
            w: windowSpan.w,
            seconds: windowSpan.seconds,
            complete: windowSpan.seconds >= windowMs / 1000 - settings.sampleSeconds,
          }
        : undefined

    const series = []
    for (let index = Math.max(1, samples.length - 120); index < samples.length; index += 1) {
      const step = powerBetween(samples[index - 1], samples[index])
      if (step === undefined) continue
      series.push({ t: samples[index].t, w: Math.round(step.w * 1000) / 1000 })
    }

    const sinceBootW =
      uptimeSeconds !== undefined && uptimeSeconds > 600
        ? latest.wallWh / (uptimeSeconds / 3600)
        : undefined

    // Mean of the sampled instantaneous readings over the same hour. The wall
    // counter and the instantaneous estimate are different measurements (the
    // counter is the meter basis the energy totals use), so both are reported
    // rather than blended into one number.
    const hourSamples = samples.filter((sample) => sample.t >= latest.t - windowMs)
    const sampleMeanW =
      hourSamples.length > 1
        ? hourSamples.reduce((total, sample) => total + sample.instantW, 0) / hourSamples.length
        : undefined

    return {
      ok: true,
      available: true,
      platform: process.platform,
      now,
      device: { model: state.model },
      sampling: {
        intervalSeconds: settings.sampleSeconds,
        historyHours: settings.historyHours,
        samples: samples.length,
        oldestMs: samples[0].t,
        accumulatorHz:
          lastInterval === undefined ? undefined : Math.round((latest.accumulatorCount - samples[samples.length - 2].accumulatorCount) / lastInterval.seconds),
      },
      boot: {
        epochMs: bootMs,
        uptimeSeconds,
      },
      energy: {
        // Firmware's wall-end estimate: the total the panel reports.
        wallWh: latest.wallWh,
        // Firmware's split of that total.
        systemWh: latest.systemWh,
        adapterLossWh: latest.lossWh,
      },
      power: {
        instantW: freshest.instantW,
        loadW: freshest.loadW,
        instantSource: freshest.instantSource,
        voltageV: freshest.voltageV,
        currentA: freshest.currentA,
        instantAgeSeconds: Math.round((now - freshest.t) / 1000),
        lastIntervalW: lastInterval === undefined ? undefined : lastInterval.w,
        lastIntervalSeconds: lastInterval === undefined ? undefined : lastInterval.seconds,
        windowW: averaged === undefined ? undefined : averaged.w,
        windowSeconds: averaged === undefined ? undefined : averaged.seconds,
        windowComplete: averaged?.complete,
        windowMinutes,
        hourSampleMeanW: sampleMeanW,
        hourSampleCount: hourSamples.length,
        sinceBootW,
      },
      series,
    }
  }

  const respond = (request, response, body, status = 200) => {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  }

  ctx.effect(() => {
    void (async () => {
      state.bootMs = await readBootTime()
      state.model = await readModel()
      await sampleNow()
    })()
    const timer = setInterval(() => {
      void sampleNow()
    }, settings.sampleSeconds * 1000)
    return () => clearInterval(timer)
  }, 'power-meter: sampling loop')

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          handler: async (request, response) => {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            const url = new URL(request.url ?? ROUTE_PATH, 'http://localhost')
            const latest = samples[samples.length - 1]
            // Opening the detail panel asks for a fresh reading, but a burst of
            // clicks must not spawn a burst of `ioreg` processes.
            if (url.searchParams.get('fresh') === '1' && (latest === undefined || latest.t < Date.now() - 20_000)) {
              await sampleNow(false)
            }
            try {
              respond(request, response, snapshot(url.searchParams.get('window')))
            } catch (error) {
              respond(request, response, { ok: false, available: false, reason: String(error?.message ?? error) }, 500)
            }
          },
        }),
      `power-meter: webServer.register(${ROUTE_PATH})`,
    )
  })
}

export const name = 'dsh-power-meter'
