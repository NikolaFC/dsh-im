# Satoshi Capital 管理扩展

## 官方对照（2026-11-09）

本扩展按 Discord REST v10 官方文档实现；参考 OpenClaw 官方实现的能力分组和失败回执设计，未复制其代码。

- https://docs.discord.com/developers/resources/channel.md ：频道、thread、论坛、私密归档和成员。
- https://docs.discord.com/developers/resources/guild.md ：频道列表、创建、分类移动。
- https://docs.discord.com/developers/resources/message.md ：实时消息读写、现代置顶接口。
- https://docs.openclaw.ai/channels/discord/threads-and-sessions.md ：帖子创建回执、实时历史、创建时快照语义。
- https://github.com/openclaw/openclaw/blob/main/extensions/discord/src/send.channels.ts
- https://github.com/openclaw/openclaw/blob/main/extensions/discord/src/send.messages.ts
- https://github.com/openclaw/openclaw/blob/main/extensions/discord/src/actions/handle-action.guild-admin.ts
- https://github.com/openclaw/openclaw/blob/main/extensions/discord/src/channel-actions.ts

以上 OpenClaw 为读取时 main，不声称固定发布版本一致。

## 设计与边界

复用现有 DiscordApi 和 Host credentials.resolve，不开新网络监听端口。管理对象限定 guild 1468696024829792310。频道的非空 parentId 必须指向同服务器 type4 分类；null 表示移出分类，省略保持原值。移动不隐式同步权限。

分为 thread、channel、message 三个工具。普通频道不能直接作为 thread 更新目标；论坛父频道不能直接发普通消息，应创建帖子。已有免@、思考轨迹、原有接收路径保持原实现。

删除接口用于明确授权后的单对象删除，不提供批量清空。成员管理限 thread，不扩展踢人、封禁、角色修改或权限覆盖。权限失败保留 Discord 的状态与错误码，权限最终由 Discord 执行。现有 bot 入口仍依赖原访问白名单，未来多用户部署需另外设计调用者权限，而不能仅依赖服务器范围。

## 易错语义

- guild channel list 不含 thread；活跃 thread 从 guild threads/active 获取并按 parent_id 过滤。
- 公共/私密归档 before 为时间戳；已加入私密归档 before 为 thread ID，不能混用。
- type11 明确创建公开 thread；Discord 省略 type 默认私密，故必须显式设置。
- 公告频道的 thread 必须从现有 message 创建。论坛 type15/media type16 使用带 message 的原子创建。
- availableTags 是论坛定义，appliedTags 是帖子所选标签 ID；REQUIRE_TAG=16 时必须指定帖子标签。
- 创建返回的 threadSnapshot=creation 是创建时快照。message_count=0 不代表后续首条消息没发送。
- 首条发送超时保留 thread ID，initialMessageDelivery.status=unknown，先实时读消息核实再补发，不重建帖子。
- 消息读取遵循 Discord 当前内容、删除与访问规则，不等同本地实际收到消息的归档。
- 当前 pins 路径为 /channels/{id}/messages/pins；列表响应 items/has_more，before 为 pinned_at 时间戳。
- 管理移动接口只提交一个频道，满足每个请求最多一个 parent_id 变更。

## 原生交互（斜杠、选择器、批准、选择题）

- 斜杠命令按 guild 1468696024829792310 逐条创建/更新，不批量覆盖、不删除他人命令；创建遇到 Discord 429 时只做一次界内重试。
- 无参数调用 `/model`、`/permission`、`/preset`、`/reasoning`、`/ws` 时：先回 defer（仅本人可见），再读取 Host 真实目录，把同一条消息编辑成下拉选择；超过 25 项显式提示，读取失败回退文字结果。
- `/help` 渲染 13 按钮面板（5/5/3）；选中需要参数的按钮转选择器，不需要的直接执行，结果写回同一条临时消息。
- 选择器与面板都带 nonce，校验 actor、路由、当前会话绑定与是否已被领取；陌生人或错路由的按压静默回应，不破坏他人面板。
- 任何选择最终都以原命令文本走既有 bridge 执行，因此访问策略与命令权限继续生效；界面本身不授予权限。
- 会话处于 danger-full-access（approval=never）时不会发起审批，自然也没有批准按钮；需要验收批准时先用 `/permission workspace-write` 切档。切换只影响该会话，档位本身由 Host 权限预设定义。
- 批准按钮复用既有审批队列控制器，只把展示换成 Discord 组件；提交仍落在 Host 审批接口，未新增旁路。
- 选择题是单选/多选下拉，提交走既有问题回答通道；自由文本仍可通过消息回答。
- `/steer` 无参数不生成假选项，给出用法并说明普通消息即可按当前忙碌模式插话。

## 验证

第一阶段已在工单频道创建并验证 thread 1569416570344710279；进一步扩展的测试与现场验收见工作区 plans/discord-work-orders.md。不存在的现场验证不计为通过；新增删除、私密成员变更等首先用 mock 测试验证合同。
