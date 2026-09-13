# Mail Calendar Skill

一个面向 Codex 的通用邮件日程 Skill。它通过 IMAP 读取用户自己的邮箱，由模型按照用户当前的要求理解邮件内容，再通过 CalDAV 创建或删除日程。

具体提取什么不写死在代码中：可以是会议、活动、账单截止日期、课程、航班、酒店、预约，也可以是招聘、面试或笔试通知。

## 特性

- 支持 QQ 邮箱、163、126、Yeah、阿里邮箱、Gmail、Outlook 和自定义 IMAP 服务。
- 支持 QQ、Google 以及自定义 CalDAV 服务。
- 每个安装实例配置一个邮箱和一个日历，适合不同用户独立安装。
- CLI 只负责稳定的协议操作，邮件相关性和日程字段由调用 Skill 的模型判断。
- 使用本地 JSON 游标记录扫描进度，避免每次重复读取旧邮件。
- 使用 IMAP `UIDVALIDITY` 防止服务端重新分配 UID 后错误跳过邮件。
- 重复创建相同 UID 的日程时更新同一个 `.ics` 资源。
- Windows、macOS 和 Linux 统一使用 `~/.mail-calendar-skill/` 下的本地 JSON 文件。
- 非敏感设置与明文凭据分文件保存，所有协议代码通过同一个访问层取得运行时配置。
- 安装后只需要 Node.js，运行依赖已打包进 `.mjs`，无需安装 Python 或执行 `npm install`。
- IMAP、邮件解析、CalDAV 和日程生成分别使用 ImapFlow、MailParser、tsdav 和 ical-generator。
- ISO 日期、提醒时长和邮件原始时区由 Luxon 解析。

## 工作方式

```text
用户提示词
   ↓
Codex 判断本次需要关注的邮件和时间事项
   ↓
mailcal.mjs 通过 IMAP 读取邮件
   ↓
Codex 提取标题、时间、地点、链接和提醒
   ↓
mailcal.mjs 通过 CalDAV 写入日历
   ↓
state.json 记录游标与处理结果
```

CLI 不依赖任何 AI SDK，也不需要单独的 OpenAI API Key。语义理解由运行该 Skill 的 Codex 完成。

## 仓库结构

```text
mail-calendar-skill/
├── src/                       # 可读 JavaScript 源码
├── tests/                     # 配置、协议和独立运行测试
├── tools/build.mjs            # 打包和压缩
├── tools/version.mjs          # 版本同步和发布准备
├── package.json
├── package-lock.json
├── .github/workflows/ci.yml   # 跨平台测试和 tag 发布
├── README.md
└── skills/
    └── mail-calendar/
        ├── SKILL.md
        ├── agents/openai.yaml
        ├── examples/
        ├── references/
        └── scripts/
            └── mailcal.mjs             # 自动生成，包含第三方依赖
```

真正的 Skill 是 `skills/mail-calendar/` 子目录。安装时会复制这个目录；根目录的 README、源码、构建工具和测试不会被安装。

## 环境要求

- Node.js 22.13 或更高的 22.x 版本，或 Node.js 24 及以上版本；推荐 Node.js 24 LTS
- 能访问目标邮箱的 IMAP 服务
- 能访问目标日历的 CalDAV 服务
- Codex（使用 Skill 时）

使用前需要在邮箱服务商后台启用 IMAP。QQ、163、126 等邮箱通常应使用服务商签发的客户端授权码，不要使用网页登录密码。Gmail 和 Outlook 的默认预设使用 OAuth2 access token。

## 安装 Skill

### 使用 npx 一键安装（推荐）

从 GitHub 仓库安装到当前用户目录，跳过确认提示：

```bash
npx skills add lll-gr/mail-calendar-skill -y -g
```

只安装到 Codex：

```bash
npx skills add lll-gr/mail-calendar-skill --skill mail-calendar -a codex -y -g
```

`-g` 表示安装到用户目录，`-y` 表示跳过安装确认，`-a codex` 表示指定 Codex。不加 `-a` 时由安装工具选择检测到的 Agent。只希望在当前项目中使用时，去掉 `-g`。

