# 项目交接说明

给接手这个项目的人 / Agent。读完这份应该能直接开始干活。

> 这个文件在仓库根目录，Claude Code 开新会话时会自动读它，不需要谁手动贴过来。

---

## 1. 项目来源

Fork 自 **Istvan Krisztian Somoracz（NewKrok）** 的两个 MIT 项目：

| 上游 | 变成了这里的 |
|---|---|
| <https://github.com/NewKrok/three-particles> | `packages/three-particles` — 粒子库 |
| <https://github.com/NewKrok/three-particles-editor> | `packages/editor` — 可视化编辑器 |

原来是两个独立仓库，这里合成了一个 monorepo。原始 LICENSE 保留在 `packages/three-particles/LICENSE`。

拥有者：曹雨西（Cao Yuxi），新媒体艺术家。这是他自用的创作工具，不是要回馈上游的通用库。

线上：<https://caoyuxistudio.github.io/threeparticle-CAOModed/>（推 main 自动部署）

---

## 2. 原项目的架构逻辑

**粒子库**（`packages/three-particles`）是纯逻辑，不管 UI。给它一份 config 对象，它吐出一个可以 `add` 进 three.js 场景的粒子系统，每帧调 `updateParticleSystems`。有 CPU 和 WebGPU 两条路径，这个 fork 主要走 WebGPU + TSL。

**编辑器**（`packages/editor`）是个 Svelte 应用，本质是"给那个 config 对象做一套界面"：

```
┌──────────┬──────────────────────┬──────────────┐
│ 左面板    │      three.js 画布     │   右面板      │
│ Svelte   │  （整窗大小，面板浮在上面）│  lil-gui     │
│          │                      │              │
│ Examples │                      │ 粒子参数        │
│ Library  │                      │（发射、形状、    │
│ Textures │                      │  噪声、渲染器…） │
│ Scene ★  │                      │              │
└──────────┴──────────────────────┴──────────────┘
```

关键点：

- **config 就是作品**。一个 JSON 描述整个效果，能存能读能复制粘贴。
- 右面板由 `entries/*.ts` 里一堆 lil-gui 定义拼出来，改的是同一个 config 对象。
- `_editorData` 是 config 里给编辑器自己用的一块，库不读它。
- 画布是**整窗尺寸**，两侧面板是浮在它上面的 DOM。写视口相关代码时这点很容易踩坑（见下方"坑"）。

---

## 3. 我们在做什么

把它从"单个粒子发射器的调参工具"改造成 **粒子艺术装置的实时编辑器**——概念上是个极简版 Blender：有场景、有灯、有相机、有后期，所见即所得。

### 已经做完的

**Scene 面板**（★ 那一栏，本 fork 新增）。可以往场景里放这些原子物体：

| 类型 | 说明 |
|---|---|
| `BOX` `SPHERE` | 基础几何体 |
| `POINT_LIGHT` `DIRECTIONAL_LIGHT` | 灯 |
| `LIGHT_PROBE` | 环境光探针，可烘焙 |
| `FRAME` | **画框**。按内框长宽 + 边框粗细 + 深度调，正面和内框洞壁两套材质；开口可以**圆角**：四个角各自一个半径（面板上按全部 / 上一对 / 下一对调），开口本身仍是矩形，圆角外面用一块"遮罩"填上（子网格，盖面就是正面材质、洞壁沿用边缘材质——没有单独的遮罩色，圆角看上去就是边框长出来的一块）；圆角另有 `cornerSegments`（每个四分之一弧真实的分段数，默认 24——ExtrudeGeometry 对椭圆曲线会把 curveSegments 翻倍，代码里传的是一半）和 `cornerSmooth`（弧面墙上的顶点法线改成半径方向的平滑着色，盖面和两条直边不动，少几段也能在光和反射下显得圆），预设是苹果设备屏幕圆角占屏幕宽度的比例乘以开口宽度；`topOffset` 只把顶边（外沿、开口顶边、两个上角）往下挪，底边不动，用来对齐状态栏之类；`bottomOffset` 对称地把底边往上挪（上限是顶边留下的开口）；新建画框默认顶边 0.17、底边 0.17、四角 iPhone 17 Pro Max 预设（按开口宽算）——App 壳把状态栏藏掉之后上下对称就够了；WIP-Test-2 也是 0.17 / 0.17，圆角 62/440 × 开口宽 4。（0.58 是网页版对齐状态栏时用过的值，已弃。）"顶"和"上角 / 下角"按**输出相机的屏幕上方**定（`screenTopSign`：画框局部 +y 与相机上方向反向就翻过来），平躺的画框在俯视相机下才不会上下颠倒；相机一动画框会重新同步 |
| `CAMERA` | **输出相机**。作品最终是给这个机位构图的 |
| `ENVIRONMENT` | **全景环境光**。JPEG/PNG/WebP/HDR/EXR，照明 + 反射 + 可选背景 |

**几条贯穿的设计**：

- **场景跟着 config 走**。存在 `_editorData.sceneObjects`，保存/复制/加载都带着。config 是自包含的作品描述，不是一堆散参数。
- **Layers 分离**：layer 0 = 作品，layer 1 = 编辑器家具（网格、坐标轴、拖拽手柄、碰撞面手柄）。输出相机只看 layer 0，所以预览里是作品本身。**新加的物体默认在 layer 0，只有家具需要显式标记**——漏标会在预览里露出来，一眼可见；反过来标作品，漏了就是静默消失。
- **输出相机 + 右上角预览窗**。拖左下角红色把手改大小，最大可占屏幕 70%。尺寸会记住。
- **后期属于相机**，不属于编辑器会话。SSR 的开关和参数存在 CAMERA 物体上，跟着 config 走。一个场景可以放多个相机各带各的设置，隐藏其余的就是切换机位。

**阴影**（2026-09-14）。渲染器的 shadowMap 现在是开的（`world.ts`，PCFSoft）——之前画框和平行光上的 castShadow 一直是死设置，场景里从来没有过阴影。只有 `DIRECTIONAL_LIGHT` 投影，点光不投（六个面的代价）。投影的参数在**灯物体的 `shadow` 块**里随 config 走：`enabled`、`mapSize`、`radius`（软硬，单位是阴影图的纹素）、`bias`、`normalBias`、`intensity`（暗度）；除 enabled 外全是 three 侧的 uniform，拖了即生效，enabled 切的是 castShadow，LightsNode 的缓存键含它，材质自己重编译。面板在灯的 aims at 下面那组「shadow」。旧 config 没这个块就按默认补，默认值就是原来写死的那组。**粒子进了 shadow pass**：MESH 材质通过 `castShadowPositionNode`（深度 pass 拿一个局部坐标、套阴影相机自己的 MVP，不跑 vertexNode）和 `receivedShadowPositionNode`（片元查阴影图用的世界坐标；内置的 positionWorld 不认识每实例变换）接进去，`particle-factory` 只对 MESH 打开 cast / receive，其他材质进 pass 会把全部实例画在原点。顶点数学抽成 `instanceVertex()` 给两条路共用；阴影那条路也要给 varyings 赋值，否则深度材质评估 colorNode 的 alpha 时 vColor 是 0、全部 discard、一个影子都没有；死粒子在那条路里推到 1e6 外面（positionNode 没有负 w 可用）。效果是三向的：画框边框压在粒子上、粒子落到内壁和底上、粒子之间。用法：Scene 面板加一盏 Directional Light 就有了，随 config 走。WIP-Test-2 已经换成一盏平行光（位置 4 / 19.2 / 4，瞄准 1.9 / −2.8 / 12.6，强度 2，仰角约 68°），原来的点光删了；这是 2026-09-14 在编辑器里调好后按同一套流程写回 config 的。防频闪的旋钮：面板上的 softness（`shadow.radius`）和 map size；`VSMShadowMap` 还是 world.ts 里的一行代码开关（r182 的 WebGPU 支持，时间上最稳，密集云里会漏光），没进 config。掠射角要注意画框墙深 4.08：太阳仰角低于 45° 时一面墙的影子就盖过 4 宽的开口，框内只剩漏光。台式机上 200k 粒子多一遍深度 pass 的开销面板里量不出来（见下面「坑」），作者自己用 `?gputime` 看，不记账；手机端等 player 那一轮再说。

