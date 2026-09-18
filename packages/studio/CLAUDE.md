# Particle Tools Studio（packages/studio）

V2 的界面，**2026-09-18 起是这个仓库唯一在开发的界面**（在 main 上；V1 是历史，见根目录 CLAUDE.md）。这份文件的前半是它的**运行说明**和**现状**，后半是 2026-09-14 定案的**架构规划**（原根目录的 V2-ARCHITECTURE.md，2026-09-17 M4 搬到这里，各里程碑的补记都在里面；代码注释里写的 `V2-ARCHITECTURE.md §x` 指的就是本文件后半的那一节）。

## 运行

```bash
cd packages/three-particles && npm run build   # 库先构建
cd ../engine && npm install                    # 引擎的依赖（只为它的 jest）
cd ../studio && npm run dev                    # 5173；先把预设同步进 V1 的 public
```

- 引擎按 `@particle-tools/engine/<module>` 引用（Vite 别名指到 `../engine/src`），只能引 `packages/engine/engine-boundary.json` 里列的模块；`cd packages/engine && npm run check:boundary` 会扫 studio 的每一处引用。
- 开发时 Vite 的 publicDir 是 V1 的 `public`（同源拿到 examples、assets、V1 打好的 player）；生产构建 `npm run build` 是可搬的（`base: './'`，`scripts/copy-shared.mjs` 只拷预设和 favicon）。
- **harness**：只在 dev bundle 里，页面 console 里 `await __st.report()`（58 条：boot、加载条、保存再读回、round-trip、schema 覆盖、live / rebuild 代价、家具、三个编辑器、演示、HUD、预览窗、面板）。真实窗口里跑更可靠，方法见 `packages/editor/CLAUDE.md` 的「验证改动」。
- **加载条**（2026-09-18）：`index.html` 内联的 `#boot-loader`（全屏 `--bg` 底、2px 细条 + 一行当前阶段），第一帧 paint 就在，bundle 到之前靠 CSS 动画爬到 28%；之后 `session.ts` 的每个 boot mark 经 `BootOptions.onBootPhase` 交给 `app/boot-progress.ts`（界面侧，引擎不碰 DOM），内置贴图串行加载那一段按张数走（引擎 `initAssets` 的 `onProgress`）；`first-frame` 填满、350 ms 淡出、移除。用 `transform: scaleX`，主线程被占住时合成器照样推进。boot 抛错时标签改成失败提示。
- 调试口：`window.__studio`（doc / serialize / load / rebuild / getFrames …）、`__world`、`__touch`、`__perfHud`、`__gyroHud`。
- 线上：<https://caoyuxistudio.github.io/Particle-tools/Studio/>，推 main 就部署（`deploy.yml` 在同一次 checkout 里先构建 V1、再构建这个包，把 `dist` 放到 `packages/editor/public/Studio/`；小写 `/studio/` 转发）。推之前本地 `npm run build` 一遍。

## 结构

```
src/
├ engine/session.ts    唯一碰引擎的胶水：boot、applyChange（按 schema 的 change 等级）、帧循环、HUD / 演示 / 手指的安装
├ engine/furniture.ts  家具跟着文档走：碰撞面 / 力场 / 形状 / 坐标轴 / 色源 debug 平面
├ engine/scene-decor.ts 场景物体的编辑器装饰：结构线、相机机身、灯、太阳箭头
├ store/document.svelte.ts  单一真相：get / patch / touched / load / serialize，rev 驱动刷新
├ inspector/           schema 的渲染器（Column 四个 tab：particles / scene / pieces / textures）
├ scene/               V1 Scene 面板的移植
├ library/             pieces（examples + 本地保存）和 textures（色源库）
├ editors/             三个 canvas 编辑器的预埋 DOM、样式、打开它们的包装
├ viewport/            视口格子、家具工具栏、reset view
└ ui/                  tokens.css、reset.css、hud.css —— 全部样式
```

## 现状与下一步（2026-09-18）

M0–M4 都完成了（判据和每步的补记在 §6）。时间线：2026-09-17 M0 边界 → M1 schema → M2 壳与检视器 → M3 对等 → M4 引擎搬进 `packages/engine`、预设随包、文档按包拆；同日上线到 `/Studio/`、仓库改名 Particle-tools、产品名 Particle Tools Studio；2026-09-18 v2 合进 main，从此只有 main 一条线，**默认开发都在这个包和 `packages/engine`**。harness `__st.report()` 55 条（含加载条和本地保存的读回，2026-09-18）、引擎 jest 23 条、边界 0 违规、V1 的真实窗口套件 371/372（差的那条是预览宽度，V1 main 上一样）。

**没做、记着的**（从 §6 各处汇总）：
- Player 显示窗口（V1 的 linked 模式，`player-window.ts`）没接；桌面上一边调一边看的路只有演示模式。
- 子发射器的 config 还是 `hidden`（开放问题 3 未定）。
- Helper 里 `useLiveUpdate` / `enableBigNumbers` / `useIndividualUpdate` 三个 V1 专属开关渲染了但不起作用。
- 手机：760px 以下的单列布局只在浏览器的手机模拟里看过；iPhone 真机、主屏幕模式、theme-color 没验。
- 预览窗的语义作者没定：现在拖边缘改大小、拖内部移动，没有把手。
- 账号与云端作品库（§8 补记的 BaaS 方向）没开始；`saved-configs.ts` 是要换的那一层。
- 弹墙的手感作者还不满意（V1 记录「还欠的账」第一条），是引擎的事，改了两边都受益。

**V1 从此怎么对待**：不看、不改，除非作者点名。V1 的 player 还在用（iOS 壳、`/player/`），它 import 的就是引擎，改引擎时 `npm run check:boundary` 会顺带查它。

---

# V2 架构规划（讨论稿）

状态：**讨论稿**，2026-09-14。目的是把 V2 的边界、合同和顺序定下来，不是实施说明。定案后本文搬进 V2 的包里做它的 CLAUDE.md。

读这份之前默认你读过根目录的 CLAUDE.md（V1 的交接说明）。

### 已确认与待定（2026-09-14）

**已确认（曹雨西）**
- 两条线：引擎继续在 V1 里研究（另一个会话推进），界面另起 V2；V2 复用同一份引擎。
- 引擎研究成熟后连同调好的默认参数和预设，整体封装成可引用的库，架进引擎层。
- V2 先按 genie（data-dune.vercel.app）那种界面的样子搭，但架构要保证以后能换成别的界面或自研界面。
- 每次更新有记录：CHANGELOG 按包，叙事进度写 CLAUDE.md。

**建议，待确认（本会话提出）**
- 引擎边界现在就定，不等引擎"完善"（§1）。
- Schema 归引擎、配覆盖测试（§2.2）。
- 学 genie 的约束，不用它的代码（§4）。

**待定**
- V2 框架：Svelte 5 / SolidJS / React 19，见附录 C。推荐 Svelte 5 或 Solid，二者是风格选择；React 是三者中唯一和这套设计较劲的。

---

## 0. 两条线

| 线 | 范围 | 在哪 | 谁推 |
|---|---|---|---|
| **V1 引擎线** | 粒子库、world、scene-objects、画框、SSR、视差、手指尾迹、player、预设参数 | `packages/three-particles`、`packages/editor/src/js/three-particles-editor/*`、`src/player.ts` | 另一个会话 |
| **V2 界面线** | 新的编辑器应用：布局、面板、控件、状态、样式 | 新包 `packages/studio` | 本会话 |

