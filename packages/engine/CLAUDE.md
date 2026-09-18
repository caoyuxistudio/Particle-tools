# 引擎（packages/engine）

作品格式（Document）、参数表（Schema）和三维世界的全部逻辑，**没有任何界面框架依赖**（V2 规划 §1，见 `packages/studio/CLAUDE.md`）。V1（`packages/editor`）和 studio（`packages/studio`）都以 `@particle-tools/engine/<module>` 引用它；player（`packages/editor/src/player.ts`）证明它不靠界面也能完整放映作品。2026-09-17（M4）从 V1 的 `src/js/three-particles-editor/` 物理搬到这里；每个模块的来龙去脉在 `packages/editor/CLAUDE.md`（按旧路径写的，换算即可）。

## 规则

- **边界**：`engine-boundary.json` 列出全部模块；`npm run check:boundary` 查三条——引擎模块只引引擎和 three / @newkrok；`roots`（player.ts）的整个引用图不出引擎；studio 的每处 `@particle-tools/engine/…` 引用都在清单里、不得按路径引 V1 或引擎文件。CI 在每个分支上跑它。
- **加 config 字段必须补 schema**（`src/schema.ts`）：jest `__tests__/schema.test.ts` 查库默认值和 `documentDefaults()` 的每个叶子有字段、每个字段解析得到；studio 的 `schemaReport` / V1 的 harness 在真实窗口里对 V1 的面板逐控件比。少一处就红。
- **引擎不认识 DOM 里的面板**：视口边界 `setViewportInsets`、帧计数器 `setStatsContainer`、用户提示 `notify.ts`、变更事件 `document-events.ts` 全是注入或事件，界面自己接。
- **加 config 字段时 commit message 标 `schema:`**，另一条线看得见。

## 坑

- **材质上常驻 `mrtNode` 会让它在别的 render target 里消失**（2026-09-18，feedback）。three 的 NodeMaterial：目标有 pass 的 MRT 时把材质的 mrtNode 合并进去；目标**没有** MRT 时，材质的 mrtNode 就是它的全部输出——粒子在视口那条路里整个不见了，没有报错。所以粒子的 trail mask 只在 feedback 管线渲染那一下戴上（`withTrailSources`），渲完摘掉；program 是按 render context 在第一次用到的那次渲染里编译的，管线的带 mask，别人的不带。

## 目录

- `src/`：模块；`src/__tests__/`：jest（`npm test`，ESM）。
- `presets/`：随包的预设——`examples/<slug>/config.json + preview.webp`（`presets.ts` 列出的那几个），`assets/`（贴图、视频、图片）。`scripts/sync-presets.mjs` 把它们拷进一个 public 目录（V1 和 studio 的 dev / build 都先跑它；拷贝 gitignore）。
- `scripts/check-engine-boundary.mjs`：边界脚本。

## 依赖

`three`（必须和 V1、studio 同一个版本，各自的打包配置 dedupe 到自己的 node_modules，否则出两份 three）、`@newkrok/three-particles`（`file:../three-particles`，先 `npm run build` 那个包）、`@newkrok/three-utils`。