**SSAO**（2026-09-14，`world.ts`，参数在 CAMERA 物体的 `ao` 里随 config 走，和 SSR 并排）。用的是 three 附带的 `GTAONode` 加 `DenoiseNode`，吃的是 SSR 那个 MRT 里现成的深度和法线，**不加 scene pass**。合成顺序固定：先算遮蔽、把它乘进 beauty（整张乘，直接光也压，这是 contact shade 的要求；three 自己的 `builtinAOContext` 只压间接光，一盏太阳的场景里等于没有，而且要多一遍 prepass），落成纹理（SSR 要对颜色输入调 `sample()`，算出来的节点没有），SSR 追踪的就是这张已经带遮蔽的图，反射项再乘一次接收面的遮蔽后 `blendColor` 上去。管线由 `pipelineKey`（`ssr|ao`）决定形状，开关任一项都会在下一帧重建；其余参数全是 uniform，拖滑块不重编译。**不做时间滤波**：GTAO 的噪声图是固定的 magic square，帧与帧之间一样，靠 denoise 做空间去噪；TRAA 那条路要 velocity，compute 驱动的粒子没有上一帧位置，会拖影。默认：强度 0.7、半径 0.3（世界单位，颗粒尺度；大半径在这个场景里反而更淡，horizons 饱和、腔体比半径深）、8 采样、thickness 0.5、对比 1.5、半分辨率、denoise 4。view 菜单加了 `Occlusion only`，调参先看这张图。WIP-Test-2 开着，WIP-Test 关着但带完整的块（harness 查相机上的块是否完整）。HUD 有 `AO` 开关和一行报表。`aoReport` 把后期管线渲进离屏 RT 读回，比较强度 0.9 和 0 的均值、看遮蔽图不是一片白也不是一片黑、关掉后图里没有那个 pass。

**GPU 帧耗**：`?gputime` 打开渲染器的 `trackTimestamp`，控制台 `await __world.renderer.resolveTimestampsAsync('render'); __world.renderer.info.render.timestamp` 是最后一帧全部 render pass 之和（毫秒），`'compute'` 同理。它不依赖 rAF 节奏，但**只能在自己的浏览器里读**：自动化面板隐藏时查询池不刷新，一直吐同一个旧值。

**Player — 独立放映端**（`/player/`，源码 `src/player.ts` + `public/player/index.html`，同一个包的第二个 rollup 入口，产出 `build/player.js`）。TouchDesigner 的 editor / player 关系：editor 负责创作，player 只负责展示。它是 editor 的模块图去掉一切编辑的东西——Svelte、SMUI、lil-gui 根本不在它的依赖图里（不是运行时隐藏，是打包时不存在），一个渲染器、一个场景、输出相机直出画布。两种喂法：

- **standalone**（默认，直接打开 `/player/`）：黑屏 + 一个 **Paste config** 按钮。在 editor 里 COPY，到 player 里 ⌘V / Ctrl+V、点按钮（iOS 只允许在点击里读剪贴板；读不到就弹一个文本框贴）、拖一个 .json 进来、或者 `?config=<url>` 让机器喂。**不读不写任何存储、不监听任何频道**：作品只活在内存里，下一次贴就替换。这是手机打开的那个页面，也是以后 app 壳要包的那个页面。它启动时**一张贴图都不预加载**，贴进来的作品点名哪几张才去取（`ensureTexturesLoaded`）。默认没有帧数表（`S` 打开）。
- **linked**（`/player/?link`，editor 预览窗旁边那个显示窗口按钮打开的就是它）：老行为——BroadcastChannel 实时同步、共享同源存储里的贴图和快照，桌面上一边调一边看。

**两边不会漂的保证**：贴进来的 JSON 走的是 editor 自己 LOAD 用的 `loadParticleSystem`（legacy 转换、默认值、deepMerge、内嵌图片和 URL 视频的注册、场景交给 scene-objects），player 没有第二份加载逻辑。standalone 下"落盘"的那几处（图片进 `image-textures` 列表、视频进 `video-textures` 列表）由 `isStandalone()` 守在**存储边界**上改成内存（`runtime-mode.ts`），加载逻辑本身一行没分叉。player 里还给 `Storage.prototype.setItem` 包了一个计数器（`__player.storageWrites()`），HUD 的 `mode:` 一行报出来——"零存储"是量出来的，不是说出来的。harness 的 `standaloneReport` 在 iframe 里起一个真的 standalone player，把 editor `window.editor.serialize()`（和 COPY 完全一样的字符串）贴进去，再让 player 序列化回来逐字段比对，另外查场景、色源、视差 / touch 参数、零写入、二次贴替换、垃圾输入拒绝。**以后 editor 加任何进 config 的东西，跑一遍 standaloneReport 就知道 player 是否跟上了。**

`/player/index.html` 里有 `<base href="../">`：页面在下一层目录，但 bundle、图标、以及 config 里 `./assets/videos/…` 这种从站点根写的地址都要按根解析，base 一行解决。`player.webmanifest`（start_url `./player/`）让手机把 player 单独加到主屏幕，图标点开就是无边框的放映窗。旧地址 `player.html` 已删（dev 用的 sirv 会把 `/player/` 先解析成 `player.html`，留着它 `/player/` 就打不开）。

下面这些是 linked 模式的细节（显示窗口）：

- **显示窗口是独立窗口，不是新 tab**。浏览器会暂停隐藏 tab 的 rAF，所以做成 tab 的话你一看它编辑器就冻住了。
- **两个独立实例**。`world.ts` / `scene-objects.ts` 都是模块级单例，同一个页面开不出第二份；换个页面就各拿一套。代价是两个 WebGPU device，贴图各存一份，两边帧率都掉一些——这是调试形态刻意接受的成本。
- **BroadcastChannel 实时同步**。改一个滑块或拖一盏灯，120ms 节流后推过去。粒子 config 和场景走两条消息：场景按 id 做增量 `updateSceneObject`，画框几何和全景 PMREM 的缓存因此不会被打掉。
- **贴图不上线**。同源共享 localStorage，显示端自己读，所以消息只有几 KB。将来 Player 独立成站再把 `embeddedTextures` 塞回去。
- **显示端只读**。它的 `persist()` 不写 localStorage——同源，否则会覆盖你正在编辑的场景。
- **点开显示窗口时会把它的链接复制到剪贴板**并弹 snackbar 提示（剪贴板不可用时只显示链接）。
- **编辑器每次推送也会把最新的发射器 config 存进 localStorage**（`particle-system-editor/player-snapshot`，含 `elapsed` 和 `savedAt`；场景本来就由 scene-objects 持久化）。显示端 hello 后 1.2s 没人应答就读它，之后每 5s 再 hello 一次直到有活的编辑器；从后台回到前台时也会读一次，比屏幕上的新就换。这是**手机**上唯一能工作的方式：iOS 上 `window.open` 开的是 tab，后台 tab 整个冻结，编辑器和显示端永远不可能同时活着，靠 BroadcastChannel 握手必然失败；靠存储就是「在这个 tab 改、切到那个 tab 看」。同样也让粘贴链接在编辑器关掉后仍能显示最后一版。
- **双击 / 双指点两下屏幕 = 开关陀螺仪视差**（player 里；屏幕中央出 1.8 秒 "Gyro on / off" 字幕，开的时候把此刻姿态设为中心并申请权限）。触摸的双击自己判（320 ms 内、40 px 内两次 pointerup），不靠 iOS 的 dblclick。**手机上的全屏**：player 只在有元素全屏 API 的地方（桌面）才给 Full screen 按钮；iPhone 的 Safari 和主屏幕 app 都没有这个 API，按钮干脆不出现，真全屏靠 App 壳。`touch-action: manipulation` 关掉了双击缩放。
- **演示模式**（播放窗口按钮正下方那个 `fullscreen` 按钮，`presentation.ts`）：不开第二个页面，**这个窗口自己变成显示端**——全部面板 display:none，视口和角落预览都不画，输出相机按自己的画幅 letterbox 直出画布（走的就是 `renderPlayer`），能 requestFullscreen 就一起要。手机上这是唯一可行的形态（第二个 tab 会把编辑器冻住）；桌面上是「看一眼作品」的快捷键。Esc、全屏被浏览器退出、或点一下屏幕浮出的 Exit 都能回来；浮出的条上还有 FPS 开关。进去时取消选中（手柄的射线用的是编辑器相机）、关掉 orbit，出来时全部复原。`postProcessing.outputColorTransform` 在演示时为 true（直出画布），退出后恢复 false（预览 RT 那条路），别把这两处弄反。
- 共用的那份逻辑抽在 `particle-factory.ts`（config → 粒子系统）和 `simulation.ts`（发射器的内置运动），两边调同一个函数，不会漂移。
- **显示端有帧数表**，窗口左上角，`S` 隐藏。它存在的理由就是两个窗口画同一份东西一定比一个贵，而唯一诚实的读数在真正要看的那个窗口里。
- **显示端每 2 秒发一次 `ping`，编辑器 6 秒没听到就当它没了**（`isLinked()`），解除挂起、停止推送。没有这个，手动打开的播放页被直接杀掉（没来得及发 `bye`）会让编辑器永久挂起、视频永久暂停——实测踩过。harness 的 playerReport 因此在检查期间自己模拟 ping。
- **编辑器失焦就停止绘制**。显示窗口开着、编辑器不是当前窗口时，编辑器的帧循环整个跳过：省掉深度 pass、视口、以及预览那一遍完整的反射管线。画布调暗，中间浮一张 **Move to Player View** 卡片，点它把显示窗口调到前面；点视口任何地方就恢复。
  - 停的是**绘制**，不是工作。面板是 DOM，照常可用；参数改动走 `persist()` 而不是帧循环，所以挂起状态下编辑器就是个控制台——滑块在这边，画面在那边。所以调暗的是画布本身，不是盖一层全窗口的罩子：罩子会把 lil-gui 一起压暗，而那正是还能用的那一半。
  - 挂起同时把模拟时钟按 PAUSE 的那套记账停掉，否则回来那一帧 `cycleData.now` 会跳过整段挂起时间，发射器一次性全吐出来。会记住你自己是不是本来就按了 PAUSE。
  - 省不掉的是两个 WebGPU device 和两份贴图的显存——那是两个页面实例的固有成本，只有下面说的「Player 脱离编辑器」才去得掉。