两条线共享同一份**引擎**和同一份**作品格式**。V1 的编辑器界面（Svelte + SMUI + lil-gui 那一套）在 V2 达到对等之前保留，之后降级为实验台或删除。

为什么这样分是成立的：`src/player.ts` 今天已经在没有 Svelte、SMUI、lil-gui 的情况下完整放映作品，它 import 的那十几个模块就是引擎。引擎无 UI 不是目标，是既成事实；V2 要做的是别把它弄脏。

---

## 1. 引擎边界：现在就定，不等"完善"

原方案是等引擎研究完善后再封装成库。这一步应当**提前到现在**，理由有三：

1. 引擎研究没有"完善"的那天。V2 若等它，永远没有起点。
2. 边界不写下来，V1 线会继续把 DOM 漏进引擎（今天已有一处，见 1.2）。写下来之后两条线都有了可检查的规则。
3. 定边界不需要搬文件。第一步只是一份**允许清单**和一个路径别名，V1 线的文件路径一个都不变，不会和它冲突。物理搬进 `packages/engine` 留到 V1 编辑器退役时做。

### 1.1 边界的下界 = player 今天 import 的模块

```
packages/editor/src/js/three-particles-editor/
  world.ts            渲染器、编辑器相机、预览 RT、SSR、演示直出、环境光
  scene-objects.ts    场景物体模型 + 手柄 + 画框几何 + 输出相机同步
  particle-factory.ts config → 粒子系统
  simulation.ts       发射器内置运动
  parallax.ts         陀螺仪视差
  touch-input.ts      指针 → 发射面 → 尾迹样本
  save-and-load.ts    loadParticleSystem / serializeConfig（legacy 转换、默认值、deepMerge）
  config-converter.ts
  texture-config.ts   贴图注册
  video-textures.ts   视频 color source 的注册与存储
  assets.ts
  runtime-mode.ts     isStandalone / isPlayer 的存储边界开关
  gpu-support.ts      prepareParticleBackend
  player-link.ts      BroadcastChannel 协议（linked 模式）
  perf-hud.ts         ┐ 无框架的运行时 HUD：player 和 studio 共用，
  gyro-hud.ts         ┘ 属于"运行时界面"，不属于编辑器界面
```

再加上 player 不需要、但属于引擎而非界面的**编辑器家具**：

```
  editor-layers.ts, *-helper.ts, *-interaction.ts   手柄、力场 / 碰撞面的可视化与拖拽
  curve-editor/、gradient-editor/、texture-selector/  三个 canvas 编辑器的绘制与数学部分
  presentation.ts                                     演示模式的状态机（它建的 DOM 条要拆到界面侧）
```

V2 只允许从这个清单 import。用一个脚本（或 eslint `no-restricted-imports`）把清单固定下来，CI 跑。

### 1.2 引擎里要修的漏点

只有一处真正的反向依赖：`world.ts` 第 999 到 1012 行查 DOM 里 `.right-panel`、`.panel-content`、`.right-panel .lil-gui.root` 来算空闲视口。改成 **由外部注入边界提供者**：

```ts
setViewportInsets(fn: () => { left: number; right: number; top: number })
```

V1 的 content.svelte 注入它今天的查法，V2 的 viewport 格子注入自己的。其余的 `document.` 都是运行时该有的：挂 canvas、safe-area 探针、theme-color、截图下载。stats 挂到 `.stats` 那处也改成注入容器。

**2026-09-17 补记（M0 第一步做完时发现的）**：上面说"只有一处"是按 DOM 查法数的。按 **import 图**数，引擎里还有三处反向引用，允许清单脚本第一次跑就报出来了，已修：

| 漏点 | 是什么 | 修法 |
|---|---|---|
| `save-and-load.ts` → `../stores/snackbar-store`、`presentation.ts` → 同上 | 引擎直接调 Svelte store 弹 snackbar；player 因此把 `svelte/store` 打进了 bundle | 新文件 `notify.ts`：`setNotifier({ info, success, error, legacyConfig })` 由界面注入，引擎只调 `notify.*`，没注入就是空操作。V1 在胶水 `three-particles-editor.ts` 顶部注入 snackbar 和 legacy modal；player 不注入 |
| `save-and-load.ts` → `./showLegacyConfigModal`（一个 `writable<boolean>`） | 引擎自己持有一个 Svelte store 来开模态框 | 走同一个 notifier 的 `legacyConfig()`；store 文件搬到界面侧 `src/js/stores/legacy-config-modal-store.ts` |
| `particle-factory.ts` → `./entries/mesh-entries`（lil-gui 那一层） | 只为了拿 `createGeometry`，但那个文件 `import type { GUI }` | 几何目录抽成 `mesh-geometry.ts`（引擎），`mesh-entries` 从它 import 并 re-export |

允许清单本身是 `packages/editor/engine-boundary.json`（`engine` 模块清单、`externals` 只有 three 和 @newkrok、`roots` 是 `src/player.ts`），检查脚本 `scripts/check-engine-boundary.mjs`（`npm run check:boundary`，零依赖），两条规则：引擎模块只能 import 引擎模块和 externals；root 的整个 import 图不能走出引擎。`.github/workflows/ci.yml` 在所有分支上跑它和编辑器的 jest。现在 34 个引擎模块、player 触及 20 个、0 违规。**V2 加任何东西进引擎清单，改这份 JSON。**

### 1.3 引擎必须提供、今天没有的三份约定

这三件是 3D 编辑器里界面和引擎真正咬合的地方，V1 靠巧合或轮询糊过去了，V2 要写成接口：

**a. 变更通知（引擎 → 界面）。** 手柄拖拽、相机同步、烘焙完成都会改 config 或场景对象。Scene 已有 `setOnSceneChanged` / `watchScene`，粒子 config 没有，lil-gui 靠 140 个 `.listen()` 每帧轮询。V2 要求引擎在改了 document 之后**发事件**（带路径），界面订阅，不轮询。

**b. 视口边界（界面 → 引擎）。** 见 1.2。V1 是画布整窗、面板浮在上面；genie 是 grid 里的一个格子。两种布局都通过同一个注入口告诉引擎"哪块是画面"。

**c. 指针归属。** 画布上的 orbit、手柄、手指尾迹三套监听都在 canvas 元素上。规则：**只有 canvas 收指针，面板是它的兄弟节点不是父节点**，浮层用 `pointer-events: none` 除非自己是控件。演示模式和 player 里没有手柄，touch-input 才生效（V1 已是这样）。

**2026-09-17 补记（M0 做完时的实际接口）**：

- **a. 变更通知**落成 `document-events.ts`：`watchDocument(fn) → unsubscribe`、`emitDocumentChange(change)`。事件两种：`{ scope: 'scene', id, keys, source }`（source 是 gizmo / update / add / remove / load / bake；整场景替换时 id 为 null、keys 为 `['*']`）和 `{ scope: 'particle', path, source: 'gizmo' }`（path 是 config 里的点路径，如 `forceFields.2.position`、`collisionPlanes.0.position`、`particleColorInstance.offset`）。发的地方：scene-objects 的手柄拖拽、`updateSceneObject`、add / duplicate / remove / replace、探针烘焙；力场、碰撞面、色源 debug 平面三个手柄的拖拽。V1 的胶水把 `watchDocument` 挂在 `window.editor` 上但自己不订阅（lil-gui 照旧轮询）；harness 的 gizmoReport 和 colorInstanceReport 各断言一次拖拽真的发出带路径的事件。**没有的**：面板改滑块不发事件（那是界面自己做的改动，V2 的 store 就是发起方）；相机同步（`syncOutputCamera`）只把相机物体的设置推进渲染器，不改 document，所以不发。
- **b. 视口边界**落成 `world.ts` 的 `setViewportInsets((canvasRect) => ({ left, right, top })) → previous`（返回上一个 provider 便于还原；传 null 回到"整个画布"的默认）。V1 的 provider 在胶水 `three-particles-editor.ts` 顶部，就是原来那段查 `.panel-content` / `.right-panel` / lil-gui 高度的逻辑原样搬过去；player 不注入。同一批：`setStatsContainer(el)` 让帧计数器的挂点由界面在 `createWorld` 前给，引擎不再查 `.stats`。`world.ts` 里剩下的 `document.` 全是运行时的（挂 canvas、safe-area 探针、theme-color、截图）。

