# Particle Tools

曹雨西（Cao Yuxi）的粒子艺术装置实时编辑器。Fork 自 NewKrok 的 three-particles（库）和 three-particles-editor（编辑器），MIT；这里合成一个 monorepo，作者自用，不回馈上游。仓库 public。

> 这份只是导航。每个包自己的 CLAUDE.md 讲自己的事，Claude Code 进到那个目录会读到它。

> **2026-09-18 起只有一条线：V2** —— Particle Tools Studio（`packages/studio`）加引擎（`packages/engine`），在 **main** 上开发（分支 v2 这天合进了 main，之后停用）。**V1**（`packages/editor` 里 Svelte + SMUI + lil-gui 那套编辑器）**是历史：默认不看、不改**，除非作者点名要看 V1；它的 player（`packages/editor/src/player.ts`，iOS 壳和 `/player/` 用的）和线上根路径照旧保留。

## 包

| 包 | 是什么 | 文档 |
|---|---|---|
| `packages/three-particles` | 粒子库（WebGPU + TSL，CPU 回退） | 上游的 README |
| `packages/engine` | 引擎：世界、场景物体、粒子工厂、schema、预设；无界面依赖 | `packages/engine/CLAUDE.md` |
| `packages/editor` | **V1**（历史）编辑器和 **player**；player 还在用，编辑器不看不改，除非作者点名 | `packages/editor/CLAUDE.md`（V1 的全部记录，到 2026-09-17 为止） |
| `packages/studio` | **V2**：Particle Tools Studio，**默认在这开发** | `packages/studio/CLAUDE.md`（运行说明 + 现状 + 架构规划） |
| `apps/ios/ParticlePlayer` | iOS 壳，只包 player | `apps/ios/ParticlePlayer/README.md` |

## 分支与线上

- **main 是唯一的开发分支**。推 main 自动部署（`deploy.yml`，同一次 checkout 里先构建 V1 再构建 studio）：studio 在 <https://caoyuxistudio.github.io/Particle-tools/Studio/>（小写 `/studio/` 转发），V1 在根路径 <https://caoyuxistudio.github.io/Particle-tools/>，player 在 `/player/`。推之前先在本地把 studio 构建一遍（`cd packages/studio && npm run build`）。
- 历史书签：标签 `v1-final` = V1 收工（2026-09-17）；分支 `v2` = 2026-09-18 合进 main 前的 V2 线，只是书签，不再往上提交（那个 worktree 当天已删，只用 main 的工作区）。
- 作品用 **example-1-1**（`packages/engine/presets/examples/example-1-1/`，色源是站点自带的视频）；WIP-Test-2 备用。

## 现状与下一步（2026-09-18）

- 规划里的 M0–M4 全部完成（2026-09-17）：引擎在 `packages/engine`（边界脚本 0 违规、jest 35 条）；schema 覆盖默认 config 的全部键；studio 与 V1 对等（三个 canvas 编辑器、演示模式、Perf / Gyro HUD、手指尾迹、视差、手机布局），harness `__st.report()` 90 条全绿；studio 已上线，仓库改名 Particle-tools，v2 合进 main。细节和判据在 `packages/studio/CLAUDE.md`「现状与下一步」和 §6。
- **没做的**：studio 里没有 player 显示窗口（V1 的 linked 模式）；子发射器还是 `hidden`；iPhone 真机没验过 studio；账号与云端作品库（BaaS 方向）没开始；弹墙手感作者还不满意（引擎的事）。
- **想做还没做的功能记在根目录 `BACKLOG.md`**（时间轴的回拖快照、带种子的随机数、序列帧导出、手机档粒子预算…）：谈到但决定先不做的功能都写进去，做完删掉。
- **下一步由作者定顺序**，候选就是上面那五项。默认在 studio 和引擎里做；改引擎要过 `npm test` 和 `npm run check:boundary`，加 config 字段要补 schema。

## 跑起来

```bash
cd packages/three-particles && npm run build
cd ../engine && npm install && npm test && npm run check:boundary
cd ../editor && npm run dev      # V1，8080
cd ../studio && npm run dev      # V2，5173
```

## 验证

- studio：dev 页面 console `await __st.report()`（90 条）；真实窗口 + `packages/editor/scripts/cdp-eval.mjs` 更可靠（方法见 `packages/editor/CLAUDE.md`「验证改动」，地址换成 5173）。
- V1（只在作者点名看 V1 时）：`packages/editor/public/__ai-test.js`，console 里 `await __t.<report>()`，一次一个。
- 引擎：`npm test`（jest）和 `npm run check:boundary`。
- CI（`.github/workflows/ci.yml`）在所有分支跑边界脚本和两个包的 jest；`deploy.yml` 只在 main 上跑，V1 和 studio 都从这一次 checkout 构建。

## 工作习惯

- 本地改、本地验证，收工时集中提交，commit message 写清楚做了什么。推 main 会自动部署上线，推之前确认。
- 加 config 字段必须同时补 `packages/engine/src/schema.ts`，commit message 标 `schema:`。
- 沟通简洁客观，中文；任务做完或需要作者决定时发一条电脑通知。