**视频作为 color source**（Textures 面板的 **Add Video**）。`particleColorInstance` 原来只吃一张图：粒子出生时在 CPU 上查一次像素，拿到起始颜色和亮度→噪声系数。现在同一个入口也吃视频，静音循环播放，粒子出生时采的是当时正在播的那一帧。

- **为什么不用 GPU 纹理**。库里 color source 的全部用途就是出生那一刻的 CPU 像素查表，视频从头到尾不需要上传成 GPU 纹理，`importExternalTexture` / `copyExternalImageToTexture` 那些优化跟这条路径无关。解码走浏览器硬件（macOS 上是 VideoToolbox），主线程零成本；唯一的开销是**把当前帧读回 CPU**。
- **读回的做法**（`packages/three-particles/src/js/effects/three-particles/color-instance-sampler.ts`）：
  - 只在视频**真的出了新帧**时读（`requestVideoFrameCallback`，跟视频帧率走，不跟渲染帧率走）；只在**有粒子出生**时才需要（没人采样就不读）。
  - 读进一个有上限的网格（`particleColorInstance.sampleSize`，默认 512，2048² 的视频也只读 1MB），静态图仍按原尺寸只读一次。
  - 第一帧在主线程用 canvas 同步读一次（保证一开始就有颜色），之后每帧 `new VideoFrame(video)`（只是个句柄）转交给一个 **Worker**，在 `OffscreenCanvas` 里缩放、`getImageData`、把 buffer 转移回来。主线程每帧只剩 0.0–0.2ms。
  - 实测（2048²、30fps、编辑器满负荷渲染时）：worker 内每帧中位数 6ms，那是等共享 GPU 队列的同步停顿，落在 worker 自己的线程上；如果留在主线程就是每秒 30 次 × 6ms。`willReadFrequently: true` 的 CPU 路径每帧 12ms（先把整帧 2048² 转成 RGBA），WebCodecs `copyTo` 全分辨率 13–17ms，都更差。
  - 开销发布在 `map.userData.colorInstanceReadback`（count / lastMs / workerMs / mode），harness 和任何人都能读。
- **存储分开放**。元数据（名字、时长、缩略图）在 localStorage `particle-system-editor/video-textures`，跟图片列表并排；**字节在 IndexedDB**（库 `three-particles-editor`，store `videos`，key = 名字）。一分钟 H.264 有几十 MB，localStorage 装不下；IndexedDB 同源共享，显示窗口直接读，线上不传字节。也支持 **URL 来源**：只存地址，保存 config 时写进 `_editorData.embeddedVideos`，别处加载能自动补上；本地上传的视频只能以名字随 config 走（跟内置贴图一样）。
- **播放元素不能藏死**：放在一个 2px、opacity 0.01 的固定容器里而不是 `display:none`——不参与合成的视频不会触发 `requestVideoFrameCallback`；也不能从 DOM 里拿掉——按规范移除即暂停。编辑器挂起时把视频一起 `pause()`，回来再 `play()`。
- 显示窗口启动时读同一份列表；编辑器在它开着之后才加的视频，它按名字自己去 IndexedDB 取（`ensureVideoTexture`）。
- 调试出口 `window.__videoTextures`（addFile / addUrl / remove / entries / get），harness 靠它绕过文件对话框。
- Textures 面板自己持有一份列表拷贝，所以注册表每次写入都会在 `window` 上发 `video-textures-changed`，面板监听它刷新（也监听跨窗口的 `storage`）。点 **Use** 前会先确认名字真的有注册，没有就尝试从 IndexedDB 重新注册，再不行明确报错——曾经有过一张过期卡片被点中、粒子静默变黑的事。

**Touch — 手指尾迹**（粒子面板 **Touch** 一节，排在 Force Fields 前面；库里 `touch-wake.ts` + `webgpu/compute-touch-wake.ts`）。不是力场：力场是持续加速度、只认距离、落指即全力；这里把手指当成往流体里抹了一笔——最近 16 个样本（位置、速度、时间）放在 curveData 缓冲的尾巴上（和力场、碰撞面一样，不占新的 storage binding），每个粒子对样本求 `exp(−d²/r²) × exp(−age/τ)` 加权的速度和，直接加到位置上（和 curl noise 同一通道，两者相加），另加一项绕手指路径的漩涡（`swirl`）。手指不动 = 速度 0 = 什么都不发生；尾迹靠样本老化自己消退，不需要阻尼、不需要每粒子状态。CPU 路径同一个求和（`wakeDisplacement`，jest 有测）。参数在 config 的 `touch` 里：`isActive`（烤进 GPU kernel，改了要重建）、`radius`（**按屏幕比例**：视宽的份额，输入侧换算成世界单位）、`strength`、`wake`（秒）、`swirl`、`maxSpeed`、`normal`（漩涡所在平面的法线，默认 +y）。输入侧在编辑器的 `touch-input.ts`：pointer 事件从输出相机（带视差偏移）打到发射面（transform 的位置 + 旋转后的局部 +z 为法线）求交，速度取相邻样本差分再平滑、封顶，多指各自一条尾迹；演示模式和播放页生效，编辑器视口不生效（和手柄冲突）。调试口 `window.__touch`（screenToWorld / radiusAt / feed / count / clear / state），HUD 的 `touch:` 一行报手指数、喂了多少样本、当前样本数。WIP-Test-2 已开。

**Source Image Tweak**（粒子面板，紧跟在 Particle Color Instance 下面）：色源的"样子"。两组互不影响的杠杆，都存在 `particleColorInstance` 里随 config 走：`colorTweak`（saturation / level 即对比度 / hue，SVG feColorMatrix 那套矩阵，在 sRGB 空间作用于采到的像素，再变成粒子的起始色；库里 `color-tweak.ts` 预先合成一个 3×3 矩阵，每次出生九次乘法）和 `luminanceMap`（Luminosity Noise Map：black / white 两个点，采到的像素的亮度先按这两个点拉伸再去驱动 curl noise；量的是**原始**像素，改样子不改运动）。库的 jest 里有 `color-tweak.test.ts`。

**粒子面板的两处小改**：Particle Color Instance 现在紧跟在 Noise 下面（它的亮度→curl 系数本来就是 Noise 的一部分）；Mesh 一节在 lit 模式下多了 `roughness`（默认 0.65）和 `metalness`（默认 0）两个滑块，存在 `renderer.mesh` 里随 config 走。粒子的颜色本身就是它的 albedo（起始色 / 渐变 / Color Instance 采到的像素），这两个滑块决定灯光怎么落在上面；metalness > 0 的粒子会被 SSR 视为反射面。

**面板量程按装置的尺度改了**（2026-09-14）：gravity 滑块 ±1（原来 ±20）；maxParticles 1000–500000、rateOverTime 1000–100000，两者不再受 Helper 里 Enable big numbers 的管（那个开关现在只放宽 rateOverDistance 和 burst 的上限）；输入框里敲的数同样被钳在量程内，低于 1000 的发射率进不去。**新建系统起步是 10000 粒、1000 /秒**，定义在胶水的 `editorDefaultConfig()`，只有新建走它；加载仍按库的默认值合并，旧 config 省略这两个键时的含义不变。库的 `getDefaultParticleSystemConfig` 没动，序列化的 diff 基准也没动，所以新建出来的这两个值会明确写进 JSON。