---

## 2. 三份合同

V2 不是"再写一个界面"，是把三样今天不存在或散落的东西写成数据。界面只是这三样东西的渲染。

### 2.1 Document：作品格式，一字不改

就是今天 COPY 出来的 JSON：粒子 config + `_editorData`（`sceneObjects`、`textureId`、`colorInstanceTextureId`、`metadata`、`simulation`、`embeddedTextures`、`embeddedVideos`、`showForceFields`、`showCollisionPlanes`、`terrain`、`useLiveUpdate`、`enableBigNumbers`、`useIndividualUpdate`、`showWorldAxes`）。

这是 V1、V2、player 三者互通的**唯一**保证，也是 V2 的验收标准：

```
V2 serialize(doc) → V1 window.editor.load → V1 serialize → 逐字段相等
V2 serialize(doc) → standalone player 贴入 → player serialize → 逐字段相等
```

第二条今天的 harness `standaloneReport` 已经在做，V2 复用同一套。

### 2.2 Schema：参数表，从代码变成数据（V2 最大的一块工作）

今天"有哪些参数、范围多少、分在哪组、改了要不要重建"只存在于 4169 行 lil-gui 调用的执行顺序里。V2 把它写成一棵数据：

```ts
type Field = {
  path: string;                       // 'emission.rateOverTime'
  kind: 'number' | 'int' | 'bool' | 'enum' | 'color' | 'vec2' | 'vec3'
      | 'minmax' | 'constant|random|curve' | 'gradient' | 'texture' | 'list';
  min?, max?, step?, options?;
  label: string; hint?: string;
  when?: (doc) => boolean;            // 显隐条件，如 renderer.mode === 'MESH'
  change: 'live' | 'rebuild' | 'structural';   // 见下
  item?: Group;                       // kind === 'list' 时每一项的子表（burst、力场、碰撞面、子发射器）
};
type Group = { id: string; label: string; fields: Field[]; groups?: Group[] };
```

`change` 三级对应今天 glue 里 `recreateParticleSystem` 的三条路：`live` 走 `particleSystem.updateConfig(partial)`；`rebuild` 重建粒子系统；`structural` 是烤进 GPU kernel 的开关（`touch.isActive`、力场从 0 到 1、曲线激活等），重建且要重编译。今天这个判断散在 glue 里，V2 把它挪到 schema 上，引擎只管执行。

**归属：schema 属于引擎**（它描述的是引擎吃的 config），放在引擎允许清单里，界面只读。

**覆盖测试**：默认 config 里出现的每个键，schema 里必须有对应字段，反之亦然。这条测试是两条线并行期间防漂移的唯一机械手段：V1 线加了新字段忘了补 schema，CI 直接红。

**2026-09-17 补记（M1 做完时的实际形状）**：表在 `packages/editor/src/js/three-particles-editor/schema.ts`（引擎清单里），21 个顶层 group 按 V1 面板顺序，170 条路径。抽取的方法不是手抄：在真实窗口里用 `window.editor.getPanel().controllersRecursive()` 把 V1 的 lil-gui 树整个导出（每个 controller 的对象身份反查到 config 路径、min / max / step / options），再补上 WIP-Test-2 里没露出来的条件分支（各形状的子组、力场的 POINT / DIRECTIONAL、帧动画的 FPS、TRAIL / MESH 两组、burst 和子发射器的项）。`kind` 比原设想多了两种：`value`（Constant | { min, max }，`allowCurve` 时还可以是曲线——V1 面板一律展开成 min / max，库的默认值是常数，两种表示在文档里都合法）和 `hidden`（在文档里但没有控件：`map`、`renderer.mesh.geometry`、`particleColorInstance.map` 三个运行时对象，以及 `_editorData` 里 Scene 面板、两个渐变编辑器、贴图注册表各自拥有的块）。`when` 挂在 group 或 field 上（形状子组、Trail / Mesh 组、fps、力场按类型）。`displayScale` 只有 trail width 用（存世界单位，显示 ×100）。另外表里带着 `editorAdditions()` / `documentDefaults()`：库默认值之上编辑器补的那些键（rendererType 'POINTS'、blending 的字符串形式、mesh 和 trail 的默认、`sampleSize`、`_editorData` 的开关），这样 node 里不开面板也能造出一份完整文档。

**覆盖测试两层**：jest `__tests__/schema.test.ts` 7 条（库默认 config 的每个叶子有字段、`documentDefaults()` 的每个叶子有字段、每个字段在默认值里解析得到、路径唯一、量程 / 选项 / 列表项齐全、按下标能找到列表项字段、三级 change 都在用）——编辑器的 jest 从此以 ESM 跑（`NODE_OPTIONS=--experimental-vm-modules`，并把 `@newkrok/three-particles` 按路径映射，因为它只导出 `import` 条件）；harness `schemaReport` 9 条，在真实窗口里 `createNew()` 一个系统后：活文档的每个叶子有字段、每个可见字段解析得到、`documentDefaults()` 和编辑器真的造出来的文档逐叶子相等（`value` 字段的常数和 min / max 视为同一个值）、**V1 的 128 个 controller 逐个和它路径上的字段比 kind / min / max / step / options**、烤进 kernel 的开关是 structural、updateConfig 能吃的键是 live。**这两层就是 §7 那条规则的机械化：V1 线加了字段没补表，jest 或 schemaReport 必红。**

抽取时发现的、文档格式里本来就有的事实：`renderer.blending` 在文档里是字符串（`'THREE.NormalBlending'`，V1 面板写的），库的默认是数字 1，两种都吃；`shape.rectangle.rotation` 库里是三维、V1 只给 x / y；V1 的力场和碰撞面 entries 把四个函数（`_recreateParticleSystem` 等）挂在 config 对象上，不进 JSON 但活文档里有，报告里按"函数不是文档数据"跳过；`particleColorInstance.sampleSize` 是编辑器补的键，库默认里没有；`_editorData.trailGradientStops` 只在 trail 的渐变编辑器打开过之后才出现（全套 harness 跑完 trailReport 之后 schemaReport 才报出来的）。

**来源**：从 `entries/*.ts` 逐文件抄。难点已知：四个动态列表（burst、力场、碰撞面、子发射器，代码里查 `domElement.parentNode` 的就是它们）和 `entry-helpers-v2` 里 Constant / Random / Curve 三态切换的 helper。三个 canvas 编辑器（曲线、渐变、贴图）在 schema 里只是 `kind`，渲染时打开对应编辑器。

### 2.3 Tokens：一份样式变量

一份 `tokens.css`，是**全部**视觉决定的所在地。V1 的样式散在五处（smui-dark.css、lil-gui 自带、组件内 `<style>` 1485 行、global.css、TS 里的 inline style），换皮等于在五处打架。V2 里任何颜色、字号、间距只能引用 token。genie 那种样子就是这份文件的第一个取值。

---

## 3. V2 应用结构

