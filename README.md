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
   > 原来用百度版、资源地址是 `/local/hass_bmap.js` 的，可以把本文件**改名成 `hass_bmap.js` 直接顶替**
   > （脚本不依赖文件名，改完强刷即可）。
   >
   > 不想改文件里的常量？也可以把配置写在 `configuration.yaml` 的 `frontend.extra_module_url` 上，
   > 见下面「在 configuration.yaml 里配置」一节。
2. 编辑文件顶部「配置」：

   ```js
   const key = '你的高德Web端Key';

   // 安全密钥二选一（推荐 A：代理，密钥不进浏览器）
   const serviceHost = '/_AMapService';   // A) 代理地址
   const securityJsCode = '';             // B) 明文密钥（仅开发用）
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
- 若 Key 是 2021-12-02 之后申请的，还要配「安全密钥」，见下一节；不配会报 `INVALID_USER_SCODE` / 地图空白。

---

## 安全密钥（推荐用代理）

2021-12-02 之后申请的 Key 必须配安全密钥。脚本支持两种方式，**代理优先**：

### A. 代理方式（推荐 —— 密钥只待在服务器端）

思路：在 HA 前面的 Nginx 加两个反向代理，把 `jscode=安全密钥` 在**服务端**拼进高德请求；
浏览器里只出现代理地址，看不到密钥。

```nginx
server {
    listen 443 ssl;
    server_name ha.example.com;

    # ① 高德 Web 服务 API 代理（瓦片 / 检索等，必须）
    location /_AMapService/ {
        set $args "$args&jscode=你的安全密钥";
        proxy_pass https://restapi.amap.com/;
        # HA 页面默认不发 Referer，这里替它补一个（高德要求 Referer 命中域名白名单）
        proxy_set_header Referer "https://ha.example.com/";
    }

    # ② 地图样式 / 权限接口代理
    location /_AMapService/v4/map/styles {
        set $args "$args&jscode=你的安全密钥";
        proxy_pass https://webapi.amap.com/v4/map/styles;
        proxy_set_header Referer "https://ha.example.com/";
    }

    # ……其它 HA 反代配置照旧……
}
```

> `_AMapService` 是高德规定的前缀，**不能改名**；改完执行 `nginx -s reload`。

脚本里只填代理地址：

```js
const serviceHost = '/_AMapService';                  // 同源相对路径（推荐）
// const serviceHost = 'https://ha.example.com/_AMapService';  // 或完整地址
```

- 写相对路径时脚本会补成 `location.origin + '/_AMapService'`；
- **只写域名**（如 `https://ha.example.com`）会自动补 `/_AMapService`；**已带路径**（如 `/custom-proxy`）则原样使用，不替你做拼接；
- **建议代理与 HA 同源**；若代理放在别的域名，需要给该域名加 CORS 头（`Access-Control-Allow-Origin`）。

### B. 明文方式（仅开发 / 内网临时用）

```js
const securityJsCode = '你的securityJsCode';
```

⚠️ 明文会直接出现在页面源码与网络面板里，**不建议生产使用**。

### 优先级

`serviceHost` 与 `securityJsCode` 同时填写时，**以代理为准**，明文被忽略（控制台会提示一句）。

---

## 在 configuration.yaml 里配置（可选）

Home Assistant **没有**“给前端脚本传配置”的官方配置键 —— 但前端资源本身就是一条 URL，
把配置挂在**查询参数**上就行，脚本会去解析：

```yaml
frontend:
  extra_module_url:
    - /local/hass_amap.js?amapKey=你的Key&amapServiceHost=/_AMapService
```

| 参数 | 对应配置 | 说明 |
|---|---|---|
| `amapKey` | `key` | 高德 Web 端 Key |
| `amapServiceHost` | `serviceHost` | 安全密钥代理地址（推荐，密钥不进浏览器） |
| `amapSecurityJsCode` | `securityJsCode` | 明文安全密钥（会暴露在页面源码里，尽量别用） |

读取优先级：**`window.__hassAmapConfig`（运行时注入）> URL 参数 > 文件里的常量**。

两种加载方式都能读到参数：

- **Lovelace 资源**（类型 `module` 或 `js`）→ 页面里有 `<script>` 标签，直接读；
- **`frontend.extra_module_url`**（HA 用动态 `import()` 加载，页面里**没有** script 标签）→ 通过 `performance` 的资源加载记录识别，同样有效。

### 把整条 URL 藏进 secrets.yaml

HA 不支持字符串内插值，只能整条 URL 用 `!secret`：

```yaml
# configuration.yaml
frontend:
  extra_module_url:
    - !secret amap_module_url
```

```yaml
# secrets.yaml
amap_module_url: "https://ha.example.com/local/hass_amap.js?amapKey=你的Key&amapServiceHost=/_AMapService"
```

