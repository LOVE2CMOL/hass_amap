/*
 * Home Assistant 高德地图底图（AMap JS API 2.0）
 *
 * 改自 NXY666 的百度地图版 hass_bmap.js：
 *   https://gist.github.com/NXY666/17580cbcb213b8e9d7dc85c09b0abd50
 *
 * 原理（和百度版不同，这里不需要破解高德内部 WebGL）：
 *   1. 拦掉 HA 自己下载的底图样式（/static/map/light.json、dark.json），
 *      让 MapLibre 只剩「业务图层」——设备标记、轨迹、编辑控件等都还在；
 *   2. 在 ha-map 容器里垫一块高德地图画布（z-index 在 MapLibre 画布下面），
 *      并让 MapLibre 画布保持透明；
 *   3. 监听 MapLibre 的 move / zoom / rotate / pitch / resize，把视野换算成
 *      高德的「GCJ-02 中心 + 缩放 + 俯仰 + 旋转」同步过去，两张图始终对齐。
 *
 * 用法：
 *   1. 把本文件放到 /config/www/hass_amap.js
 *   2. HA → 设置 → 仪表盘 → 右上角 ⋮ → 资源 → 添加资源
 *      URL 填 /local/hass_amap.js（类型选「JavaScript 模块」即可）
 *   3. 改下面「配置」里的 key（安全密钥二选一：serviceHost 代理 / securityJsCode 明文），保存后强刷浏览器
 */