```
packages/studio/
├ src/
│ ├ app/          壳：布局 grid、模式切换（studio / present）、启动加载默认 example
│ ├ store/        document store：单一真相
│ │                ├ patch(path, value)  → 引擎按 schema 的 change 级别执行
│ │                └ 订阅引擎变更事件      → 更新 store → 界面刷新
│ ├ viewport/     canvas 格子：挂引擎、注入视口边界、指针只归它
│ ├ inspector/    Schema → 控件树的渲染器（全项目唯一读 schema 的地方）
│ ├ scene/        Scene 面板（V1 的 scene.svelte / scene-item.svelte 形状已对，移植）
│ ├ editors/      曲线 / 渐变 / 贴图选择器：给 V1 的 canvas 编辑器包一层，不重写
│ ├ ui/           原生控件的薄封装（range+number、select、details、按钮）+ tokens.css
│ └ present/      演示模式与 HUD 的界面侧（状态机在引擎的 presentation.ts）
├ public/         index.html、examples（与 V1 共享或软链）
└ __ai-test.js    harness：round-trip、schema 覆盖、视口边界、指针归属
```

数据流单向：

```
 指针 / 键盘 ──► inspector / scene 面板 ──► store.patch(path, value)
                                                │
                                   schema.change 级别决定
                                                ▼
                                    engine.apply(live | rebuild | structural)
                                                │
 手柄拖拽 / 相机同步 / 烘焙 ──► engine 发变更事件（路径）──► store ──► 界面刷新
```

对比 V1：一个 config 对象被 lil-gui、手柄、load、转换器四方就地修改，无人通知，界面轮询。V2 里 **只有 store 能改 document**，引擎改了东西必须通过事件回到 store。

---

## 4. 视觉约束：学 genie 的规则，不用它的代码

genie（data-dune.vercel.app）**不是库**，是别人的应用，它的 CSS 文件不能拿来用。能拿的是它的约束，全部写进 tokens 和 `ui/`：

- 一种字体（等宽），根字号 11px，正文四档 8 / 9 / 10 / 11px，一个字重。层级靠大小写、字距和灰度，不靠粗细。
- 纯灰阶：底、面板、分割线、次要字、常规字、强调六级。作品是画面里唯一有颜色的东西。
- 没有圆角、阴影、渐变。分区全部 1px 实线。
- 全部原生控件：`<details>/<summary>` 做折叠组，`<input type=range>` 配一个 `type=number`，`<select>`、`<input type=checkbox>` 用 `accent-color` 染色，Tab 和开关态用 `button[aria-pressed]`。**不引入组件库。**
- 图标一套线性图标（lucide 有 svelte 和 react 两个包）。
- 布局两层 grid：外层 顶栏 / 工作区 / 底栏，内层 画布 / 检视器（固定宽）。窄屏改单列，检视器限高可滚。
- 一份全局 reset 定义 button / input / select 长什么样，之后所有面板不再写控件样式。

这些约束是"整体感"的来源，也是换皮便宜的前提。以后换别的样子改的是 tokens 的取值和 `ui/` 里几十行，不动 inspector、scene、store。

---

## 5. 技术选型（决策点）

| 项 | 推荐 | 备选 | 理由 |
|---|---|---|---|
| 构建 | **Vite** | 沿用 rollup | V1 的 rollup dev 改了不刷新页面，是日常痛点；V2 是新包，没有迁移成本 |
| 框架 | **Svelte 5（runes）** | SolidJS（同一信号模型，写 JSX）；React 19 | Scene 面板 1151 行已是对的形状，Svelte 下近乎原样移植；仓库工具链现成；runes 的细粒度更新适合手柄拖拽每秒几十次进 store 的场景。React 的好处是和 genie 一比一、生态更大，代价是零复用 |
| 组件库 | **不用** | | 见 §4，原生控件够用；三个 canvas 编辑器本来就是无框架的 |
| 图标 | lucide | | |
| 语言 | TypeScript | | schema 和 store 的类型是这套架构的骨头 |

框架这一项需要你拍板。其余按推荐走。

---

## 6. 里程碑与完成判据

每一步都有可机械验证的判据，没有判据的不算完成。

**M0 · 边界**（引擎线配合，改动小）
- ✅ 允许清单脚本进 CI，`player.ts` 通过。（2026-09-17，v2 分支）
- ✅ `world.ts` 的视口边界改为注入，V1 注入今天的查法，harness 不变。（2026-09-17）
- ✅ 引擎新增 config 变更事件（手柄拖 transform、相机同步至少接上）。（2026-09-17，见 §1.3 补记）

**M1 · Schema**
- ✅ `schema.ts` 覆盖默认 config 的全部键，覆盖测试绿。（2026-09-17，见 §2.2 的补记）
- ✅ 三级 `change` 标注完成，与 glue 今天的判断一致（拿 V1 的行为做对照）。（同日；harness 抽查烤进 kernel 的 13 个开关是 structural、6 个 updateConfig 能吃的键是 live）

**M2 · 壳与检视器**
- ✅ `packages/studio` 用 Vite 起来，加载 **example-1-1**（作者 2026-09-17 定的作品，不再是 WIP-Test-2），画面与 V1 一致（同一个引擎、同一份文档；人眼看过）。
- ✅ inspector 从 schema 渲染全部分组，原生控件（`range` + `number` 成对、`select`、`checkbox`、`color`、`details` 折叠；曲线 / 渐变 / 贴图选择器三个编辑器留到 M3，先显示占位）。
- ✅ Scene 面板移植完成（V1 的两个 .svelte 原样搬，SMUI 图标换成字形、svrollbar 换成原生滚动、颜色换成 token）。
- ✅ COPY 出的 JSON 通过 §2.1 两条 round-trip（studio 的 harness `__st.report()`：serialize() 与 V1 写出的 example 文件逐字段相等；同源 iframe 里起一个 standalone player 贴进去再序列化回来逐字段相等）。

**2026-09-17 补记（M2 第一刀的实际形状，`packages/studio`）**：Vite 8 + Svelte 5（runes）+ TypeScript，无组件库。`vite.config.ts` 的三件事：`@engine` 别名指到 `packages/editor/src/js/three-particles-editor`（引擎就地引用，不搬文件；`check-engine-boundary.mjs` 第三条规则扫 studio 的每个 `@engine/…` 引用必须在清单里，直接引 V1 路径也报）；`publicDir` 指到 V1 的 `public`（examples、assets、视频、V1 打好的 player bundle 全部同源可用——开放问题 2 的答案：既不软链也不复制，直接共用）；裸 `three` 别名成 `three/webgpu` 且 `dedupe`（V1 rollup 的 dedupeThree 在 Vite 里的等价物，否则引擎、库、studio 三份 three）。

结构照 §3：`engine/session.ts` 是唯一碰引擎的胶水（boot：backend → world → assets → scene → 作品 → compileAsync → 帧循环，照 player.ts 而不是 V1 glue；`applyChange(path)` 按 `fieldAt(path).change` 决定 updateConfig 还是重建，两条路各自 100 ms 节流、live 的首末必到），`store/document.svelte.ts` 是单一真相（文档对象本身是引擎的、loader 就地合并，所以不做深层代理：每次 patch 或引擎事件 `rev += 1`，控件通过 `get(path)` 读、`patch(path, value)` 写），`inspector/` 只读 schema（Column 有 particles / scene 两个 tab），`scene/` 是移植的面板，`ui/tokens.css` + `reset.css` 是全部样式。**画布不在格子里**：引擎照旧把 canvas 铺满窗口、放在 `.studio` 之下，viewport 的格子量自己的矩形注入 `setViewportInsets`——§1.3b 说的"两种布局同一个注入口"，这就是第二种。harness 只进 dev bundle（`main.ts` 里 `import.meta.env.DEV` 才 import `harness.ts`）。