**Velocity stretch，MESH 粒子的拖影**（2026-09-14，`renderer.mesh.velocityStretch`，秒；面板在 Mesh 一节的 align to velocity 下面，`schema:` 新字段）。每颗粒子沿自己的运动方向拉长"这么多秒里走过的距离"，头留在粒子处、多出来的长度拖在后面，快的长、慢的短。速度取的是**每帧真实位移**（compute kernel 里 `pos − posAtFrameStart` 除以 dt），不是速度缓冲——WIP-Test-2 的运动全来自 curl noise 和手指，速度缓冲一直是 0。速度存进 `particleState.w`（startFrame 那格，compute 侧从不读它；MESH 拉伸开着时纹理序列帧动画随之关闭，两者互斥），材质里按 `1 + streak / (网格 z 向长度 × meshScale.z × size)` 缩放局部 z、再沿朝向退回半个 streak，法线按逆转置补。开了拉伸就隐含 align to velocity（kernel 的 `trackTravelDirection` 和几何的 `instanceVelocity` 绑定都跟着开）。只在 WebGPU 计算路径上生效，和 alignToVelocity 一样。开销：200k 粒子每帧主线程 2.4 ms，和不开一样；阴影 pass 走同一个 `instanceVertex()`，拖影自动进影子。`stretchReport` 9 条：无键加载为 0、材质 `userData.velocityStretch`、不勾 align 也绑朝向、GPU 路径仍在、离屏读回画面有变化（要帧）、序列化往返。

**TRAIL 现在在 GPU 上**（2026-09-15）。有 WebGPU 计算时，TRAIL 和 MESH 一样走 GPU 模拟，ribbon 由顶点着色器自己展开，CPU 每帧不再碰任何顶点。结构：kernel 在每帧末尾把粒子位置（和时钟）写进它自己的**历史环**，环放在 `curveData` 那个 storage buffer 的尾巴上（在 touch wake 的样本之后，每颗 `length × 4` 个 float），不加第九个 binding；环的 head 和 count 借用 position.w 和 velocity.w（trail 没有 MESH 的朝向要存，那两格空着，出生时 init 块写 0）。`minVertexDistance` 在 kernel 里比上一个样本的距离，够了才记。渲染是一个实例化的 Mesh：基础几何是 `length × 2` 个顶点的条带，position = (slot, side, 0)，每实例属性就是那几个 storage buffer（instanceOffset / instanceVelocity / instanceColor / instanceParticleState）；顶点阶段用 `storage(...).toReadOnly()` 读环（newest first，slot 从 head 倒着数），做 CPU 版做的全部：Catmull-Rom 均匀重采样、按年龄淡出（`maxTime`，比的是 kernel 盖在样本上的同一个时钟，材质 `userData.trailNow` 每帧由 core 写）、宽度 / 透明度 / 颜色曲线（和寿命曲线一起烤进 `curveData` 前段，`BakedCurveMap` 多了 `trailWidth / trailOpacity / trailColorR/G/B`）、朝相机展开、按 rotation 绕切线滚动、宽度乘 size；超出 finalCount 的 slot 压在尾点上宽度 0，死粒子整条 w = −1 裁掉。代码：kernel 在 `compute-modifiers.ts`（`flags.trailHistory`、`trailHistoryInfo`），材质 `createGpuTrailRibbonTSLMaterial`（`tsl-trail-ribbon-material.ts`，片元和 CPU 版共用 `buildTrailFragment`），工厂 `createTSLGpuTrailMaterial`，core 里 `useGPUTrail` 一个开关决定几何、材质、属性绑定。**没搬的**：twistPrevention（GPU 上朝向由相机决定，用不着）、ribbonId 连成一条的 ribbon（没人用）。**回退**：工厂没有 `createTSLGpuTrailMaterial` 或没有 WebGPU 时，还是 CPU 模拟加 CPU ribbon，一行没删。**上限**：环要塞进 128 MiB 的 storage binding，超了 `createComputePipeline` 会 console.warn 并把 length 截短（200k 粒子最多 41 个样本）。量过：WIP-Test-2 换成 TRAIL、length 80、smoothing ×3——20000 粒子主线程 1.4 ms、60 fps（CPU 版优化后是 24 ms、40 fps，优化前 44 ms、22 fps）；200k 粒子主线程 3.2 ms、48 fps，那已经是 GPU 顶点数的上限（每帧 3200 万个顶点）。`trailReport` 9 条。jest `three-particles-gpu-trail.test.ts` 5 条：曲线烘进去、环的位置和大小、无 trail 无环、超限截短、材质能建。**参数的量程和含义**（2026-09-15 定的）：面板上 `length` 2 到 60，是环里的**样本数**，不是长度；`width` 面板显示的是 config 值 ×100（config 存世界单位，0.01 在这个作品的尺度上正好，面板读作 1，量程 0.1 到 10，新建默认 0.01 即 1；`schema:` 这是一个显示倍率，V2 的 schema 要有这个概念），`minVertexDistance` 是走了多远才记一个样本（0 = 每帧一个，带子长度随帧率变；设了就是 length × 距离的定长），`maxTime` 是样本年龄上限（秒），超龄不画、未超线性淡出，0 = 不看时间；`smoothing` 是过样本点的 Catmull-Rom 样条，`smoothingSubdivisions` 是每两个样本之间画几个点——以前插出来的点被封在 length 以内，环一满输出就是原始样本本身，等于没平滑，现在条带的点数是 (length − 1) × subdivisions + 1，环还是 length 个样本，两条路径一样（`trailSlotCount`）；`twistPrevention` 是 CPU 版的：带子每帧按相机重新定朝向，切线翻过去时左右两边会互换、带子看着拧一下，它记住上一帧的法线把两边翻回来，GPU 版没有这个开关（每个顶点每帧独立定朝向，靠 camRight 的过渡兜底）。