(() => {
	'use strict';

	// ==================== 配置（key 必填，安全密钥二选一）====================
	// 高德开放平台 → 应用管理 → 我的应用 → 添加 Key（服务平台选「Web 端(JS API)」）
	const key = '<高德地图Key>';

	// 安全密钥（2021-12-02 之后申请的 Key 需要；更老的 Key 两项都留空即可）
	// 方式 A（推荐，安全）：安全密钥代理。填 *_AMapService 代理地址，密钥只在服务器端，不进浏览器。
	//   可写同源相对路径 '/_AMapService'，也可写完整地址 'https://ha.example.com/_AMapService'
	//   （只写域名时会自动补 /_AMapService；带了自定义路径则原样使用）
	const serviceHost = '';
	// 方式 B（明文，仅开发/临时用）：直接把 securityJsCode 写进来，会暴露在浏览器里
	//   两项同时配置时以代理为准，明文会被忽略
	const securityJsCode = '';
	//
	// 以上三项也可以不写死，改在 configuration.yaml 里传（见 README）：
	//   frontend:
	//     extra_module_url:
	//       - /local/hass_amap.js?amapKey=xxx&amapServiceHost=/_AMapService
	// 优先级：window.__hassAmapConfig > URL 参数 > 这里的常量
	// ================================================================

	const CONFIG = {
		// 高德内置样式；浅色用 normal，深色用 dark（也支持 amap://styles/grey / whitesmoke / darkblue 等）
		lightStyle: 'amap://styles/normal',
		darkStyle: 'amap://styles/dark',
		// 高德瓦片 256px、MapLibre 512px，同一比例尺下 zoom 相差 1
		zoomOffset: 1,
		minZoom: 2,
		maxZoom: 20,
		// 两边透视视场角不完全一致，俯仰角换算系数；觉得高角度对不齐可微调（0.8~1.2）
		pitchGain: 1,
		// 高德俯仰角上限（2D 地图无效，3D 地图在 0~83 之间）
		maxPitch: 83,
		loadTimeout: 20000
	};

	const HOST_CLASS = 'ha-amap-host';

	// ---------- 配置解析：文件常量 < 上次加载的配置 < 本次 URL 参数 / window 注入 ----------
	// 允许把配置挂在本脚本 URL 的查询参数上（configuration.yaml / 资源地址都能用）
	const URL_CONFIG_FIELDS = [
		['amapKey', 'key'],
		['amapServiceHost', 'serviceHost'],
		['amapSecurityJsCode', 'securityJsCode']
	];

	// 收集“本脚本可能来自哪里”的线索：
	//   - 普通 / type=module 的 <script> 标签（Lovelace 资源走这条）
	//   - performance 资源记录（frontend.extra_module_url 是动态 import()，页面里没有 script 标签）
	function collectScriptUrls() {
		const urls = [];
		if (document.currentScript && document.currentScript.src) {
			urls.push(document.currentScript.src);
		}
		for (const script of document.querySelectorAll('script[src]')) {
			urls.push(script.src);
		}
		try {
			for (const entry of performance.getEntriesByType('resource')) {
				urls.push(entry.name);
			}
		} catch (error) {
			// 个别环境拿不到 resource timing，忽略
		}
		return urls;
	}

	// 参数名是我们自定义的，所以“URL 里带 amapKey/amapServiceHost/amapSecurityJsCode”即可认定是自己
	function readUrlConfig() {
		const config = {};
		for (const raw of collectScriptUrls()) {
			let url;
			try {
				url = new URL(raw, location.href);
			} catch (error) {
				continue;
			}
			for (const [param, field] of URL_CONFIG_FIELDS) {
				const value = url.searchParams.get(param);
				if (value) {
					config[field] = value;
				}
			}
		}
		return config;
	}

	function resolveSettings() {
		const explicit = {...readUrlConfig(), ...(window.__hassAmapConfig || {})};
		const merged = {
			key,
			serviceHost,
			securityJsCode,
			...(window.__hassAmapSettings || {}),
			...explicit
		};
		window.__hassAmapSettings = merged;
		return merged;
	}

	const settings = resolveSettings();

	function currentSettings() {
		return window.__hassAmapSettings || settings;
	}

	// 排查用：控制台执行 __hassAmapDebug() 查看当前生效的配置与缩放/分辨率
	window.__hassAmapDebug = () => {
		const maps = [];
		for (const [map, entry] of connectedMaps) {
			if (!entry) {
				continue;
			}
			const center = map.getCenter();
			const mlZoom = map.getZoom();
			const mlResolution = 40075016.68557849 * Math.cos(center.lat * Math.PI / 180) / (512 * 2 ** mlZoom);
			const amap = entry.base.amap;
			maps.push({
				mlZoom: +mlZoom.toFixed(4),
				amapZoom: amap && typeof amap.getZoom === 'function' ? amap.getZoom() : null,
				zoomOffset: CONFIG.zoomOffset,
				mlResolution: +mlResolution.toFixed(4),
				amapResolution: amap && typeof amap.getResolution === 'function' ? +amap.getResolution().toFixed(4) : null,
				mlCenter: [+center.lng.toFixed(6), +center.lat.toFixed(6)],
				amapCenter: amap && typeof amap.getCenter === 'function' ? amap.getCenter().toJSON?.() ?? null : null,
				pitch: +map.getPitch().toFixed(2),
				bearing: +map.getBearing().toFixed(2),
				amapPitch: amap && typeof amap.getPitch === 'function' ? amap.getPitch() : null,
				amapRotation: amap && typeof amap.getRotation === 'function' ? amap.getRotation() : null,
				hostSize: entry.base.host ? [entry.base.host.clientWidth, entry.base.host.clientHeight] : null,
				canvasSize: [map.getCanvas().clientWidth, map.getCanvas().clientHeight],
				amapSize: amap && typeof amap.getSize === 'function' ? [amap.getSize().width, amap.getSize().height] : null,
				dpr: window.devicePixelRatio || 1
			});
		}
		return {
			key: currentSettings().key && !currentSettings().key.startsWith('<')
				? `${currentSettings().key.slice(0, 6)}…${currentSettings().key.slice(-4)}`
				: '(未填写)',
			serviceHost: normalizeServiceHost(currentSettings().serviceHost) || '(未配置)',
			securityJsCode: currentSettings().securityJsCode ? '(已设置·明文)' : '(未配置)',
			securityConfig: window._AMapSecurityConfig || null,
			maps
		};
	};

	// 现场调 zoom 偏移，不用改文件：__hassAmapSetZoomOffset(0) / (1) / (2)
	window.__hassAmapSetZoomOffset = (value) => {
		const offset = Number(value);
		if (!Number.isFinite(offset)) {
			return '参数要是数字';
		}
		CONFIG.zoomOffset = offset;
		for (const entry of connectedMaps.values()) {
			if (entry) {
				entry.base.lastView = null;
				entry.base.requestSync();
			}
		}
		return `zoomOffset = ${offset}`;
	};

	// 记录每张 HA 地图：map -> {base, originalProjection, teardown()}
	// 放全局共享，保证“脚本被加载两次”时两次闭包看到的是同一份
	const connectedMaps = (window.__hassAmapMaps ||= new Map());
	let sdkPromise;
	let loadLogged = false;
	let fallbackReported = false;

	// 同一页面可能被加载两次（Lovelace 资源 ＋ frontend.extra_module_url）：
	// 第二次只合并配置（resolveSettings 已做），不再重复初始化
	if (window.__hassAmapInstalled) {
		console.info('[hass_amap] 脚本被重复加载，已合并配置并跳过初始化');
		return;
	}
	window.__hassAmapInstalled = true;

	// ---------- 1. 拦掉 HA 自带底图样式，只留业务图层 ----------
	const originalFetch = window.fetch;
	const emptyStyle = JSON.stringify({version: 8, sources: {}, layers: []});
	window.fetch = function (input, init) {
		const url = new URL(input instanceof Request ? input.url : input, window.location.href);
		if (/^\/static\/map\/[^/]+\.json$/.test(url.pathname)) {
			return Promise.resolve(new Response(emptyStyle, {
				headers: {'Content-Type': 'application/json'}
			}));
		}
		return originalFetch.call(window, input, init);
	};

	// ---------- 2. WGS84 → GCJ-02（HA 存的是 WGS84，高德要火星坐标）----------
	const PI = Math.PI;
	const SEMI_MAJOR_AXIS = 6378245.0;
	const ECCENTRICITY_SQUARED = 0.00669342162296594323;

	function outOfChina(lng, lat) {
		return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
	}

	function transformLat(x, y) {
		let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
		ret += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
		ret += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
		ret += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
		return ret;
	}

	function transformLng(x, y) {
		let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
		ret += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
		ret += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
		ret += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
		return ret;
	}

	function wgs84ToGcj02(lng, lat) {
		if (outOfChina(lng, lat)) {
			return [lng, lat];
		}
		let dLat = transformLat(lng - 105, lat - 35);
		let dLng = transformLng(lng - 105, lat - 35);
		const radLat = lat / 180 * PI;
		let magic = Math.sin(radLat);
		magic = 1 - ECCENTRICITY_SQUARED * magic * magic;
		const sqrtMagic = Math.sqrt(magic);
		dLat = (dLat * 180) / ((SEMI_MAJOR_AXIS * (1 - ECCENTRICITY_SQUARED)) / (magic * sqrtMagic) * PI);
		dLng = (dLng * 180) / (SEMI_MAJOR_AXIS / sqrtMagic * Math.cos(radLat) * PI);
		return [lng + dLng, lat + dLat];
	}

	function clamp(value, min, max) {
		return Math.min(max, Math.max(min, value));
	}

	// ---------- 3. 加载高德 SDK（官方脚本，不绕 CSP）----------
	function loadScript(url) {
		return new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.onload = () => {
				script.remove();
				resolve();
			};
			script.onerror = () => {
				script.remove();
				reject(new Error(`高德地图脚本加载失败：${url}`));
			};
			script.src = url;
			document.head.append(script);
		});
	}

	function waitFor(predicate, timeout) {
		return new Promise((resolve) => {
			const started = performance.now();
			const check = () => {
				if (predicate()) {
					resolve(true);
				} else if (performance.now() - started > timeout) {
					resolve(false);
				} else {
					setTimeout(check, 50);
				}
			};
			check();
		});
	}

	// 代理地址规范化：只写域名时补上高德固定的 /_AMapService 前缀；
	// 已经带了路径（如 /_AMapService、/custom-proxy）则原样使用，不替用户猜
	function normalizeServiceHost(value) {
		let host = String(value || '').trim();
		if (!host) {
			return '';
		}
		if (host.startsWith('/')) {
			host = location.origin + host;
		}
		let url;
		try {
			url = new URL(host);
		} catch (error) {
			return host.replace(/\/+$/, '');
		}
		if (!url.pathname.replace(/\/+$/, '')) {
			url.pathname = '/_AMapService';
		}
		return url.toString().replace(/\/+$/, '');
	}

	// 安全密钥必须在 JS API 脚本加载之前设置，否则设置无效
	function applySecurityConfig() {
		const active = currentSettings();
		const host = normalizeServiceHost(active.serviceHost);
		const config = {...(window._AMapSecurityConfig || {})};
		if (host) {
			if (active.securityJsCode) {
				console.info('[hass_amap] 同时配置了安全密钥代理与明文密钥，按代理处理（明文忽略）');
			}
			config.serviceHost = host;
		} else if (active.securityJsCode) {
			config.securityJsCode = active.securityJsCode;
		} else {
			return;
		}
		window._AMapSecurityConfig = config;
	}

	function loadAmapSDK() {
		return sdkPromise ??= (async () => {
			const active = currentSettings();
			if (!active.key || active.key.startsWith('<')) {
				throw new Error('请填写高德 Web 端 Key（文件顶部「配置」，或 URL 参数 amapKey）');
			}
			applySecurityConfig();
			if (!loadLogged) {
				loadLogged = true;
				console.info('[hass_amap] 生效配置：', window.__hassAmapDebug?.());
			}
			if (window.AMap) {
				return window.AMap;
			}
			const url = new URL('https://webapi.amap.com/maps');
			url.searchParams.set('v', '2.0');
			url.searchParams.set('key', active.key);
			// 官方限制：异步插入 <script> 必须带 callback，且回调要先挂到 window 上
			const callbackName = '__hassAmapReady';
			const sdkReady = new Promise((resolve) => {
				window[callbackName] = () => {
					delete window[callbackName];
					resolve();
				};
			});
			url.searchParams.set('callback', callbackName);
			try {
				await Promise.race([
					loadScript(url.href),
					sdkReady,
					new Promise((resolve, reject) => setTimeout(() => reject(new Error('高德地图 SDK 加载超时')), CONFIG.loadTimeout))
				]);
			} catch (error) {
				delete window[callbackName];
				throw error;
			}
			if (!window.AMap) {
				await waitFor(() => !!window.AMap, 5000);
			}
			if (!window.AMap) {
				throw new Error('高德地图 SDK 未就绪：请检查 Key、安全密钥以及 Key 的「域名白名单」');
			}
			return window.AMap;
		})();
	}

	// ---------- 4. 底图实例：一块高德地图，跟着 MapLibre 动 ----------
	class AmapBase {
		constructor(map) {
			this.map = map;
			this.host = null;
			this.amap = null;
			this.styleName = null;
			this.lastView = null;
			this.frame = 0;
			this.destroyed = false;
			this.fallback = false;
			this.warned = false;
			this.hiddenLayers = new Map();
			this.onViewChange = () => this.requestSync();
			this.onResize = () => {
				if (this.destroyed) {
					return;
				}
				if (this.amap) {
					this.amap.resize();
				}
				this.requestSync();
			};
		}

		// 挂上 DOM，并在容器有尺寸后创建高德地图
		async attach(AMap) {
			const map = this.map;
			const container = map.getContainer();

			// MapLibre 画布必须透明，才能露出下面的高德底图
			map.getCanvas().style.background = 'transparent';
			const canvasContainer = container.querySelector('.maplibregl-canvas-container');
			if (canvasContainer) {
				canvasContainer.style.zIndex = '1';
			}

			const host = this.host = document.createElement('div');
			host.className = HOST_CLASS;
			host.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;z-index:0;pointer-events:none;overflow:hidden;';
			container.insertBefore(host, container.firstChild);

			// 高德要求创建时容器已有实际尺寸，否则可能只出空白
			await this.waitForSize();
			if (this.destroyed) {
				return;
			}

			const view = this.readView();
			this.styleName = this.pickMapStyle();
			this.amap = new AMap.Map(host, {
				viewMode: '3D',
				zoom: view.zoom,
				center: view.center,
				pitch: view.pitch,
				rotation: view.rotation,
				zooms: [CONFIG.minZoom, CONFIG.maxZoom],
				mapStyle: this.styleName,
				showLabel: true,
				showBuildingBlock: true,
				showIndoorMap: false,
				// 交互一律交给 MapLibre，高德只负责画底图
				dragEnable: false,
				zoomEnable: false,
				rotateEnable: false,
				pitchEnable: false,
				doubleClickZoom: false,
				scrollWheel: false,
				keyboardEnable: false,
				touchZoom: false,
				jogEnable: false,
				animateEnable: false,
				resizeEnable: false,
				isHotspot: false
			});

			this.amap.on('complete', this.onViewChange);
			for (const name of ['move', 'zoom', 'rotate', 'pitch']) {
				map.on(name, this.onViewChange);
			}
			map.on('resize', this.onResize);

			this.resizeObserver = new ResizeObserver(this.onResize);
			this.resizeObserver.observe(container);

			// HA 深/浅色主题切换时换高德样式
			this.themeObserver = new MutationObserver(this.onViewChange);
			this.themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['class', 'data-theme']});
			this.themeObserver.observe(container, {attributes: true, attributeFilter: ['class']});

			this.applyView();
		}

		async waitForSize() {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				if (this.destroyed) {
					return false;
				}
				if (this.host.clientWidth > 0 && this.host.clientHeight > 0) {
					return true;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return true;
		}

		// MapLibre 视野 → 高德视野
		readView() {
			const map = this.map;
			const center = map.getCenter();
			const gcj = wgs84ToGcj02(center.lng, center.lat);
			return {
				center: gcj,
				zoom: clamp(map.getZoom() + CONFIG.zoomOffset, CONFIG.minZoom, CONFIG.maxZoom),
				pitch: clamp(map.getPitch() * CONFIG.pitchGain, 0, CONFIG.maxPitch),
				// MapLibre 的 bearing 是「正上方指向的方位角」，高德是「顺时针旋转角」，符号相反
				rotation: -map.getBearing()
			};
		}

		requestSync() {
			if (this.destroyed || !this.amap || this.frame) {
				return;
			}
			this.frame = requestAnimationFrame(() => {
				this.frame = 0;
				this.applyView();
			});
		}

		applyView() {
			if (this.destroyed || !this.amap) {
				return;
			}
			const view = this.readView();
			const last = this.lastView;
			const moved = !last
				|| Math.abs(last.zoom - view.zoom) > 1e-4
				|| Math.abs(last.pitch - view.pitch) > 1e-3
				|| Math.abs(last.rotation - view.rotation) > 1e-3
				|| Math.abs(last.center[0] - view.center[0]) > 1e-7
				|| Math.abs(last.center[1] - view.center[1]) > 1e-7;
			if (moved) {
				this.lastView = view;
				try {
					// immediately = true：不做动画，否则会追不上拖拽
					this.amap.setZoomAndCenter(view.zoom, view.center, true);
					this.amap.setPitch(view.pitch, true);
					this.amap.setRotation(view.rotation, true);
				} catch (error) {
					this.warnOnce(error);
				}
			}
			const style = this.pickMapStyle();
			if (style !== this.styleName) {
				this.styleName = style;
				try {
					this.amap.setMapStyle(style);
				} catch (error) {
					this.warnOnce(error);
				}
			}
		}

		warnOnce(error) {
			if (this.warned) {
				return;
			}
			this.warned = true;
			console.warn('[hass_amap] 同步高德地图视野失败：', error);
		}

		isDarkMode() {
			for (let node = this.map.getContainer(); node; node = node.parentNode) {
				if (node.classList && node.classList.contains('dark')) {
					return true;
				}
			}
			return document.documentElement.classList.contains('dark');
		}

		pickMapStyle() {
			return this.isDarkMode() ? CONFIG.darkStyle : CONFIG.lightStyle;
		}

		// HA 换样式后重新兜底：画布透明 + 藏掉可能残留的底图图层
		onStyleLoaded() {
			if (this.destroyed) {
				return;
			}
			this.map.getCanvas().style.background = 'transparent';
			this.hideBaseLayers();
			this.requestSync();
		}

		hideBaseLayers() {
			if (this.fallback) {
				return;
			}
			const style = this.map.getStyle();
			if (!style || !style.layers) {
				return;
			}
			for (const layer of style.layers) {
				if (layer.type !== 'background' && layer.type !== 'raster') {
					continue;
				}
				if (this.hiddenLayers.has(layer.id)) {
					continue;
				}
				this.hiddenLayers.set(layer.id, this.map.getLayoutProperty(layer.id, 'visibility'));
				this.map.setLayoutProperty(layer.id, 'visibility', 'none');
			}
		}

		destroy() {
			if (this.destroyed) {
				return;
			}
			this.destroyed = true;
			cancelAnimationFrame(this.frame);
			const map = this.map;
			for (const name of ['move', 'zoom', 'rotate', 'pitch']) {
				map.off(name, this.onViewChange);
			}
			map.off('resize', this.onResize);
			this.resizeObserver?.disconnect();
			this.themeObserver?.disconnect();
			try {
				this.amap?.destroy();
			} catch (error) {
				// 高德内部已卸载时忽略
			}
			this.amap = null;
			this.host?.remove();
			const canvasContainer = map.getContainer().querySelector('.maplibregl-canvas-container');
			if (canvasContainer) {
				canvasContainer.style.zIndex = '';
			}
			for (const [id, value] of this.hiddenLayers) {
				if (map.getLayer(id)) {
					map.setLayoutProperty(id, 'visibility', value ?? null);
				}
			}
			this.hiddenLayers.clear();
		}
	}

	// ---------- 5. 接入 HA 的地图引擎 ----------
	async function connectMap(engine) {
		const map = engine && engine._map;
		if (!map || connectedMaps.has(map)) {
			return;
		}
		connectedMaps.set(map, null);

		let AMap;
		try {
			AMap = await loadAmapSDK();
		} catch (error) {
			connectedMaps.delete(map);
			reportFallback(error, map);
			return;
		}
		// 加载期间地图可能已经被换掉 / 销毁；顺手清掉占位，避免以后再也接不上
		if (engine._map !== map || !connectedMaps.has(map) || map._removed || !map.getContainer().isConnected) {
			if (connectedMaps.get(map) === null) {
				connectedMaps.delete(map);
			}
			return;
		}

		const originalProjection = typeof map.getProjection === 'function' ? map.getProjection() : null;
		if (originalProjection !== null && typeof map.setProjection === 'function') {
			map.setProjection({type: 'mercator'});
		}

		const base = new AmapBase(map);
		const onStyle = () => base.onStyleLoaded();
		const entry = {
			base,
			originalProjection,
			teardown() {
				map.off('style.load', onStyle);
				map.off('styledata', onStyle);
				base.destroy();
				if (originalProjection !== null && typeof map.setProjection === 'function') {
					try {
						map.setProjection(originalProjection);
					} catch (error) {
						// 地图已销毁时忽略
					}
				}
			}
		};

		connectedMaps.set(map, entry);
		map.on('style.load', onStyle);
		map.on('styledata', onStyle);
		base.onStyleLoaded();

		// 先挂上销毁钩子：高德实例创建期间地图也可能被销毁
		const originalDestroy = engine.destroy;
		engine.destroy = function (...args) {
			entry.teardown();
			connectedMaps.delete(map);
			engine.destroy = originalDestroy;
			return originalDestroy.apply(this, args);
		};

		try {
			await base.attach(AMap);
		} catch (error) {
			entry.teardown();
			connectedMaps.delete(map);
			reportFallback(error, map);
			return;
		}
		if (base.destroyed) {
			return;
		}
		map.once('idle', () => base.requestSync());
	}

	// 高德不可用（Key 错、超时……）时回退到 HA 原生底图，别留一块空白
	function reportFallback(error, failedMap) {
		console.warn('[hass_amap] 高德底图不可用，已回退到 Home Assistant 原生底图：', error);
		if (fallbackReported) {
			return;
		}
		fallbackReported = true;
		window.fetch = originalFetch;
		void restoreNativeBase(failedMap);
	}

	async function restoreNativeBase(failedMap) {
		const targets = new Set();
		if (failedMap) {
			targets.add(failedMap);
		}
		for (const [map, entry] of connectedMaps) {
			if (entry) {
				targets.add(map);
			}
		}
		const isDark = document.documentElement.classList.contains('dark');
		const path = `/static/map/${isDark ? 'dark' : 'light'}.json`;
		let style = null;
		try {
			const response = await originalFetch.call(window, path, {cache: 'no-store'});
			if (response.ok) {
				style = await response.json();
			}
		} catch (error) {
			return;
		}
		if (!style) {
			return;
		}
		for (const map of targets) {
			const entry = connectedMaps.get(map);
			if (entry) {
				entry.base.fallback = true;
				entry.teardown();
				connectedMaps.delete(map);
			}
			try {
				map.setStyle(style);
			} catch (error) {
				// 地图已销毁时忽略
			}
		}
	}

	// ---------- 6. 找到页面上的 ha-map ----------
	const retryCounts = new WeakMap();
	const RETRY_LIMIT = 100;

	function connectElement(element) {
		if (!element || element.localName !== 'ha-map') {
			return;
		}
		const engine = element._engine;
		if (engine && engine._map) {
			void connectMap(engine);
			return;
		}
		if (!element.isConnected) {
			return;
		}
		const attempts = (retryCounts.get(element) || 0) + 1;
		if (attempts > RETRY_LIMIT) {
			return;
		}
		retryCounts.set(element, attempts);
		setTimeout(() => {
			if (element.isConnected) {
				connectElement(element);
			}
		}, 100);
	}

	function connectMaps(root) {
		if (!root || !root.querySelectorAll) {
			return;
		}
		for (const element of root.querySelectorAll('*')) {
			if (element.localName === 'ha-map') {
				connectElement(element);
			}
			if (element.shadowRoot) {
				connectMaps(element.shadowRoot);
			}
		}
	}

	function scanElement(element) {
		if (element.localName === 'ha-map') {
			connectElement(element);
			return;
		}
		if (element.querySelectorAll) {
			for (const candidate of element.querySelectorAll('ha-map')) {
				connectElement(candidate);
			}
		}
	}

	document.addEventListener('editing-available-changed', (event) => {
		const element = event.composedPath().find((node) => node.localName === 'ha-map');
		if (element) {
			connectElement(element);
		}
	}, true);

	connectMaps(document);

	if (document.documentElement) {
		new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) {
					if (node.nodeType === 1) {
						scanElement(node);
					}
				}
			}
		}).observe(document.documentElement, {childList: true, subtree: true});
	}
})();