家具（碰撞面 / 力场 / 形状 / 坐标轴 / 色源 debug 平面）在 `engine/furniture.ts`：跟着文档走，store 改到相关路径就 `syncFurniture()`，debug 平面每帧 `syncFurnitureFrame()`；手柄拖动写回文档、按 live 走。这是 V1 里 entries 的副作用，V2 里是文档的投影。

M2 第一刀查出的两个 V1 bug：`serializeConfig` 的碰撞面 reducer 漏了 `touchCap` / `maxSpeed`（COPY 一直在丢，example-1-1 里有是因为手写进去的；studio 的 round-trip 第一次跑就报出来，已在 main 修并合回）；Vite 对 `./player/` 这种目录地址回退成 SPA 的 index，iframe 要写 `./player/index.html`。

**M3 · 对等**
- ✅ 三个 canvas 编辑器接上；演示模式、Perf / Gyro HUD、手指尾迹、视差在 studio 里可用。（2026-09-17）
- ◐ 手机上跑一遍：竖屏布局做了（760px 以下单列，检视器在画布下面占 45svh，浏览器的手机模拟里看过）；studio 2026-09-17 已上线，主屏幕模式和 theme-color 在 iPhone 上还没验。
- ✅ studio 自己的 harness 覆盖 M0 到 M3 的判据（`__st.report()` 29 条）。

**2026-09-17 补记（M3 的实际形状）**：开放问题 4 的答案是"studio 预埋同样的 DOM"——`editors/Modals.svelte` 是 V1 content.svelte 里三个模态框的原样拷贝（只把 Material 的搜索图标换成字形），`editors/editors.css` 是 V1 global.css 里那 676 行编辑器样式按亮度映射成 token（无圆角、无阴影）加 presenting 规则；三个编辑器自己的代码一行没动。`editors/open.ts` 是打开它们的三个薄包装：曲线编辑器直接改文档里那个 LifetimeCurve 对象、回调里 `store.touched(path)`；渐变编辑器的 stops 存 `_editorData.gradientStops`、用引擎的 `gradientToBezierCurves` 写回 `colorOverLifetime.r/g/b` 并把 isActive 打开（和 V1 的 entries 一样，只是那段逻辑从 entries 搬进了 studio，因为 `updateBeziersFromGradient` 在 entries 里不在引擎里）；贴图选择器分 sprite（写 `_editorData.textureId`、`map`、帧动画 tiles）和色源（写 `colorInstanceTextureId`、`particleColorInstance.map`）两种。演示模式、Perf HUD、Gyro 面板、手指输入全部是引擎模块，`session.ts` 的 `installInstruments()` 照 V1 glue 的那段接线安装（Perf 的 actions 里粒子预算的算法原样），帧循环在 `isPresenting()` 时走 `renderPlayer`；presenting 的 CSS 是 `body.presenting .studio { display: none }` + 画布容器居中，帧计数器为此从格子挪到了 app 一级（`#studio-stats`，固定定位）。顶栏多了 perf / gyro / present 三个按钮，键盘 P / G / Esc 照 V1。

**没做、记着的**：Player 显示窗口（`player-window.ts`，V1 的 linked 模式）没接——桌面上一边调一边看的那条路 studio 还没有，演示模式够用；子发射器的 config 还是 `hidden`（开放问题 3 未定）；Helper 里 `useLiveUpdate` / `enableBigNumbers` / `useIndividualUpdate` 三个 V1 专属开关渲染了但不起作用（studio 按 schema 的 change 走，不看它们）。

**M4 · 收口**（2026-09-17 完成）
- ✅ V1 编辑器**保留原样、继续在线上根路径**（作者定的：V1 永远可访问、可用、可调），不删；2026-09-18 起是历史，不看不改。
- ✅ 引擎模块物理搬进 `packages/engine`（`src/`、`__tests__/`、`engine-boundary.json`、边界脚本），预设随包（`presets/examples`、`presets/assets`；`scripts/sync-presets.mjs` 在 V1 和 studio 的 dev / build 前拷进各自的 public，拷贝 gitignore）。两边都按 `@particle-tools/engine/<module>` 引用（rollup / Vite 别名指到 `../engine/src`，three 和 @newkrok 包 dedupe 到各自的 node_modules）。
- ✅ 每个包一份 CHANGELOG（engine、studio 新建）；根 CLAUDE.md 只留导航，V1 的记录搬到 `packages/editor/CLAUDE.md`，本规划搬到这里。
- ✅ 上线（同日）：`deploy.yml` 把 studio 的构建放到 `public/Studio/`，小写 `/studio/` 转发；仓库改名 Particle-tools（GitHub 只转发 git 地址，旧的 Pages 地址 404；iOS 壳的地址已改、要重新构建）。
- ✅ 2026-09-18 v2 合进 main（fast-forward），`deploy.yml` 改成从同一次 checkout 构建 V1 和 studio；v2 分支停用。

---

## 7. 两条线并行期间的规则

- **引擎模块里不得出现 DOM / 框架依赖。** 需要界面配合的地方走注入或事件（§1.3）。允许清单脚本会报。
- **加 config 字段必须同时补 schema。** 覆盖测试会报。在 M1 之前，V1 线加字段时在 commit message 里标 `schema:` 让 V2 线跟进。
- **作品格式不改。** 要改也是引擎线改 `save-and-load` 的转换，两边同时生效。
- V1 编辑器在 M3 之前不做界面层的重构，只修 bug；避免两边同时动同一批文件。**2026-09-18 起**：只有 main 一条线，V1 的编辑器不看不改，两条线并行期的规则到此为止；引擎的规则（边界、schema）继续。
- CHANGELOG：每个包一份（three-particles 和 editor 已有，semantic-release 生成；studio 建包时建）。叙事性的进度记录继续写在 CLAUDE.md。

---

## 8. 明确不做

- 不做云端存储（V2 的里程碑内）。My Saved Configs、贴图、视频仍在浏览器本地；跨设备靠 JSON 和仓库里的 example。**2026-09-17 补：作者提出以后要账号和云端**（每人自己的作品库，像在线软件）。方向定为 BaaS（Supabase 一类：Postgres + 登录 + 对象存储 + 行级权限），前端仍是 GitHub Pages 上的静态站，只换存储适配层——`saved-configs.ts` 的读写和资产的 URL 化就是为此留的口。M4 之后再做。
- 不在 V2 里重写三个 canvas 编辑器和任何引擎逻辑。
- 不引入 UI 组件库、CSS 框架、状态管理库。store 是几十行手写的。
- 不把 V1 编辑器的 lil-gui 改成读 schema。V1 保持原样直到退役，避免双份重构。

## 9. 开放问题

1. 框架：Svelte 5、SolidJS 还是 React 19（§5、附录 C）。**→ Svelte 5（runes），M2 定。**
2. `packages/studio` 与 V1 editor 共用 `public/examples` 和 `assets`，软链还是构建时复制。**→ 都不是：预设归引擎（`packages/engine/presets`），`sync-presets.mjs` 拷进各前端的 public；开发时 Vite 的 publicDir 另指 V1 的 public 拿 player bundle，M4 定。**
3. 子发射器（sub-emitter）在 V1 里是"切进去编辑一个子 config"的模式，V2 用同一模式还是并列显示。**→ 未定，config 先 `hidden`。**
4. 三个 canvas 编辑器今天依赖 content.svelte 预埋的 DOM，包一层时是让它们自己建 DOM（改引擎侧文件）还是 studio 预埋同样结构（不改）。**→ studio 预埋同样的 DOM（`editors/Modals.svelte`），M3 定。**