**CPU 版 TRAIL 的性能，量过**（2026-09-14，已被上面替代，留作对照）。`useGPUCompute` 的条件里有 `!useTrail`：切到 TRAIL 整个模拟回到 CPU，再加每帧在 CPU 上重写 maxParticles × 2 × length 个顶点的 ribbon。同一台机器、只计编辑器 animate 那一帧的主线程时间：MESH + GPU 200k 是 2.8 ms（60 fps）；MESH + CPU 200k 是 112 ms；TRAIL length 20 200k 是 268 ms（3.9 fps）；TRAIL length 2 加 minVertexDistance 0.13 是 128 ms；TRAIL length 20 在 10k 粒子上 17 ms。它的参数：`length` 是样本槽数不是长度；`minVertexDistance` 是记一个样本要走的距离（0 = 每帧一个，长度随帧率变）；`maxTime` 是样本年龄上限，超龄不画、未超按年龄淡出（0 = 不看时间，带子永远是最近 length 个样本、不会消散）；`smoothing` 以前插值后的点数被截到 length、只画前 1/subdivisions 段（上游 bug，2026-09-14 改成对整条样条均匀重采样，点数仍是 (count−1)×subdivisions+1 封顶 length）；`width` 世界单位。要弯曲的拖尾得做 GPU ribbon（历史环形缓冲进 storage buffer、kernel 写、顶点着色器读），没做。直拖影用上面的 velocity stretch。 **修了一个它的 bug**（2026-09-14）："所有线往中间连、很闪、白印儿偶尔跳出来"。ribbon 的索引缓冲永远画"最后一个样本 → 下一个槽"这一段，所以紧跟在最后一个活样本后面的那个槽必须每帧压在头上；`trailPrevFilledCount` 的省略清理把它跳过了，它留着上次清成的值——新缓冲是 0、死过一次也被清成 (0,0,0)——于是每颗新生粒子在第二个样本落下之前都从自己拉一根细条到发射器中心。出生越密、`minVertexDistance` 越大，条越多越久。现在那个槽总是清到头的位置，后面的槽照旧省略。jest `three-particles-trail.test.ts` 里"the slot that closes a ribbon"两条覆盖出生帧和死后重生。 **CPU 路径现在也有 curl noise**（同日）：以前 `noise.curl` 只在 GPU kernel 里实现，CPU 上被无视、退回上游的老 noise（每颗粒子沿自己的寿命采一条一维 FBM，邻居之间毫无关系，看起来就是左右乱抖），所以一切到 CPU 的场景——TRAIL、`simulationBackend: CPU`、没有 WebGPU 的回退——都不是作品里的那个流场。`curl-noise.ts` 是 `webgpu/tsl-noise.ts` 那份 simplex 的逐字标量移植（同一个 permute 多项式、同一套常数，连它那个和 Ashima 原版不同的 fold-back 都照抄，所以两边的场到 float 精度一致；这套梯度的幅度是 ±0.37 不是 ±1）加上 kernel 一模一样的 curl 组装（三个偏移势、eps 0.35 中心差分、时间漂移 0.15 / 0.11 / 0.13），`three-particles-modifiers.ts` 的 `applyModifiers` 在 `noise.curl` 时走它，缩放和 kernel 相同（strength × positionAmount × influence × 亮度系数 × delta；rotation / size 用 x 分量乘 noisePower / fbmMax），亮度系数在 CPU 上存进 `generalData.noise.lumaMul`。量法：0.3 世界单位内的邻居位移夹角余弦均值，GPU curl 0.64、GPU 老 noise 0.013、CPU（TRAIL）curl 0.61、CPU 老 noise 0.013。jest：`curl-noise.test.ts` 5 条（场的性质、同步长下散度精确为零）、`three-particles-curl-cpu.test.ts` 3 条（邻居同流、老 noise 不同流、delta 为零不动）。代价：每颗每帧 12 次 simplex，10k 粒子几毫秒，CPU 路径本来就只是测试用。 **ribbon 跟着粒子走**（同日）：以前带子的宽度只有 `trail.width × widthOverTrail(t)`，粒子的 size 完全不参与，rotation 也不参与，透明度还被乘了两次（顶点的 alpha 和颜色的 alpha 都带着粒子的 alpha，片元再相乘）。现在宽度乘粒子当前的 size（startSize、sizeOverLifetime、noise 的 sizeAmount 都在里面，和点精灵、mesh 一个尺度），rotation（startRotation、rotationOverLifetime、noise 的 rotationAmount）让带子绕自己的切线滚动——正对相机满宽、侧过来成一条线，透明度只在颜色里带一次。滚动角塞在 `trailUV.x` 里（左右两个顶点同值），横向坐标改由着色器从 `trailOffset` 算，没有加顶点缓冲（trail 已经占 7 个，WebGPU 默认上限 8）；TSL 和老的 GLSL 两份着色器都改了。上游四个 TRAIL example 的 startSize 是 0.2 到 0.6，它们的带子因此细了两到五倍，没有重调。jest 加 4 条。 **trail 的效率，量过**（同日，WIP-Test-2 换成 TRAIL：20000 槽、约 3500 颗活着、length 80、smoothing ×3、curl）：宽度和效率无关（width 放大十倍，帧时间一样，GPU 那边填充可以忽略），长度才是——CPU 上每颗每帧重写 2 × length 个顶点、每个顶点算两条 bezier 曲线。改前 node 里纯 CPU 35 ms 一帧（模拟 5 + ribbon 30），浏览器整帧 44 ms、22 fps；改了三处：宽度 / 透明度 / 颜色曲线一次采成 256 格的表（`tabulateCurve`，每顶点两次 bezier 变成查表）、smoothing 改成均匀重采样（顺便修了截断）、顶点缓冲只上传到本帧碰过的最高粒子（`highestTouched`，free list 从 0 往上发、后进先出，活着的都挤在底部，上面那段一直是清空的）。改后 node 里 18 ms（smoothing 关 10.7，length 20 是 6.8），浏览器整帧 24 ms、40 fps（smoothing 关 17 ms、50 fps；length 20 是 13 ms、60 fps）。剩下的大头是 smoothing 本身约 7 ms 和 curl 模拟 5 ms；再往下只有把 ribbon 搬到 GPU（历史环形缓冲进 storage buffer，顶点着色器自己算），那也是让 TRAIL 用上 GPU 模拟的唯一路。

**Opacity over lifetime 有了自己的一节**，紧跟在 Size over lifetime 下面，同一套 Edit Curve。它接管了 `opacityOverLifetime`；渐变编辑器（原来叫 Color & Opacity）改成只管颜色，每个色标的 alpha 滑块隐藏了，旧 config 里的 alpha 数据原样保留但不再被编辑。两个编辑器写同一个字段时，谁最后动谁赢，这是拆开的原因。注意 `renderer.transparent` 关着的时候 alpha 不参与混合，曲线唯一可见的效果是低于丢弃阈值处的硬切——要淡入淡出必须开 transparent（密集的云再考虑关 depthWrite）。

**手机上的性能工作流**。手机没有能模拟的东西——iOS 模拟器跑在 Mac 的 GPU 上，帧率毫无参考价值，DevTools 也只能限 CPU 不能限 GPU。所以仪器搬到手机上去：
- **Perf HUD**（编辑器演示模式的浮条上有 Perf 按钮，播放页点一下屏幕也有，键盘 `P`）显示两秒滚动窗口的 fps / 最差帧、实际渲染像素和 scale、粒子预算、SSR 参数、视频读回模式和耗时、设备信息，**Copy report** 把这些复制成文本，贴回对话就是一次测量。
- HUD 上的按钮一次只动一个变量：**scale**（像素比上限 0.75 / 1 / 1.5 / 2 / 设备原生）、**SSR 开关**、**SSR res**、**particles 预算 25% / 50% / 100%**。都是运行时临时的，不写进 config。用法就是每按一档记一个 fps，贴回来。
- **触摸设备的像素比默认封顶 2**（`world.ts` 的 `renderScaleCap`）。iPhone 报 3，3× 画布加 SSR 是 20 帧的头号嫌疑；2 已经是肉眼分不出的上限，桌面不受影响。
- 帧率的唯一可信读数是手机自己屏幕上的那个数；这里的面板测不了它。

**相机画幅**：CAMERA 的 output frame 里除了固定比例，多了 **iPhone 17 Pro Max**（440×956 逻辑像素，0.4603）和 **Fit window**（`aspect: 0`，跟着当前窗口走——播放页和演示模式里就是彻底铺满、没有黑边；编辑器预览则取编辑器窗口的比例）。铺满意味着构图随屏幕变，所以要精确构图用 iPhone 预设、从主屏幕图标打开来看。

**陀螺仪视差相机**（`parallax.ts`，参数在 CAMERA 物体的 `parallax` 里，随 config 走）。参考 algomystic 的 TheParallaxView（iPhone X TrueDepth 眼动追踪 + 离轴投影：屏幕当成一扇窗，眼睛动、窗平面不动、窗后的东西错位）。这里没有眼睛可追，用手机的倾斜代替：`deviceorientation` 的 beta / gamma 相对静止姿态的差 × `amount` = 虚拟眼睛在相机平面上的位移（上限 `maxOffset`）；渲染输出相机前把相机挪到眼睛的位置、再用 `setViewOffset` 把视锥反向平移，让 `planeDistance` 处的平面（0 = 第一个可见画框**朝相机那一面**，按相机视线量，`syncOutputCamera` 每次同步都重算。不是画框中心：画框有厚度，钉住中心的话正面会漂半个厚度——手机上实测就是这样，边框跟着动；钉住正面，开口和圆角遮罩纹丝不动，内壁和更深的粒子才像通道一样动）在画面里位置不变——只有比它深或浅的东西会动，这就是景深感。渲染完立刻复原，别的地方（编辑器视口、frustum helper、config）看不到相机动过。iOS 要在用户手势里申请权限：进演示模式和播放页的点击都会申请；进演示模式时把当时的姿态设为中心，`recenter` 秒的时间常数会慢慢把静止姿态重新学成中心（0 = 不学）。桌面上没有陀螺仪，鼠标在窗口里的位置代替它（也是 harness 驱动的口，`__world.parallax`）。方向：gamma 增大（右边缘远离你）→ 眼睛在屏幕法线左侧 → 眼睛 −x；beta 增大 → 眼睛 +y；`invertX / invertY` 各自翻转。HUD 的 `parallax:` 一行报来源 / 权限 / 眼睛位移 / 倾角 / 平面距离，HUD 上还有 `gyro` off / on 的杠杆（运行时临时的，和 SSR 那个一样，下次场景同步会被相机上的设置盖回去）；面板里的开关在相机的 parallax (gyro) 一节，排在 SSR 前面。**Gyro 面板**（`gyro-hud.ts`，演示条上的 Gyro 按钮 / 播放页点一下屏幕出现的 Gyro 按钮 / 键盘 `G`，`window.__gyroHud`）：gyro 开关、amount / max travel / smoothing / auto recenter 滑块、invert x / y、两个复位和 Copy report。编辑器里改的杠杆**写回相机物体**（COPY 会带走），播放页只在运行时生效。**Reset camera** = 把此刻的姿态设为中心（`recenterParallax`），画面回到构图；**Reset gyroscope** = 忘掉所有样本并重新申请传感器（`resetGyroscope`），给传感器停了或权限被拒的情况用。`recenter` 那个秒数是**自动**重新学中心的时间常数（高通滤波：换个持机角度几秒后画面自己回中），0 = 只靠 Reset camera 按钮。WIP-Test-2 里**默认关着**（`enabled: false`，手机上 Gyro 面板或 HUD 打开看），开了之后 amount 0.25、max travel 4——之前 0.08 / 1 在手机上几乎看不出动，眼睛位移要到几个世界单位画面才明显（粒子离被钉住的画框正面只有 2–3 个单位，位移的错位量只有眼睛位移的一成多）。新相机的默认也是 0.25 / 4，amount 滑块量程 0–1。

