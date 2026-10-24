# dsh-power-meter

在 DeepSeek Harness 的 Web 界面里显示本机的实际耗电情况：**墙端累计耗电**、**开机时间**、**最近 1 小时平均功率**，每 5 分钟采样一次；点开后是完整读数面板。

## 数据从哪来

macOS 把 SMC 的电源遥测镜像成一个字典，挂在 `AppleSmartBattery` 节点上：

```bash
/usr/sbin/ioreg -c AppleSmartBattery -w0 | grep PowerTelemetryData
```

```text
"PowerTelemetryData" = {"AccumulatedWallEnergyEstimate"=3757572117,
  "AccumulatedSystemEnergyConsumed"=2199483669,
  "AccumulatedAdapterEfficiencyLoss"=1558088448,
  "SystemPowerInAccumulatorCount"=3321970,
  "SystemPowerIn"=3510,"SystemVoltageIn"=12537,"SystemCurrentIn"=280, ...}
```

| 字段 | 含义 | 单位 |
| --- | --- | --- |
| `AccumulatedWallEnergyEstimate` | **墙端累计**（电表口径，含适配器损耗） | **µWh** |
| `AccumulatedSystemEnergyConsumed` | 主机内部消耗 | **µWh** |
| `AccumulatedAdapterEfficiencyLoss` | 适配器损耗 | **µWh** |
| `AccumulatedSystemPowerIn` | 输入功率累计 | mJ |
| `SystemPowerInAccumulatorCount` | 采样计数（实测 ≈ 0.98 Hz） | count |
| `SystemPowerIn` / `SystemVoltageIn` / `SystemCurrentIn` | 瞬时功率 / 电压 / 电流 | mW / mV / mA |

> ⚠️ **单位是最容易踩的坑。** 这三个能量计数器看起来该是 mJ（数值动辄十亿），实际是 **µWh**。用 mJ 会让所有数字**偏小 3.6 倍**。判定依据见下方"单位怎么确定的"。

这些都是累计量，所以有意义的数字来自差值：

- **总耗电** = `AccumulatedWallEnergyEstimate` ÷ 1e6 Wh
- **窗口平均功率** = 窗口内墙端能量增量 × 3600 ÷ 窗口秒数
- **瞬时功率** = `SystemPowerIn` ÷ 1000（mW → W，无需换算修正）

### 单位怎么确定的

机器内部有两个互相独立的约束，同时成立才唯一解出 µWh：

1. **`AccumulatedSystemPowerIn` 是 mJ。** 它的增量 ÷ 经过秒数，精确复现 `SystemPowerIn` 的 mW 读数（实测 2969 mW vs 瞬时 2653–3384 mW）。所以该计数器单位是 mW·s = mJ。
2. **它正好是 `AccumulatedSystemEnergyConsumed` 的 3.6021 倍**，而 1 mJ = 3.6 µWh。两者是同一段时间的两种记法，因此能量计数器只能是 µWh。

另外 `WallEnergyEstimate` = `SystemEnergyConsumed` + `AdapterEfficiencyLoss` 在增量上严格成立，可作完整性自检。

### 瞬时功率与墙端计数不是同一个量

`SystemPowerIn`（适配器**输入端**）和墙端能量计数（**电表口径**）是两种不同测量，因此二者推算的平均功率通常不相等（本机静置时瞬时读数明显高于墙端计数均值）。插件把两者都显示，不混成一个数。

## 界面

- 位置：**会话顶部标题栏右侧**（`conversation.session.header.utilities`），和"在应用中打开 / 计划 / 下载日志"三个图标同一排。
- 形态：一枚紧凑胶囊 `⚡ 耗电 1.05 kWh · 38d 20h · 近1小时 1.71 W`，等宽数字、单行不换行。
- 窄窗口（< 1180px）：自动隐藏"运行时长"一段，只留耗电和功率，避免挤压标题。
- 点开是浮层面板（portal 到 `document.body`，向右下展开、点遮罩或按 Escape 关闭、关闭后焦点回到胶囊）。
- 面板内容：墙端累计／内部消耗／适配器损耗与效率、近 1 小时平均功率（含真实统计窗口）、近 1 小时瞬时均值、最近采样间隔、自开机均值、瞬时功率（带电压电流）、开机时间、运行时长、采样间隔与样本数，外加一条各采样间隔功率折线。

## 采样与配置

Host 进程每 `sampleSeconds` 秒读一次遥测（默认 300 秒，即 5 分钟），在内存里保留 `historyHours` 小时（默认 24）的样本环形缓冲；浏览器端在页面打开时读一次，之后跟着同一个节奏刷新。两者都在 `cordis.patch.yml` 的 `config` 里改：

```yaml
- insert:
    - id: power-meter
      name: dsh-power-meter
      config:
        sampleSeconds: 300
        historyHours: 24
```

数据只在内存里，重启 dsh 后重新累积；累计耗电本身来自系统计数器，不受影响。

## 接口

Host 提供 `GET /api/power-meter`（同源 JSON）；`?fresh=1` 会触发一次即采（20 秒内不重复）。返回 `energy`、`boot`、`power`、`sampling`、`series` 五组数据，非 macOS 或读不到遥测时返回 `ok:false` 与 `reason`。

## 兼容性

只在 macOS 有数据（依赖 `ioreg` 与 SMC 电源遥测；无电池的 Mac mini 同样有）。其它平台会显示"当前系统不提供这组电源遥测数据"。