---

# 附录：本次研究的比对材料（2026-09-14）

以下是定这份规划时做的几项比对，数字都是当天量的，方法写在各节里，以后要复核照着再跑一遍。

## A. genie（data-dune.vercel.app）的技术栈

从线上打包产物反推（下载 `index-*.js`、`App-*.js`、`Gallery-*.js`、`index-*.css` 逐项 grep，再在浏览器里查 DOM）。

| 层 | 用的什么 | 证据 |
|---|---|---|
| 框架 | React 19.2.4 + Vite | `<div id="root">`、`assets/index-<hash>.js`、`__reactContainer`、App / Gallery 两个懒加载 chunk |
| 样式 | 一份手写 CSS，19 KB，格式化后约 1400 行 | 类名全是语义名（`.inspector` `.control-group` `.studio-control` `.look-card`）；没有 Tailwind、CSS Modules、CSS-in-JS；几乎没有 CSS 变量（只有 JS 写的 `--art-aspect`） |
| 组件库 | 无 | 没有 Radix / shadcn / MUI / Headless UI 的痕迹 |
| 图标 | lucide-react | 页面上 540 个 `svg.lucide`，stroke 2，15 到 18 px |
| 控件 | 全部原生 | `<details>` 折叠组 24 个；`<input type=range>` 152 个，每个配一个 `type=number`；`<select>` 26；checkbox 9，`accent-color` 染色；Tab 和开关态 `button[aria-pressed]` 400 处 |
| 渲染 | 裸 WebGPU + WGSL，无 three.js | canvas 是 `webgpu` 上下文；App chunk 里 40 个 `@compute`、14 个 `@vertex`、10 个 `@fragment` |
| 导出 | WebCodecs `VideoEncoder` | MP4 逐帧渲染导出 |

视觉规则（整体感的来源）：

- 一种字体 JetBrains Mono；根字号 11px；正文 8 / 9 / 10 / 11px 四档（CSS 里出现 21 / 20 / 16 / 7 次）；标题也是 11px、字重 400。层级靠大小写、字距、灰度。
- 纯灰阶：`#080808` 底、`#111` 面板、`#333` 分割线、`#777` 次要字、`#bbb` 常规、`#eee` / `#fff` 强调。唯一彩色 `#7cf` 出现 3 次。
- 无圆角、无阴影、无渐变，分区全部 1px 实线。按钮默认透明加 1px 边框，hover 换底，pressed 反色。
- 一份全局 reset 定义 button / input / select，此后面板不写控件样式。
- 布局：外层 grid `48px / 1fr / 29px`，内层 `1fr / 340px`；画布宽 `min(100%, calc((100svh - 210px) * aspect))`；760px 以下单列，检视器限高 65svh 可滚。

## B. V1 与 genie 的界面架构对照

```
genie
┌──────────────────────────────────────────────────────┐
│ React 19 组件树（一个 App，一个 Gallery）                 │
│  ┌ topbar ┐  ┌ art-column ┐  ┌ inspector ──────────┐   │
│  │        │  │  <canvas>  │  │ Controls / Presets  │   │
│  │        │  │   webgpu   │  │ Export              │   │
│  └────────┘  └────────────┘  │ 全部原生元素          │   │
│                              └─────────────────────┘   │
├──────────────────────────────────────────────────────┤
│ 一份 CSS：一种字体、灰阶、1px 边框、两层 grid             │
├──────────────────────────────────────────────────────┤
│ 状态：React state 里的参数对象 → 直接喂 WGSL 管线         │
└──────────────────────────────────────────────────────┘
一种框架、一种控件来源、一份样式、一条数据流

V1 editor
┌────────────────────────────────────────────────────────────────┐
│ UI 层：三种造法叠在一起                                            │
│ ① Svelte + SMUI(Material)        ② lil-gui（three 自带）           │
│   header、左面板四个 tab、对话框     右面板全部：entries/*.ts         │
│   Scene 面板：原生 input+内联样式    .listen() 每帧轮询 config 对象   │
│ ③ 命令式 TS 直接建 DOM                                             │
│   曲线 / 渐变 / 贴图选择器弹窗（DOM 预埋在 content.svelte 里）        │
│   Perf HUD、Gyro HUD、演示浮条                                     │
│ 样式来自五处：smui-dark.css + lil-gui 自带 + 组件内 <style>          │
│             + global.css + TS 里的 inline style                   │
│ 字体四种：Roboto、Roboto Mono、Material Icons、verdana             │
├────────────────────────────────────────────────────────────────┤
│ 胶水 three-particles-editor.ts：window.editor.{…}，new GUI() →     │
│   逐个 createXxxEntries({parentFolder, config, recreate})          │
├────────────────────────────────────────────────────────────────┤
│ 引擎层（不依赖任何 UI，player.ts 已证明）                            │
│   唯一反向依赖：world.ts 查 DOM 里 lil-gui 的宽度算空闲视口           │
└────────────────────────────────────────────────────────────────┘
```

V1 界面代码分布：

| 层 | 行数 | 说明 |
|---|---|---|
| Svelte 组件 | 5015 | 其中 1485 行组件内 CSS；scene-item.svelte 一个文件 1195 行 |
| lil-gui entries | 4169 | 170 个 `.add`、146 个 `.onChange`、140 个 `.listen()`、88 处 controller 引用、53 处无参 `recreateParticleSystem()` |
| 命令式 DOM 编辑器 | 3309 | 曲线、渐变、贴图选择器 |
| HUD 与演示 | 806 | 也进 player，本来就该无框架 |
| 引擎层 | 3741 | world、scene-objects、手柄、层 |
| 胶水 | 1367 | `window.editor` API |

本质区别：genie 是"状态 → 视图"单向；V1 是一个 config 对象被 lil-gui、手柄、load、转换器四方就地修改，无人通知，界面轮询。参数的结构只存在于 lil-gui 调用的执行顺序里，所以没有一份东西能交给另一个界面渲染。Scene 面板是例外，已经是对的形状（模型在 scene-objects.ts，`updateSceneObject(id, patch)` + `setOnSceneChanged`）。

换皮和换架构卡在不同地方：换皮卡在样式散在五处、没有 token；换架构卡在右面板没有 schema。3D 特有的部分（手柄、射线、layer、预览 RT、SSR）全在引擎层，不是障碍；真正和界面绑着的只有视口边界、指针路由、高频双向同步三件（正文 §1.3）。

## C. 框架比较：React 19 / SolidJS / Svelte 5

读法：React /riˈækt/；SolidJS /ˈsɑːlɪd/（"索利德"，就是英文 solid）；Svelte /svɛlt/（"斯维尔特"，一口气念）。

| | React 19 | SolidJS | Svelte 5 |
|---|---|---|---|
| 更新方式 | 重跑组件 + 虚拟 DOM 比对 | 信号，细粒度直改 DOM | 信号，细粒度直改 DOM |
| 组件函数 | 每次状态变都执行 | 只执行一次 | 只执行一次 |
| 写法 | JSX | JSX | 自己的模板语法（.svelte） |
| 运行时体积 | 大 | 很小 | 很小（编译掉了） |
| 性能 | 够用，靠记忆化和 React Compiler | 基准测试第一梯队 | 同一梯队 |
| 生态 | 最大 | 小而稳 | 中等 |
| 心智负担 | hooks 规则、依赖数组、闭包过期 | props 解构断连、要用 `<For>` `<Show>` | 最少，但要学模板语法 |

