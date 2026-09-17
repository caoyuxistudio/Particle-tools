# Particle Tools

曹雨西（Cao Yuxi）的粒子艺术装置实时编辑器。Fork 自 NewKrok 的 three-particles（库）和 three-particles-editor（编辑器），MIT；这里合成一个 monorepo，作者自用，不回馈上游。仓库 public。

> 这份只是导航。每个包自己的 CLAUDE.md 讲自己的事，Claude Code 进到那个目录会读到它。

## 包

| 包 | 是什么 | 文档 |
|---|---|---|
| `packages/three-particles` | 粒子库（WebGPU + TSL，CPU 回退） | 上游的 README |
| `packages/engine` | 引擎：世界、场景物体、粒子工厂、schema、预设；无界面依赖 | `packages/engine/CLAUDE.md` |
| `packages/editor` | **V1** 编辑器（Svelte + SMUI + lil-gui）和 **player**；保留、只修 bug | `packages/editor/CLAUDE.md`（全部历史都在这） |
| `packages/studio` | **V2**：Particle Tools Studio，以后主要在这开发 | `packages/studio/CLAUDE.md`（运行说明 + 架构规划） |
| `apps/ios/ParticlePlayer` | iOS 壳，只包 player | `apps/ios/ParticlePlayer/README.md` |

## 分支与线上

- **main = V1**，线上根路径 <https://caoyuxistudio.github.io/Particle-tools/>；标签 `v1-final` 是 V1 收工时的书签。
- **v2 = V2 的全部工作**，本机 worktree 在 `../threeparticle-v2`；线上 <https://caoyuxistudio.github.io/Particle-tools/Studio/>，由 main 的 `deploy.yml` 从 v2 分支构建。改 studio：先推 v2，再推一次 main 触发部署。main 的修改只往 v2 合，不反向。
- 作品用 **example-1-1**（`packages/engine/presets/examples/example-1-1/`，色源是站点自带的视频）；WIP-Test-2 备用。

## 跑起来

```bash
cd packages/three-particles && npm run build
cd ../engine && npm install && npm test && npm run check:boundary
cd ../editor && npm run dev      # V1，8080
cd ../studio && npm run dev      # V2，5173
```

## 验证

- V1：`packages/editor/public/__ai-test.js`，浏览器 console 里 `await __t.<report>()`，一次一个；真实窗口 + `scripts/cdp-eval.mjs` 更可靠（方法见 `packages/editor/CLAUDE.md`「验证改动」）。
- studio：dev 页面 console `await __st.report()`。
- 引擎：`npm test`（jest）和 `npm run check:boundary`。
- CI（`.github/workflows/ci.yml`）在所有分支跑边界脚本和两个包的 jest；`deploy.yml` 只在 main 上跑。

## 工作习惯

- 本地改、本地验证，收工时集中提交，commit message 写清楚做了什么。推 main 会自动部署上线，推之前确认。
- 加 config 字段必须同时补 `packages/engine/src/schema.ts`，commit message 标 `schema:`。
- 沟通简洁客观，中文；任务做完或需要作者决定时发一条电脑通知。
