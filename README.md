# hass_amap · Home Assistant 高德地图底图

把 Home Assistant 内置地图（MapLibre）的**底图换成高德地图**（AMap JS API 2.0），
HA 原有的**设备标记 / 人员轨迹 / 区域编辑**等业务图层全部保留，手势、缩放、旋转、俯仰都照旧。

> 改自 [NXY666 的百度地图版 `hass_bmap.js`](https://gist.github.com/NXY666/17580cbcb213b8e9d7dc85c09b0abd50)，感谢原作者。

---

## 工作原理

百度版要“接管”百度地图内部的 WebGL 上下文，所以做了大量逆向；高德这边换了条更稳的路：

1. **拦掉 HA 自己的底图样式**（`/static/map/light.json`、`dark.json`）→ MapLibre 只留业务图层，画布变透明；
2. 在 `ha-map` 容器里垫一块**高德地图画布**（在 MapLibre 画布下层、`pointer-events: none`）；
3. 监听 MapLibre 的 `move / zoom / rotate / pitch / resize`，把视野换算成高德的
   「GCJ-02 中心 + 缩放 + 俯仰 + 旋转」同步过去 —— 于是拖拽、缩放、右键旋转、双指俯仰都跟手。

| | 百度版 | 本仓库（高德版） |
|---|---|---|
| 底图接入 | 逆向后接管百度内部 WebGL，共用一个 GL 上下文 | 独立画布叠在 MapLibre 下层，互不干扰 |
| 坐标系 | WGS84 → BD09（`BD09MC`） | WGS84 → **GCJ-02**（内置转换，出中国境自动不转） |
| 深色主题 | 对整块画布加 CSS 滤镜 | 切高德原生样式 `amap://styles/dark` |
| 业务图层 | 在 GL 内叠加 | MapLibre 画布在下、高德在上？→ 反过来：**标记仍由 MapLibre 画在高德之上** |
| 稳定性 | 依赖百度内部字段（`_webglPainter` 等），SDK 一改就可能挂 | 只用高德公开 API（`setZoomAndCenter / setPitch / setRotation / resize`） |

---

## 安装

1. 下载 [`hass_amap.js`](./hass_amap.js)，放到 HA 的 `/config/www/` 目录（例如 `/config/www/hass_amap.js`）。
2. 编辑文件顶部「配置」两行：

   ```js
   const key = '你的高德Web端Key';
   const securityJsCode = '';   // 2021-12-02 之后申请的 Key 必填
   ```

3. 在 HA 里注册前端资源，二选一：

   **界面**：设置 → 仪表盘 → 右上角 `⋮` → 资源 → 添加资源
   - URL：`/local/hass_amap.js`
   - 类型：`JavaScript 模块`

   **YAML**（`configuration.yaml`，需重启 HA）：

   ```yaml
   lovelace:
     resources:
       - url: /local/hass_amap.js
         type: module
   ```

4. 强制刷新浏览器（`Ctrl/Cmd + Shift + R`）。

> ⚠️ 本脚本**不要**和别的代码打包、也不要转存到本地 —— 高德官方规定 JS API 只允许在线加载
> （脚本会自己插入 `https://webapi.amap.com/maps?v=2.0&key=...&callback=...`）。

### 申请 Key

[高德开放平台](https://console.amap.com/dev/key/app) → 应用管理 → 新建应用 → 添加 Key：

- **服务平台**：`Web 端 (JS API)`
- **域名白名单**：填你访问 HA 用的域名（如 `ha.example.com`；用 IP 访问就填 IP）
- 若 Key 是 2021-12-02 之后申请的，还要在「安全密钥」里拿一个 `securityJsCode` 填进脚本；
  不填会报 `INVALID_USER_SCODE` / 地图空白。

---

## 可调参数

`CONFIG` 里几个常用项：

| 参数 | 默认 | 说明 |
|---|---|---|
| `lightStyle` | `amap://styles/normal` | 浅色底图样式，可换 `whitesmoke` / `grey` 等 |
| `darkStyle` | `amap://styles/dark` | 深色底图样式 |
| `zoomOffset` | `1` | 高德瓦片 256px、MapLibre 512px，同一比例尺 zoom 差 1；一般不用改 |
| `pitchGain` | `1` | 俯仰角换算系数；大角度俯仰时若觉得底图与标记“上下错开”，可试 `0.9`～`1.1` |
| `minZoom` / `maxZoom` | `2` / `20` | 高德支持的缩放范围，超出会被夹住 |

---

## 排错

浏览器控制台里搜 `[hass_amap]`：

| 现象 | 原因 | 处理 |
|---|---|---|
| 底图空白、标记还在 | Key 错 / 安全密钥缺 / 白名单不符 | 看控制台 `INVALID_USER_KEY`、`INVALID_USER_SCODE`、`INVALID_USER_DOMAIN` |
| 直接变回 HA 原生底图 | 脚本已**自动回退**（Key 没填、SDK 超时、被 CSP 拦） | 控制台会打印 `已回退到 Home Assistant 原生底图` 及具体错误 |
| 底图与标记整体偏移几百米 | HA 里存的坐标不是 WGS84（例如自定义集成直接写了 GCJ-02） | 本脚本按 WGS84 处理，数据源需自行统一 |
| 一打开地图卡一下 | 每次进入仪表盘都要新建高德实例、拉瓦片 | 正常现象；同一页面别放太多地图卡片 |
| 地图没出来 | 容器尺寸为 0（隐藏的 tab / 折叠卡片） | 脚本会等尺寸并在显示后 `resize()`；仍不行就报 issue |

> 回退是**保底**，不是故障：SDK 起不来时宁可看 HA 原生底图，也不留一块白板。

---

## 已知限制

- **坐标**：高德是 GCJ-02，HA 是 WGS84，脚本已内置转换；但 GCJ-02 偏移是**非线性**的，
  只对中心点精确换算，视野边缘理论上存在**米级**残差（实际基本看不出来）。
- **缩放**：高德支持 `2–20` 级；HA 允许缩到更小，超出部分底图会停在高德的下限（标记仍会继续缩）。
- **俯仰**：两边**透视视场角**不完全相同，`pitch` 很大时底图边缘与标记可能有几像素错位，
  可用 `pitchGain` 微调；`pitch = 0` 时完全精确。
- **WebGL**：高德 3D 与 MapLibre 都需要 WebGL；高德在不支持的环境会自动退回 2D（此时俯仰/旋转同步会失效）。
- **资源占用**：每张地图卡片一个高德实例（一块 WebGL 上下文），仪表盘上地图别堆太多。
- 未在 Safari 老版本上验证；HA 版本迭代快，若上游改了底图样式请求路径，脚本可能失效（会打印警告并回退）。

---

## 文件

```
hass_amap.js     唯一需要部署的文件
README.md        本文档
```

## 致谢

- 思路与百度版实现：[NXY666/hass_bmap.js gist](https://gist.github.com/NXY666/17580cbcb213b8e9d7dc85c09b0abd50)
- 地图服务：[高德开放平台 JS API 2.0](https://lbs.amap.com/api/javascript-api-v2/summary)