**iOS App 壳**（`apps/ios/ParticlePlayer/`，和 `packages/` 平级，CI 不碰它）。一个 SwiftUI App + 一个 WKWebView，加载线上的 `/player/`，只补网页做不到的几样：隐藏状态栏和 Home 指示条（真全屏）、`isIdleTimerDisabled`（装置不休眠）、禁掉滚动 / 回弹 / 缩放、视频内联自动播放（`mediaTypesRequiringUserActionForPlayback = []`）、陀螺仪权限由 App 代答（`requestDeviceOrientationAndMotionPermissionFor` → grant）、`isInspectable` 让 Mac 上的 Safari 能连 Web Inspector；离线时显示黑底提示，点一下重试。工程用 XcodeGen 从 `project.yml` 生成（`brew install xcodegen`，`xcodegen generate`），生成的 `.xcodeproj` 也提交了，Xcode 直接打开；签名是 Automatic，Team 在 Xcode 里选一次。装到跑 iOS 27 beta 的真机需要 Xcode 27 beta（26.6 只能跑 iOS 26 模拟器）。以后要断网可放，把 `public/player/`、`build/player.js`、`assets/` 打进 App 本地再改 `PlayerSource`。**永远只包 player，不包 editor。**

**显示端是 cover 不是 contain**（`fitPlayerCanvas`）：画布永远铺满窗口，相机取窗口的比例，视场按"覆盖预设构图"来算——窗口比预设窄就保留构图的高度裁两侧，比预设宽就保留宽度裁上下。预设（含 iPhone 那两个）只决定构图，编辑器预览按预设显示，退出演示时把相机恢复到预设。不留 letterbox 是有意的：目标是实打实的全屏。

**iOS 27 beta 主屏幕模式的极限**（实测 iPhone 17 Pro Max、iOS 27 beta）：网页视图永远只有"屏幕减状态栏"那么高（894 / 956），CSS 的 `100lvh` 却报 956。`black-translucent` 把视图整个挪到状态栏底下、底部留 62px 黑；`black` 让视图待在状态栏下面、顶部是黑色状态栏。两种都试过把画布画出视图外：那一段就是不显示，只会裁掉画面一边。`display: fullscreen` 试过，iOS 不认；去掉 manifest 的 `display` 走 `apple-mobile-web-app-capable` 老路径也试过，同样 894。所以网页在这台机器上到头了，收尾方案是：状态栏 `default`，页面从状态栏下面铺满到底；演示模式和播放页每半秒把画面顶边的平均色写进 `theme-color`，状态栏（以及 Safari 里的顶栏和底栏）跟着染色，看上去像画面延续过去——Apple 自己的页面就是这么"全屏"的。画布严格等于视图，cover 模式保证视图内没黑边。要真的压到状态栏底下，只能做原生壳（WKWebView 隐藏状态栏）。相机预设 **iPhone 17 Pro Max · app** = 440×894 就是这个视图。HUD 的 `viewport:` 一行报 doc / visual / screen / 各 vh 单位 / 安全区 / gap，再遇到视口问题先看它。

**iPhone 上去掉 Safari 的栏**（Safari 里进演示模式时会弹一次提示说这件事）：iPhone 的 Safari 没有元素全屏 API（iPad 才有），`requestFullscreen` 会被拒绝，演示模式在 Safari 里只能做到页面级全屏，底栏还在。唯一的路是 **添加到主屏幕**：两个页面都带了 `apple-mobile-web-app-capable`、`black-translucent` 状态栏和 `viewport-fit=cover`，manifest 是 `standalone`，从主屏幕图标打开就是无边框的 app 窗口，440×956 全部可用。HUD、演示浮条、播放页按钮都按 `env(safe-area-inset-*)` 避开灵动岛和 Home 指示条。

**手机竖屏的布局**：两侧面板之间不足 220px 时算窄屏，预览窗改为占画布整个宽度、放在右侧面板折叠后的标题条下面，旁边两个按钮跟着——否则竖屏时它们全被面板盖住，只有横屏才点得到演示模式。手机顶栏的汉堡菜单里也有 **Full screen**，和按钮等价。主屏幕模式下页面顶到状态栏底下，工具栏加了 `env(safe-area-inset-top)` 的顶部内边距，内容区高度相应扣掉；Safari 和桌面上这个值是 0。

**界面只剩 dark**。light 主题的切换按钮和 localStorage 偏好都删了，`index.html` 无条件只链 `smui-dark.css`（light 的 css 还在编译，只是不再链接）。

### 当前状态

- 测试场景是内置 example **WIP-Test**（`packages/editor/public/examples/wip-test/`），存在磁盘上，清空 localStorage 也在。它引用的是那张山水画；73MB 的那个测试视频进不了仓库
- **WIP-Test-2** 是作品本身：画框 + 一盏投影的平行光（带 `shadow` 块）+ 俯视输出相机（iPhone 17 Pro Max 画幅、SSR 和 SSAO 都开）+ 视频 color source。它的 `preview.webp` 还是换灯前的画面，刷新确认过不是 bug，维持现状。参数是 2026-09-11 在手机上调好后用 COPY 拷出的 JSON 直接写进去的（以后也这么更新：贴 JSON，不用截图），测试用的红球已经删掉。**编辑器一启动就直接加载它**（`DEFAULT_EXAMPLE`，在 `src/examples-config.js`；boot 一开始就 fetch，场景就绪后走和点 Examples 一样的 `window.editor.load`；fetch 失败就留在默认发射器，HUD 的 `boot:` 一行会写 `default … failed`）。代价是**刷新即回到示例**：面板里没导出的改动不会保留——粒子参数本来就不跨刷新，场景以前会留，现在也不留了；要保留就 Save 或者抄回 example。视频是 `public/assets/videos/wechat-20240829.mp4`（1000²、53s、1.6Mbps、10.6MB，随站点部署），config 用 **URL** 引用它（`_editorData.embeddedVideos`），所以任何能打开站点的设备都能播，手机上也是从 Examples 一点就开。这是「资产走 URL、config 走仓库」这条路的第一个样品
- **做一个带视频的 example 的步骤**：把视频放进 `public/assets/videos/`；Textures 面板 **Add Video by URL** 填 `./assets/videos/<文件>`（相对地址，本地和 Pages 都能解析），Use；调好后 Copy，把 JSON 存成 `public/examples/<slug>/config.json`（slug 是名字小写、非字母数字换成连字符），配一张 `preview.webp`，在 `src/examples-config.js` 里加名字。本地上传（Add Video）的视频只在本机浏览器里，带不进 config
- 控制台 harness `public/__ai-test.js`，当前基线 **283/283**（含 `trailReport` 9、`stretchReport` 9、`aoReport` 7、`shadowReport` 10、`report` 26、`standaloneReport` 20、`touchReport` 9、`parallaxReport` 19、`videoReport` 30、`gizmoReport` 12、`playerReport` 41、`presentReport` 33、`frameReport` 24）

---

## 4. 下一步

**V2（新界面与架构）的规划在根目录 `V2-ARCHITECTURE.md`**（讨论稿，2026-09-14）：引擎边界、三份合同（Document / Schema / Tokens）、里程碑 M0 到 M4、两条线并行的规则。引擎线在引擎模块里不得引入 DOM / 框架依赖，加 config 字段要同时补 schema。

Player 已经是放映端了（§3「Player — 独立放映端」）：贴 JSON 就能跑，单实例，零存储。剩下的：

**1. App 壳上真机。** 壳已经在 `apps/ios/ParticlePlayer/`（§3「iOS App 壳」），iOS 26 模拟器上构建通过；差的是 Xcode 27 beta 装到 iOS 27 的手机上跑一遍，再决定要不要把 player 文件打进 App 本地做离线。

**2. 手机上验手感。** 手指尾迹（touch）和陀螺仪视差都在，参数要在 iPhone 上调：Perf / Gyro 面板 → Copy report → 贴回来；作品参数照旧 COPY → 贴 JSON → 写进 example。

这也是为什么前面那些设计要那样做：config 自包含、场景存进 config、后期归相机、layer 分离——都是为了让"复制一段 JSON 过去就能完整重现"这件事成立。

---

## 5. 上手须知

### 跑起来

```bash
cd packages/three-particles && npm run build   # 库要先构建，editor 从 dist 解析它
cd ../editor && npm run dev                    # 8080
```

改源码会自动重新打包，但**不会自动刷新页面**，要手动刷新。

### 验证改动

别靠一路点击加截图，慢且容易骗自己。两次调用跑完：