本质区别一条：谁负责"知道什么变了"。React 不知道，每次重算再比对；Solid 和 Svelte 写代码时就把依赖记下来了。行业走向是 Vue、Angular、Solid、Svelte、Preact 全部转向信号，React 是唯一坚持重跑模型再用编译器补救的。

对 V2 的意义：手柄拖拽每秒几十次进 store、检视器几百个控件。信号模型下只有绑着那个值的一两个节点更新；React 下不加记忆化就是整个检视器子树重算。**框架帮的是"编辑时不掉帧"，不是"粒子画得更快"**：粒子模拟和绘制在 canvas 里由引擎自己的 rAF 循环驱动，框架碰不到；它省下的是主线程上和引擎抢的那几毫秒。不碰面板时零区别。真正影响编辑时粒子性能的是 schema 上的 `change` 三级（很多滑块今天一拖就整个粒子系统重建）。

Solid 与 Svelte 5 是风格选择：Solid 写 JSX，看 React 资料和 genie 的代码都对得上，代价是 Scene 面板 1195 行要重写；Svelte 5 近乎原样移植 Scene 面板，工具链现成，代价是多一套模板语法。

## D. 现代网页架构速览（给以后接手的人）

DOM（Document Object Model）：浏览器把 HTML 解析成内存里的对象树；CSS 附着在树的节点上；JS 通过 API 操作这棵树。HTML 文本只是初始快照，屏幕上显示的永远是 DOM 此刻的样子。`<canvas>` 是树里一个浏览器不管内部像素的节点，three.js 和整个粒子世界活在这一个节点里面。所以 3D 编辑器天然是两个世界的拼接：canvas 里面是渲染循环，外面是 DOM。

旧模型（HTML + JS 库找节点改节点 + CSS）的问题是状态存在 DOM 里，程序一大就在手动维持几十处一致。React 之后的转变只有一句：界面 = 函数(状态)，状态住在 JS 里，DOM 是投影，框架负责让 DOM 跟上。

现在的分层：浏览器平台（DOM、CSS、canvas 上的 WebGL / WebGPU、Web API）→ 构建工具（Vite：编译 TS / .svelte / JSX，打包，热替换）→ 框架（唯一职责是让 DOM 跟着状态变；不画画、不做动画）→ 应用代码（组件 = 一小块界面 + 自己的状态 + 自己的样式；store = 全应用共享状态）。样式跟着组件走，全局只留 token。动画分家：面板用 CSS transition，canvas 用自己的 rAF，两个时钟。浏览器到今天只认 DOM、CSS、JS，框架是编译到这三样上的写法。

Svelte 5 是编译器：`.svelte` 文件里 `$state` `$derived` `$props` `$effect` 这些 rune 是给编译器看的标记，编译产物是"第一次建节点，之后装几条连线：某个值变了改某个节点"，没有虚拟 DOM，不重跑函数。

## E. 引擎层著作权与来源清单

方法：浅克隆上游两个仓库（库 3.0.0、编辑器 2.12.0，与 fork 基线一致），对 `src` 下每个源文件做 `cmp` / `diff`，分成原样、改过、新写三类；依赖看 `node_modules/*/package.json` 的 license 字段；署名看源码注释。我们的 git 历史保留了上游全部提交（717 个提交：Somoracz 539、caoyuxistudio 71、Claude 60、机器人 47），每一行的来源在提交层面可追溯。

```
┌──────────────────────────────────────────────────────────────────┐
│ 我们（曹雨西 / 本 fork，2026）                                       │
│   场景系统：画框、灯、光探针、输出相机、全景环境、SSR 接线、视差、       │
│   手指尾迹、演示模式、Player、视频 color source、Perf/Gyro HUD、       │
│   iOS 壳；库里的 curl noise、Color Instance、亮度驱动、colorTweak、    │
│   touch wake、mesh 的 roughness/metalness/alignToVelocity            │
├──────────────────────────────────────────────────────────────────┤
│ NewKrok（Istvan Krisztian Somoracz，MIT，2021 起）                    │
│   three-particles 库：粒子生命周期、发射器、曲线、序列化、CPU 路径、     │
│   整条 WebGPU + TSL 路径（12 个文件 4083 行：compute kernel、四种 TSL   │
│   材质、曲线烘焙）；tsl-noise.ts 改编自 Ashima Arts / Stefan Gustavson │
│   的 simplex noise（MIT，注释有署名）                                 │
│   three-particles-editor：lil-gui 面板、曲线/渐变编辑器、存取、        │
│   力场/碰撞面手柄、Svelte 壳                                          │
├──────────────────────────────────────────────────────────────────┤
│ three.js（mrdoob 与贡献者，MIT）                                      │
│   WebGPURenderer、TSL、OrbitControls、TransformControls、SSRNode、    │
│   GTAONode、DenoiseNode、HDR/EXR loader、LightProbeGenerator、        │
│   lil-gui、stats                                                    │
├──────────────────────────────────────────────────────────────────┤
│ 浏览器平台（W3C 标准，不是库）                                         │
│   WebGPU、WGSL、Canvas、WebCodecs、IndexedDB、DeviceOrientation       │
└──────────────────────────────────────────────────────────────────┘
```

WebGPU 不是某个人的库，是 W3C 标准，由 Chrome 和 Safari 实现；我们用的是 three.js 的封装（WebGPURenderer + TSL），所以"WebGPU 部分"的著作权落在 three.js 和 NewKrok 写的 TSL kernel 上。

| 包 | 上游原样未动 | 上游文件里我们改的 | 我们新写的文件 | 我们的净增量 |
|---|---|---|---|---|
| 库 three-particles | 26 文件 / 3544 行 | 14 文件，新增约 1500 行 | 4 文件 / 879 行（color-instance-sampler、color-tweak、touch-wake、compute-touch-wake） | 约 2400 行；上游总量约 12900 行 |
| 编辑器 | 34 文件 / 6529 行 | 29 文件，新增 2608 行 | 25 文件 / 7404 行 | 约 10000 行；上游总量约 16000 行 |
| iOS 壳 | 无上游 | | 4 个 Swift 文件 / 210 行 | 全部 |

代表性文件：`world.ts` 上游 165 行、我们 1490 行；`scene-objects.ts` 1201、`scene-item.svelte` 1195、`player.ts` 801、`parallax.ts`、`touch-input.ts`、`video-textures.ts`、`presentation.ts` 全是新文件。库里 `three-particles.ts` 上游 3996 行加 653，`compute-modifiers.ts` 上游 1104 行加 196。上游原样未动的主要是 lil-gui entries、曲线和渐变编辑器、存取对话框，也就是 V2 要换掉或包一层的部分。

| 依赖 | 作者 | 许可证 | 用在哪 |
|---|---|---|---|
| three 0.182 | mrdoob 与贡献者 | MIT | 一切 |
| @newkrok/three-particles（fork 基线） | Somoracz | MIT | 粒子 |
| @newkrok/three-utils | Somoracz | MIT | 对象工具 |
| three-noise | Faraz Shaikh | MIT | 库的 CPU 噪声 |
| easing-functions | kael | MIT | 曲线缓动 |
| Svelte | | MIT | 编辑器壳 |
| SMUI | Hunter Perrin | Apache-2.0 | 编辑器控件（V2 不用） |
| @material/theme | Google | MIT | 同上 |
| prismjs、svrollbar | | MIT | 编辑器 |