### 注意事项

- 改 `frontend:` 配置后要**重启 HA**；`extra_module_url` 对所有页面生效（包括登录页，没有地图就没影响）。
- URL 里的参数会出现在页面源码中：`amapKey` 本来就是公开的（靠域名白名单/代理保护），
  但 **`amapSecurityJsCode` 走 URL 等于明文暴露** → 生产环境请用 `amapServiceHost` 代理方式。
- 同一脚本如果既被 Lovelace 资源加载、又被 `extra_module_url` 加载，脚本有幂等保护
  （`window.__hassAmapInstalled`）不会重复初始化，但建议只保留一处。
- `serviceHost` 含 `/` 一般不用转义；若值里有 `&`，请做 URL 编码（`%26`）。

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
| 走代理后仍报 `INVALID_USER_SCODE` | 代理没生效（404 / 没注入 `jscode` / 跨域被拦） | 打开 Network 看 `_AMapService/...` 请求是否 200；检查 Nginx 两个 location 与 `nginx -s reload` |
| `FlyDataAuthTask error: INVALID_USER_DOMAIN` | **Key 的域名白名单不含当前访问域名**，且安全密钥没生效 | 见下面「鉴权报错排查」 |
| `Uncaught Error: Unimplemented type: 3` | 通常是上面鉴权失败后的连带报错 | 先把鉴权修好，一般会一起消失 |
| 控制台提示“同时配置了代理与明文密钥” | 两项都填了 | 删掉 `securityJsCode`，只留 `serviceHost` |
| 直接变回 HA 原生底图 | 脚本已**自动回退**（Key 没填、SDK 超时、被 CSP 拦） | 控制台会打印 `已回退到 Home Assistant 原生底图` 及具体错误 |
| 底图与标记整体偏移几百米 | HA 里存的坐标不是 WGS84（例如自定义集成直接写了 GCJ-02） | 本脚本按 WGS84 处理，数据源需自行统一 |
| 一打开地图卡一下 | 每次进入仪表盘都要新建高德实例、拉瓦片 | 正常现象；同一页面别放太多地图卡片 |
| 地图没出来 | 容器尺寸为 0（隐藏的 tab / 折叠卡片） | 脚本会等尺寸并在显示后 `resize()`；仍不行就报 issue |

> 回退是**保底**，不是故障：SDK 起不来时宁可看 HA 原生底图，也不留一块白板。

### 鉴权报错排查（`INVALID_USER_DOMAIN`）

> ⚠️ **实测（2026-11）：高德 webapi 要求「Referer 命中白名单」和「jscode 有效」**两者都满足**：**
>
> | 请求 | 结果 |
> |---|---|
> | 有 jscode、**无 Referer** | `INVALID_USER_DOMAIN`（即使 jscode 正确） |
> | 有 Referer、无 jscode | `INVALID_USER_SCODE` |
> | 两者都有 | 通过 |
>
> 而 **HA 页面默认不发 Referer**（响应头 `referrer-policy: no-referrer`，页面 meta 是 `same-origin`）。
> 所以只配代理 + jscode 还不够，必须补 Referer：
>
> - 让浏览器发：把 HA vhost 的 `Referrer-Policy` 改成 `strict-origin-when-cross-origin`；
> - 或让代理补（推荐，不依赖浏览器）：在 `_AMapService` 的 location 里加
>   `proxy_set_header Referer "https://你的HA域名/";`


按顺序查：

1. **看配置是否真的生效**：浏览器控制台执行
   ```js
   __hassAmapDebug()
   ```
   应该看到 `serviceHost` 是你配的代理地址、`securityConfig` 里有对应值。
   若 `serviceHost` 是 `(未配置)` → 配置没进去（检查 URL 参数拼写 / 是否被另一处加载抢先）。

2. **看代理请求**：Network 面板过滤 `_AMapService`：
   - `200` → 代理通了；
   - `404` → 请求落到了 HA（说明 Nginx 的 `location /_AMapService/` 没生效：配错 server 块、没 `nginx -s reload`、或 HA 前面还有一层反代没改）。

3. **命令行自测**：
   ```bash
   curl -i "https://你的HA域名/_AMapService/v4/map/styles?key=test"
   ```
   返回 Nginx/HA 的 404 → 代理没配好；返回高德的 JSON（哪怕带报错）→ 代理通了。

4. **临时替代方案**（不想立刻弄代理时）：
   - 到高德控制台把当前访问域名加进该 Key 的「域名白名单」；
   - 或先用明文 `securityJsCode` 顶着（会暴露，仅临时）。

> `Unimplemented type: 3` 是鉴权失败后的连带报错，鉴权修好后会一起消失。

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