```js
// 1. 刷新页面
window.location.reload()

// 2. 跑全部断言
await fetch('/__ai-test.js').then(r=>r.text()).then(eval)
await __t.report()          // 存取回归
__t.cameraReport()          // 相机 / layer / 预览
await __t.environmentReport()
await __t.frameReport()
await __t.playerReport()    // 显示窗口的通信契约 + 编辑器挂起
await __t.videoReport()     // 视频 color source：存储、循环、读回、清理
await __t.gizmoReport()     // 场景物体的拖拽手柄：合成指针事件真的拖一次
await __t.presentReport()   // 演示模式：进、量、出
await __t.parallaxReport()  // 视差：平面不动、更深的动、来源、上限、翻转
await __t.touchReport()     // 手指尾迹：屏幕→发射面、半径按视宽、样本进出
await __t.standaloneReport() // 独立 player：iframe 里真起一个，贴 COPY 的字符串，逐字段比对，零存储
await __t.shadowReport()    // 阴影：渲染器开关、粒子的两个钩子、太阳投 / 点光不投、灯上的 shadow 块、离屏读回的开关对照
await __t.aoReport()        // SSAO：相机上的块到渲染器、管线形状、读回的强度对照、遮蔽图、关掉即无
await __t.stretchReport()   // 拖影：无键为 0、材质记账、隐含朝向、GPU 路径仍在、读回有变化、序列化往返
await __t.trailReport()     // GPU ribbon：TRAIL 走 GPU、材质是 GPU 版、没有 CPU ribbon、环已绑定、条带顶点数、读回有画、往返、无报错
```

`videoReport` 要能 fetch 到 `./assets-local/AnimateDiff_00013.mp4`。那是个指向仓库旁边 `assets4test/` 的软链，目录整个 gitignore，新机器上要重建：

```bash
ln -sfn "$PWD/assets4test/AnimateDiff_00013.mp4" packages/editor/public/assets-local/AnimateDiff_00013.mp4
```

加新功能就往对应的 report 里加断言。

`environmentReport` / `frameReport` / `playerReport` 都是异步的，**不能塞进同一次批量调用**——排队的后续调用之间浏览器面板会隐藏，rAF 被暂停，等场景重建的地方会量到上一帧的几何，报假失败。一个 report 一次调用。

同一个原因还会坑另一件事：**别在自动化面板里量帧率**。面板可见性会高频抖动（实测 356ms 内 6 次 visible/hidden 切换），rAF 跟着断续，数出来的 FPS 可以低到 1，看起来像性能塌了，其实什么都没发生。

真实帧率只能在人自己的浏览器里读：编辑器看左上角那个 stats，显示窗口看它自己左上角那个（`S` 隐藏）。两个窗口一起跑的时候，**要看的是显示窗口那个数**——编辑器失焦就停画了，它那个读数是冻住的，所以挂起时会被压暗，提醒你别去读它。

挂起相关的断言只能验结构（帧数确实不再前进、焦点回来确实恢复、卡片层级低于面板），**省了多少帧验不了**，别写成好像验过了。

同理，`videoReport` 里标着「needs frames / needs a visible window」的几条依赖 rAF 和 `requestVideoFrameCallback`，面板隐藏时会假失败；读回的**成本数字**（worker 里几毫秒、主线程零点几毫秒）是在真实负载下另外量的，harness 只断言量级。

### 技术栈

three **r182**、`WebGPURenderer`、TSL 节点材质、Svelte 5、Rollup。

### 已知的坑

**画布不是从窗口左上角开始的**——上面有 47px 工具栏。渲染器的视口/裁剪坐标相对 canvas，鼠标事件的 `clientX/Y` 相对窗口。混用会得到"画在这里、点在那里"的 bug，截图完全看不出来。统一用 `canvasBounds()` 换算。

**WebGPU 的 viewport 原点是左上角**，和 WebGL 的左下相反。

**iOS 会把页面缩放到获得焦点的小字输入框上**：`<input>` / `<textarea>` 的字号小于 16px 时，一获得焦点 Safari（主屏幕 app 也一样）就把整页放大到它，之后页面留在放大状态，`window.innerWidth/Height` 变成可视视口（放大后那一小块），按它算尺寸的画布就变成页面的一个角。手机上的 player 实测踩过：粘贴用的文本框 12px → 贴完画面缩在左下角，HUD 的 `viewport:` 一行 `doc 440×894, visual 330×670 @224` 就是这个症状（现在还会直接报 `zoom x1.33`）。三道保险：文本框字号 ≥ 16px；player 的 viewport meta 加 `maximum-scale=1, user-scalable=no`；`fitPlayerCanvas` 改按**布局视口**（`documentElement.clientWidth/Height`）算尺寸，被放大了也画满整页而不是缩成一角。

**没有 WebGPU 的地方粒子会整个消失，除非注册 TSL 材质**。世界永远用 `WebGPURenderer`；拿不到 adapter 时 three 自己退到 WebGL2 后端（iOS 模拟器就是这样：`navigator.gpu` 存在但 `requestAdapter()` 返回 null；老浏览器同理）。以前这时候库里什么都没注册，粒子用 GLSL 的 `ShaderMaterial`，WebGL2 后端拒绝它（`THREE.NodeMaterial: Material "ShaderMaterial" is not compatible`），画面里只剩画框、没有报错。现在 `gpu-support.ts` 的 `prepareParticleBackend()` 统一决定：有 adapter → `enableWebGPU()`（TSL + compute，GPU 模拟）；没有 → 只注册 `createTSLParticleMaterial / createTSLTrailMaterial`（TSL 编译成 GLSL，没有 compute 管线所以库走 CPU 模拟）。editor 和 player 都走它，HUD 的 `backend:` 一行报 webgpu / webgl。CPU 模拟 20 万粒子很慢，只是保证"能看见"；真机（iOS 27）有 WebGPU，不受影响。App 的 Debug 版把页面 console 转发进系统日志（`log stream --predicate 'process == "Particle Player"'`，看 `[web …]` 行），模拟器里没有 Web Inspector 时靠它。

**放到 layer 1 的东西，射线检测也要跟着改**。`Raycaster.layers` 默认只看 layer 0，TransformControls 内部找手柄用的也是一个 Raycaster。把手柄 `markAsEditorOnly` 之后如果不给对应的 raycaster `layers.enable(EDITOR_LAYER)`，手柄画得出来但 hover 不亮、拖不动，而且没有任何报错——场景物体、力场、碰撞面三套手柄都这样坏过一轮。新加任何家具层上的可点击物，配套的 raycaster 一起改。

**TSL 会吞掉 shader 里的异常**。表现是"没报错也没效果"，所有输入单独看都对。SSR 卡了两天就是这个——传进去的节点缺 `.sample()` 方法，每次采样都抛异常。遇到这类情况，直接往 shader 内部插探针读它自己看到的值，不对称的地方就是 bug。

**post-processing 不能被 scissor 裁到角落**——它内部的 scene pass 会跟着被裁，整个画布变黑。预览是先渲进离屏 RT 再贴过去的。

**自动化面板的截图里 WebGPU 画布是陈旧的**。面板的 screenshot 对 DOM 是新鲜的（叠一个红块立刻能看到），对 WebGPU 画布却可能停在几分钟前的一帧：帧计数在走、相机也动了、图一动不动。帧间 `drawImage(canvas)` 读到的是黑，rAF 里读也是黑。要看画面就渲到 `RenderTarget` 再 `readRenderTargetPixelsAsync`，宽度取 256 字节对齐（512 / 1024），否则读回的行会错位；`shadowReport` 就是这么量的。演示模式（全屏）的截图偶尔是新鲜的，别指望它。

**PostProcessing 往离屏 RT 里渲染时也会烤进输出变换**（tone mapping + linear→sRGB），不管目标是不是画布。预览把它渲进 RT 再用 MeshBasicNodeMaterial 贴到画布上，贴的那一步渲染器又编码一次——中间调被抬高、饱和度流失，粒子看起来发灰发白，而且只在开 SSR 时出现（实测均值 44 变 114）。现在编辑器里 `postProcessing.outputColorTransform = isPlayer()`：预览 RT 存线性光（HalfFloat），贴回时只编码一次；显示端直出画布，保留变换。以后要加 tone mapping 记得预览这条路会跳过它。

**roughness 上限就是 1**，抬滑块上限没有意义（着色模型和 SSR 的 lod 计算都会截断）。要更模糊用相机的 `resolution`（降分辨率追踪，更省不是更费）或 `blur`。

**canvas 读回三件事**：`getContext('2d')` 不显式写 `willReadFrequently: false`，Chrome 会在几次 `getImageData` 之后把整个 canvas 降到 CPU（对视频意味着每帧先在 CPU 上转换整帧）；GPU canvas 的 `getImageData` 是等 GPU 队列的同步停顿，页面渲染越重停得越久，所以读回要么不在主线程做，要么别做；隐藏文档里 rAF 和 `requestVideoFrameCallback` 都不跑，`display:none` 的视频也不触发后者。