安装工具会识别仓库里的 `skills/mail-calendar/SKILL.md`，并安装整个 Skill 目录，包括脚本、参考文档和配置示例。无需先克隆仓库，也无需将本项目发布成 npm 包；`npx` 运行的是 `skills` 安装工具，本项目从 GitHub 获取。安装方式参考 [skills 官方说明](https://github.com/vercel-labs/skills#install-a-skill)。

查看仓库中可安装的 Skill，或查看已全局安装的 Skill：

```bash
npx skills add lll-gr/mail-calendar-skill --list
npx skills list -g
```

安装后，在 Codex 中让模型使用 `$mail-calendar` 协助初始化邮箱和日历配置。`-y` 只跳过安装确认，邮箱和日历凭据仍需在初始化时由用户交互式输入。

### 手动安装

Codex 将一个包含 `SKILL.md` 的目录视为一个 Skill。个人 Skill 可以放在：

```text
$HOME/.agents/skills/mail-calendar/
```

克隆本仓库后，只复制 `skills/mail-calendar/` 子目录。

#### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\.agents\skills" | Out-Null
Copy-Item -Recurse -Force ".\skills\mail-calendar" "$HOME\.agents\skills\mail-calendar"
```

#### macOS / Linux

```bash
mkdir -p "$HOME/.agents/skills"
cp -R ./skills/mail-calendar "$HOME/.agents/skills/mail-calendar"
```

也可以让 Codex 的 `$skill-installer` 从 GitHub 仓库中的 `skills/mail-calendar/` 子目录安装。Codex 通常会自动发现新增 Skill；如果没有出现，重启 Codex。

Skill 的目录结构和加载位置可参考 [OpenAI 官方 Skills 文档](https://developers.openai.com/codex/skills)。

## 保存凭据

`config init` 会在终端中交互式读取邮箱和日历密码、客户端授权码或 OAuth token，不会把它们放进命令行参数。生成的文件固定为：

```text
~/.mail-calendar-skill/
├── settings.json       # 服务器、账号、认证方式等非敏感设置
├── credentials.json    # 明文密码、授权码或 token
└── state.json          # 邮件扫描和处理状态
```

当前版本暂不加密 `credentials.json`。macOS/Linux 会把目录设为 `0700`、凭据文件设为 `0600`；Windows 使用用户主目录，并通过系统自带的 ACL 工具尽力限制为当前用户、SYSTEM 和 Administrators，不引入额外依赖。不要提交、同步或分享真实的 `credentials.json`。

## 初始化配置

以下命令相对于 Skill 目录执行。使用 `npx` 安装后，可先通过 `npx skills list -g` 查看安装位置，再进入显示的安装目录；从仓库手动安装或直接试用时：

```bash
cd skills/mail-calendar
```

查看支持的服务商：

```bash
node scripts/mailcal.mjs provider list
node scripts/mailcal.mjs provider show mail qq
node scripts/mailcal.mjs provider show calendar qq
```

以同一个 QQ 账号同时连接邮箱和日历为例：

```bash
node scripts/mailcal.mjs config init \
  --email person@qq.com \
  --mail-provider qq \
  --calendar-provider qq \
  --calendar-user person@qq.com \
  --reuse-mail-secret
```

命令会提示输入邮箱凭据；`--reuse-mail-secret` 表示日历使用同一份凭据。没有该选项时会分别提示输入两份凭据。

测试连接：

```bash
node scripts/mailcal.mjs config test
```

如果账号中有多个日历，可以先查看列表：

```bash
node scripts/mailcal.mjs calendar list
```

然后把选中日历的 `url` 写入本地 `~/.mail-calendar-skill/settings.json` 的 `calendar.collection_url`。

完整配置说明见 [`configuration.md`](skills/mail-calendar/references/configuration.md)。

## 在 Codex 中使用

可以显式调用：

```text
使用 $mail-calendar 检查最近 30 天的邮件，把会议、出行和截止日期同步到我的日历。
```

也可以给出更具体的条件：

```text
使用 $mail-calendar 查找所有课程调整通知，把新上课时间写入日历。
```

```text
使用 $mail-calendar 检查航空公司和酒店邮件，只添加尚未结束的行程。
```

```text
使用 $mail-calendar 找出招聘流程中的面试、笔试和材料截止日期，并提前一天提醒我。
```

Skill 也支持根据描述自动触发；是否调用取决于用户请求与 `SKILL.md` 中的描述是否匹配。

### 定时任务权限

Codex 定时任务访问 IMAP/CalDAV 时需要网络权限，维护 `~/.mail-calendar-skill/state.json` 时还需要写入项目目录之外的用户 home。自动化任务本身没有单独的网络权限开关，权限也不能绑定到某个任务 ID；应先为已安装脚本配置只覆盖 `config test`、`mail` 和 `calendar` 子命令的精确规则，重启 Codex 后再创建或启用任务。不要放行任意 Node.js 命令。规则示例和验证命令见 [`configuration.md`](skills/mail-calendar/references/configuration.md#codex-定时任务权限)。

## 直接使用 CLI

读取指定日期范围内的日程（结束日期不包含在范围内）：

```bash
node scripts/mailcal.mjs calendar events --start 2026-09-13 --end 2026-09-14
node scripts/mailcal.mjs calendar events --start 2026-09-13 --end 2026-09-20 --summary 会议 --limit 100
```

读取单条日程详情，包括原始 iCalendar：

```bash
node scripts/mailcal.mjs calendar get --uid EVENT_UID
node scripts/mailcal.mjs calendar get --url https://dav.example/calendars/user/default/event.ics
```

`calendar list` 列出的是日历集合，`calendar events` 才返回具体日程。查询只读，日期按配置时区解释；重复日程由服务器在范围内展开。

获取新增且尚未处理的邮件头：

```bash
node scripts/mailcal.mjs mail pending --since 30d --limit 50
```

读取一封邮件正文：

```bash
node scripts/mailcal.mjs mail get --uid 123
```

把邮件标记为已处理：

```bash
node scripts/mailcal.mjs mail ack --uid 123 --outcome ignored
node scripts/mailcal.mjs mail ack --uid 124 --outcome created --event-uid EVENT_UID
```

查看游标状态：

```bash
node scripts/mailcal.mjs mail state
```

详细参数见 [`commands.md`](skills/mail-calendar/references/commands.md)，日程 JSON 格式见 [`event-json.md`](skills/mail-calendar/references/event-json.md)。

## 配置和运行数据

所有系统都通过 Node.js 的用户 home 解析同一目录：

| 文件 | 内容 |
|---|---|
| `~/.mail-calendar-skill/settings.json` | 非敏感服务器和账号设置 |
| `~/.mail-calendar-skill/credentials.json` | 明文密码、授权码或 token |
| `~/.mail-calendar-skill/state.json` | 邮件 UID、部分邮件头和处理结果 |

兼容 Python 0.2 版本的 `version: 1` 设置、凭据和状态文件，以及相同来源、标题和开始时间生成的日程 UID；从该版本升级无需重新配置。其他旧路径、路径覆盖和旧凭据字段不受支持。示例见 [`skills/mail-calendar/examples/`](skills/mail-calendar/examples/)。

## 增量处理与失败恢复

`mail pending` 会同时维护扫描游标和待处理队列：

- 新邮件只下载邮件头，模型认为可能相关时再读取正文。
- 只有执行 `mail ack` 后，邮件才算处理完成。
- 如果运行中断，未确认邮件会在下一轮继续出现。
- `UIDVALIDITY` 变化时会自动开始新一代游标，避免 UID 重用造成误判。

实现细节见 [`processing-state.md`](skills/mail-calendar/references/processing-state.md)。

## 开发、构建和测试

在仓库根目录执行：

```bash
npm ci
npm run build
npm test
```

开发时修改 `src/`，使用 esbuild 把源码和运行依赖打包、压缩为 `skills/mail-calendar/scripts/mailcal.mjs`。`package-lock.json` 固定依赖版本。本地构建用于预览和测试，正式发布由 tag 流水线重新构建并提交生成文件。`scripts/` 只包含可执行的 `.mjs`。

测试使用本地模拟数据和本机 IMAP/CalDAV 测试服务器，不会连接真实邮箱或日历。测试还会将整个 Skill 复制到独立临时目录，在没有 `node_modules` 的情况下运行打包脚本。实际账号配置完成后，请再执行：

```bash
node skills/mail-calendar/scripts/mailcal.mjs config test
```

### GitHub Actions 自动构建

提交 PR、推送到 `main` 或手动运行时，流水线只执行构建和测试。推送 `v*` tag 才触发发布。所有检查在 Windows、macOS、Linux 上分别使用 Node.js 22 和 24 执行；Linux / Node.js 24 还会检查 `npx skills` 能否发现该 Skill。

版本以根目录 `package.json` 为准。发布前校验 tag（如 `v0.1.1`）、`package.json` 和 `package-lock.json` 的版本；CI 构建时同步 `SKILL.md` 的 `metadata.version` 和脚本的 `--version`，然后再次校验。无需在创建 tag 前提交本地构建文件。CI 生成脚本的开头会记录版本和来源提交 SHA；本地构建标记为 `source: local`。

准备一个新版本，例如 `0.1.1`：

```bash
npm run release:prepare -- 0.1.1 --no-build
git add package.json package-lock.json skills/mail-calendar/
git commit -m "release: v0.1.1"
git tag v0.1.1
git push origin main
git push origin v0.1.1
```

`release:prepare -- <版本> --no-build` 只准备版本，构建交给 CI；去掉 `--no-build` 可在本地预览构建。此命令不会自动提交、创建 tag 或推送；源码变更也应提交到 tag 指向的提交。支持语义版本和 `v0.1.1-rc.1` 等预发布 tag。

Tag 的全部检查通过后，流水线重新构建，并由机器人将 `.mjs` 和 `SKILL.md` 提交回 `main`，再发布整个 Skill 的 `mail-calendar-v0.1.1.tar.gz` 及 SHA-256 校验文件。机器人提交消息为 `build: publish v0.1.1 skill`。如果 `main` 已前进到其他源码提交，只发布该 tag 的归档包，不覆盖 `main`。仅为发布授予 `GITHUB_TOKEN` 的 `contents: write` 权限；已创建的 tag 保持固定。失败时重新运行对应 tag 工作流；手动新建运行只验证，不发布。

原来的安装命令 `npx skills add lll-gr/mail-calendar-skill -y -g` 获取 `main` 中由 CI 更新的安装文件。安装指定的正式版本使用 Release 构建包（发布后）：

```bash
npx skills add https://github.com/lll-gr/mail-calendar-skill/releases/download/v0.1.1/mail-calendar-v0.1.1.tar.gz -y -g
```

这样安装的是 CI 根据 tag 构建的版本。Tag 下的源码目录不一定包含对应的新构建，因此指定正式版本时使用 Release 包，仍然无需发布 npm 包。

## 当前边界

- 每次安装配置一个邮箱和一个日历。
- 凭据当前以明文保存在用户目录内，安全边界是本机用户账户和文件权限。
- CLI 不负责 OAuth 登录页面、授权流程或 token 自动刷新。
- 附件只返回文件名、类型和大小等元数据，不下载附件内容。
- 不在 CLI 中固化邮件分类或日程提取规则，具体目标由用户提示词决定。

## 相关文档

- [Skill 使用说明](skills/mail-calendar/SKILL.md)
- [CLI 命令参考](skills/mail-calendar/references/commands.md)
- [邮箱和日历配置](skills/mail-calendar/references/configuration.md)
- [日程 JSON 格式](skills/mail-calendar/references/event-json.md)
- [增量处理状态](skills/mail-calendar/references/processing-state.md)