概念引用（没有拿代码）：视差相机思路来自 algomystic 的 TheParallaxView（注释有写）；colorTweak 的矩阵是 SVG feColorMatrix 的标准公式。

MIT 的规则：上游代码著作权仍归 Somoracz，我们的改动和新文件归我们，衍生作品可任意使用、修改、商用，义务是保留版权声明和许可证文本。**要补的漏洞**：仓库里只有 `packages/three-particles/LICENSE`，`packages/editor` 没有带上游编辑器的 LICENSE，而编辑器里 6529 行原样代码同样是他的。应把上游编辑器的 LICENSE 复制进 `packages/editor/`。

genie 的粒子：就打包产物可见范围而言是自己写的。bundle 里没有 three.js、没有任何粒子库签名，canvas 直接拿 `webgpu` 上下文，WGSL kernel 编在自己的 JS 里。压缩过的代码看不到注释，其 WGSL 里有无借用公开片段无法判断。

## F. 引擎效率对照 genie

自己写不等于更快。它自己的 Performance 面板在这台 Mac 上（2026-09-14，自动化浏览器面板内）报的数字，加上 bundle 里数出来的管线：

| 项 | genie |
|---|---|
| 粒子数 | 524,288 |
| GPU 一帧（timestamp query） | 20.77 ms，1368 × 1368 |
| 显存 | 52 MB 缓冲 + 14 MB 贴图 |
| 每帧 | 14 个 compute pass + 4 个 render pass，6 次 submit |
| 管线总数 | 24 个 compute、18 个 render |
| 工作组 | 256（20 处）、64（8）、8×8（10，图像空间 pass）、4×4×4（2，三维网格） |
| 绘制 | `triangle-list` + `instance_index` 的实例化 billboard；depth24plus；无 indirect draw |
| 视频 | `copyExternalImageToTexture` 上传，shader 里 `textureSampleLevel(source…)` 逐粒子采样 |

20.77 ms 即 GPU 上限约 48 fps，未计 CPU。它不是精简的专用粒子器，是很大的通用系统：WGSL 函数名里有 `fluidP2G` / `fluidG2P` / `jacobi` / `divergence` / `advect`（粒子-网格流体求解器）、`curlNoise` / `fbm`、`sculptField`、`simulateHair`、`plexus` + `binNodes`（原子操作做邻居连线）、trails、shadow map、bloom、ACES、DOF。裸写 WebGPU 买到的是这些算法自由，尤其是粒子-网格流体和原子操作，在 three-particles 的框架里做不了或很别扭。

它确实更高效的地方：

- **视频在 GPU 上采样**：每来一帧视频上传一次，每个粒子在 shader 里采自己那个源像素（模型是"每颗颗粒认领一个源像素"，wander radius 限制离开多远），零 CPU 读回，持续耦合。我们是出生时 CPU 查一次像素，读回在 worker 里每视频帧中位 6 ms。**唯一一处结构性差距，且可补**：出生逻辑在 WebGPU 路径上本来就是 compute kernel，色源换成 GPU 贴图在 TSL 里采样，worker 读回整条链就没了。
- **CPU 开销低**：无场景图、无材质系统、无 three.js 每帧记账。我们单发射器场景里差几毫秒量级，手机主线程弱会更明显。
- 手写 WGSL 能精确控制缓冲布局和精度；TSL 输出够直接但通用。

我们更贵的地方是选择不是低效：完整 three.js 场景、画框和灯、PMREM 环境、SSR（全分辨率屏幕空间步进）、带法线和 roughness / metalness 的真实 mesh 粒子实例。它是 billboard，没有 SSR。手机 20 fps 的头号原因是像素工作量（3 倍像素比乘 SSR），换粒子库解决不了。编辑器还多一份预览 RT 的完整反射管线，player 没有。

它付出的代价：HDR / EXR、PMREM、变换手柄、SSR、mesh 几何体一样都没有，343 KB 的 app bundle 全是手写。

**进 V1 引擎线清单的两件事**：
1. 色源改 GPU 采样（上传视频帧为贴图，出生 kernel 里 TSL 采样），去掉 worker 读回。
2. Perf HUD 加 GPU 时间：three r182 的 WebGPURenderer 支持 timestamp query。现在 HUD 只有 rAF 帧率，在自动化面板里不可信，也和 genie 的读数对不上。


## 10. 加载速度：V1 量到的，和 V2 的规则（2026-09-15，引擎线补）

V1 打开页面白屏半秒到一秒。用 `performance.mark` 把 boot 拆开量（HUD 的 `boot:` 一行现在直接报时间线，毫秒，从导航起算），原因是三件事，都不是"架构复杂"：

| 原因 | 量到的 | 修法 |
|---|---|---|
| head 里三个 Google Fonts 样式表是 render-blocking，Google 慢或不通时浏览器在它们回来前什么都不画 | 我这边缓存 0 ms；国内网络就是那个白屏 | `media="print" onload="this.media='all'"`，`<html style="background:#000">` |
| boot 等 `window.onload`，也就是等 40 张 example 缩略图和字体全部到齐 | 一次量到 670 ms 才开始 | Svelte `onMount` 就开始 |
| 一个 1.1 秒的同步长任务：默认发射器 + 面板 324 ms，加载作品 604 ms，第一帧编译 219 ms | 界面画出来就冻住 | 见下 |

604 ms 的加载拆开：200k 粒子的系统创建 430 ms（和 maxParticles 成正比），其中上游给 CPU 路径写的逐槽位准备（两个 20 万 `Vector3`、每槽位预先采一次发射位置、几个 20 万长的数组）约 250 ms，GPU 路径根本不用；面板和场景各约 10 ms。另有一处意外：曲线编辑器启动时把 33 个预设曲线各画到一个 canvas 再 `toDataURL()`，同步读回 33 次，255 ms。

改完的时间线（同一台机器，冷启动）：`start 279 → world 325 → scene 417 → painted 428 → example 467 → compiled 794 → first-frame 891 → panel 1085`。第一张画面从 1452 ms 提到约 900 ms，界面在 350 ms 就画出来，之后的块最长 205 ms，中间都让出帧。

**V2 的规则**，写进 studio 的 CLAUDE.md：

1. **首屏不依赖任何外网资源**。字体自托管（§4 本来就只用一种等宽字体）；任何 `<link rel=stylesheet>` 要么本地、要么非阻塞。`<html>` 内联黑底。
2. **先画界面，再做重活**。boot 在 mount 时开始，不等 `load`；每个重阶段之间 `await` 一帧；作品加载在面板构建之前，面板在第一帧之后。
3. **GPU 路径的创建不做逐粒子的 CPU 工作**。这条已经在库里改了（`ensureSlotVectors` 按需分配，起始值数组只分配不填），V2 别在 store / 引擎胶水里再加回来——例如加载时不要遍历粒子。
4. **着色器提前异步编译**：`renderer.compileAsync(scene, camera)` 和 `renderer.computeAsync(computeNode)` 在第一帧之前。剩下的第一帧开销是后期管线（SSR / AO）的节点图构建，约 200 ms，只有预览开着才需要——V2 可以等预览格子可见再建。
5. **任何 `toDataURL` / `getImageData` 不进启动路径**。缩略图、预设预览一类走 `requestIdleCallback`。
6. **example 缩略图懒加载**（`loading="lazy"`），它们不该出现在首屏的关键路径上，V1 的 40 张现在只是不再被等。
7. **量，不猜**：`boot:` 时间线和 `PerformanceObserver('longtask', buffered)` 是标准手段，studio 的 harness 要有一条"第一帧之前没有超过 250 ms 的长任务"。