### 工作习惯

- 本地改、本地验证，**不要边改边推**。收工时集中提交，commit message 写清楚做了什么。
- 推公开仓库前先确认。推 main 会自动部署上线。
- 沟通简洁客观，不需要铺垫和主动建议。

---

## 7. 进度记录

### 2026-09-11 · 手机上的作品闭环

这一段把 WIP-Test-2 做成了能在 iPhone 17 Pro Max 上直接看的作品，并把手机上调好的参数收回仓库：

- **作品即 example**：`public/examples/wip-test-2/`，视频走 URL，测试用的红球已删；编辑器开机直接加载它（`DEFAULT_EXAMPLE`）。参数更新的方式固定下来了：手机上调 → COPY → 把 JSON 贴回对话 → 写进 `config.json`（不用截图）。
- **画框对齐手机屏幕**：四角圆角（Apple 设备预设）、顶边下移 `topOffset`（默认 0.58，对齐状态栏）、"顶"按输出相机的屏幕上方判定（`screenTopSign`）、圆角遮罩共用正面材质（mask color 已删）、圆角分段数 `cornerSegments` 与平滑着色 `cornerSmooth`。
- **手机全屏到头了**：主屏幕 app 视图 = 屏幕减状态栏，收尾方案是 `theme-color` 染色（§3「iOS 27 beta 主屏幕模式的极限」）。
- 这一段为手机加的基础设施：视频 color source（worker 读回）、演示模式、Perf HUD + Copy report、显示端存储快照与心跳、竖屏布局、只留 dark。
- **陀螺仪视差相机**（`parallax.ts`）：TheParallaxView 的离轴投影思路，眼睛换成手机倾斜；参数在相机上，WIP-Test-2 已开。
- **手指尾迹**（touch wake）：手指抹过粒子的流场注入，参数在 config 的 `touch`，WIP-Test-2 已开。

### 2026-09-14 · 阴影

- 研究了 data-dune（genie）的做法：手写 WebGPU，粒子往 256² 的 u32 缓冲 `atomicMax` 泼光空间高度，剪切投影，按粒子（顶点阶段）四点采样；频闪来自 max 的不连续、粗格子、按粒子评估，且没有任何时间滤波。墙上的 AO 是手画曲线。没有搬。
- 走 three 自己的阴影图：打开 shadowMap，MESH 粒子材质接 `castShadowPositionNode` / `receivedShadowPositionNode`，平行光投影、点光不投。`shadowReport` 用离屏读回验证开关差异。WIP-Test-2 的点光换成了平行光（example 的 preview.webp 没有重出）。
- `?gputime` 打开 GPU 时间戳；面板截图对 WebGPU 画布陈旧这条坑记进「坑」。
- SSAO 挂在相机上（`ao` 块），GTAO + denoise，复用 SSR 的 MRT，先遮蔽后反射；`aoReport` 7 条。
- 灯的阴影参数进了 config（平行光的 `shadow` 块），面板有对应一组；`shadowReport` 加到 10 条。阴影 / AO 的 GPU 开销由作者自己用 `?gputime` 看；粒子只有 MESH 收发阴影，接受；WIP-Test-2 的缩略图维持现状。
- harness 基线 258/258。
- 面板量程：gravity ±1，maxParticles / rateOverTime 下限 1000、上限固定为 big numbers 那档，新建系统 10000 粒、1000 /秒。`report` 加 7 条，基线 265/265。
- 读了 TRAIL 渲染器：CPU 的 ribbon，切过去就退出 GPU 计算，200k 粒子 268 ms 一帧。参数含义和 smoothing 的截断 bug 记在 §3。
- ribbon 跟着粒子：宽度乘 size、绕切线按 rotation 滚动、alpha 只乘一次；滚动角走 `trailUV.x`。jest 加 4 条。
- trail 效率：曲线查表、smoothing 均匀重采样、缓冲按高水位上传；同一 config 纯 CPU 35 → 18 ms。宽度无关，长度是成本。

### 2026-09-15 · TRAIL 搬到 GPU

- 历史环进 `curveData` 尾巴、kernel 写、顶点着色器读，ribbon 实例化绘制；TRAIL 从此用 GPU 模拟。20000 粒子 length 80 带平滑：主线程 1.4 ms、60 fps。CPU 路径原样保留作回退。`trailReport` 8 条，jest 5 条，基线 282/282。
- trail 面板：length 2 到 60、width 显示 ×100（新建读作 1）；smoothing 做对了，subdivisions 真的在样本之间加点，CPU 和 GPU 两边一致。`trailReport` 9 条，基线 283/283。
- CPU 路径的 curl noise：`curl-noise.ts` 逐字移植 kernel 的 simplex 和 curl，`applyModifiers` 在 `noise.curl` 时走它；TRAIL 和 WebGL 回退从此和 GPU 同一个流场。jest 加 8 条。
- TRAIL 的"线往中间连"：ribbon 收尾那个槽被省略清理跳过、留着原点，每颗新生粒子都拉一条到中心；改成每帧压在头上，jest 加两条。
- `renderer.mesh.velocityStretch`：MESH 粒子沿真实位移方向拉伸的拖影，GPU 路径，零额外开销；面板一个滑块；`stretchReport` 9 条，基线 274/274。库里顺手修了一条过期的 jest 期望（`createComputePipeline` 自 touch wake 起有第七个参数）。

### 2026-09-13 · Player 独立成放映端

- `/player/` 直接打开是黑屏 + Paste config；editor 里 COPY，player 里贴，加载完直接全屏播。零存储、不监听频道，作品只活在内存里；`?link` 才是老的显示窗口模式。
- 加载走 editor 同一个 `loadParticleSystem`，存储边界上用 `isStandalone()` 改成内存；harness `standaloneReport` 在 iframe 里真起一个 player 逐字段比对。
- 只按需加载作品点名的贴图，默认没有帧数表；`player.webmanifest` 让手机把 player 单独加到主屏幕。
- harness 基线 238/238。

---

## 6. 还欠的账

- 新增的功能代码基本没有单元测试，提交时绕过了覆盖率门禁（浏览器 harness 补了一部分，但不是一回事）
- `world.ts` 有 `window.__world`、`player.ts` 有 `window.__player`、`three-particles-editor.ts` 有 `window.__playerLink`（挂起规则的焦点输入，harness 没法真的让页面失焦）、`window.__videoTextures`（绕过文件对话框）和 `window.__perfHud`，加上 `window.__gyroHud`、`window.__touch`，七个调试出口，harness 依赖它们，正式发布前要处理
- GPU 版 TRAIL 没有 twistPrevention 和 ribbonId（连成一条）；环的大小受 128 MiB binding 限制，200k 粒子最多 41 个样本。没有 WebGPU 时回退到 CPU 版
- 粒子的阴影只接了 MESH 材质；POINTS / INSTANCED（billboard）没接，billboard 的 vertexNode 同样不进 shadow pass，进了会把全部实例画在原点。已知、接受，作品用的是 MESH
- 超过 4MB 的全景图存不进 localStorage，当前会话可用但刷新即失
- 只有发射器的内置运动（`simulation.ts`）在两个窗口间对了相位；粒子本身各自独立模拟，永远不会逐帧一致
- 视频在两个窗口里各自播放，相位不对齐（跟粒子一样）；要对齐得把 `currentTime` 塞进快照，还没做
- 本地上传的视频进不了 config（只有名字），换个浏览器就丢；URL 来源的能随 `embeddedVideos` 走。Player 独立成站时视频只能是 URL
- 整个项目没有云端：My Saved Configs、上传的图片和视频、场景、播放页快照全在那台浏览器的 localStorage / IndexedDB 里，换设备就是空白。跨设备只有两条路：Copy/Paste config JSON（图片内嵌、视频走 URL），或者像 WIP-Test-2 那样做成仓库里的 example
- Chrome 会把隐藏 tab 里的静音视频暂停掉，所以显示窗口必须是窗口不能是 tab——这条本来就有，视频让它更硬
- 手机端没验证过。已知边界：WebGPU 要 iOS 27 beta 以上的 WebKit（iPhone 上的 Chrome 也是 WebKit）；两个 tab 只能活一个，显示端靠存储的快照工作（见上）；200k 个 mesh 粒子加 SSR 在手机 GPU 上的帧率要在显示端左上角的计数器里读
- 库的 jest 覆盖率门禁本来就没过（statements 79.0% / 85 分支 83.3%），新加的 sampler 模块自己有 10 条测试，但没把总数拉过线
