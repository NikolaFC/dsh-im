# Discord 频道 ↔ 游戏会话：真正的双向控制（2026-11-10）

## 结论先说

会话绑定本来就是对的。`state.json` 里 `group:1484533301195833446` 一直是
`session-611e0f02-12db-48ff-bfa0-b1c590ce3279`，跨重启保留，不需要重绑、没有重复会话。
坏的是**控制权的判定口径**：只承认"本进程里这条 Discord 入站消息开出来的、且还没结束的那一轮"。
自动续轮（`source.kind: goal`）、GUI 里手动开的轮次、以及任何已被历史推走的轮次，都被判成"没有在运行的任务"，
于是普通消息排进队列、`/stop` 回一句"当前聊天没有正在运行的任务"。

## 真实生产证据（不是 mock）

同一会话日志 `session-611e0f02`：

- turn 8 是 goal 第 3 轮（seq 3124，`goal-971a43e4-e276-4bc9-81f6-134d34536c3e`），直播一直在发：
  `dsh_discord_message.send` → channel `1484533301195833446`（seq 3271、3365）。
- 10:45:09 用户在频道发"不要有压力……"，入站先进 inbox（seq 3317），**直到 10:50:11 turn 8 结束（seq 3372）
  才在 turn 9 成为正式 user/message（seq 3376，rpc `discord-5d1fe00d-…`）**。
  出站即时、入站延迟五分钟 —— 这就是用户说的"只能投递、无法互动"。
- `controlAnchors` 里游戏频道仍无记录；只有 `group:1468696025622380653` 有。前一次修复只覆盖
  "历史锚点 + 同目标续轮"，且完全没碰 stop。

## 机制（为什么这是安全的最小改法）

新增 `src/channels/shared/bound-conversation-control.mjs`：一个**进程内能力对象**，只能由
通过身份与命令权限校验的 Discord 入站创建（`channel === 'discord'`、非 bot、群聊必须 addressed、
`key === kind:conversationId`、该 key 已有会话绑定、存在 accessPolicy）。

它捕获并每次调用时重新验证四件事：bot 专属 state、频道 key、sessionId、`controlBindingVersion`。
任何一个变了（换绑、换回、权限撤回、abort）都抛错，不发任何注入。没有序列化标志、没有 rpcId 前缀、
没有调用方自带 sessionId 可以伪造；不同频道、不同 bot 的 state 各自独立。

接线：

- `text-harness-bridge.mjs`：`#turnControl(key, message)` 在普通消息、`/steer`/`/stop` 命令、
  自动 steer 车道、以及开启轮次的 ask 四处都带上该能力。
- `harness-client.mjs`：`stopActiveTurn` / `steerActiveTurn` 在存在 `boundSession` 时走**同步**分支，
  绝不回落 HTTP `session.cancel` / `session.prompt`（冷会话也不能被唤醒成新消息）。
- `harness-session-coordinator.mjs`（host）：同 tick 内验能力、验 `agents.get(sessionId)` 仍是同一 agent、
  验确实有一个未结束的 turn，然后 `inject` 或 `cancel({keepInbox:true})`。
- 命令拒绝（`im-control-denied`）回既有权限不足文案；绑定变化回 `workspace-session-stale` 的"请重发"文案，
  不再是误导性的"没有正在运行的任务"。

没有改动目标语义：`/stop` 仍是取消这一轮，不自动暂停 goal，仓库里也没有"命令暂停目标"的先例。

## 测试

`test/bound-conversation-control.test.mjs` 4 项：无锚点 goal/GUI 轮次的 steer + stop；错 session、
权限撤回、换绑 ABA、abort 全拒；跨渠道/跨 bot/未 addressed/bot 发送者不产能力；`/steer` slash 经真实
bridge 拿到能力对象。

整套回归：**276 passed, 0 failed, 0 cancelled**（bound control、harness-control、host coordinator、
continuation state、deferred control、dispatcher、bridges、text bridge、discord、goal command、
discord activity、i18n coverage）。

## 部署要求

`lib/index.js` 已重建（`node --check` 通过，`git diff --check` 干净），但**重建不等于生效**：
已实例化的 client 类与私有状态不会自己更新。需要协调在无活动投递的安静边界做一次受支持的
pluginManager 重载/重组，然后验证：游戏频道 `/stop` 与普通插话走的是同一个绑定能力，
`/goal status` 只读可读。不要在全服重启前对正在进行的游戏轮次做 stop 实测。
