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
- 密码和授权码可保存在 Windows 凭据管理器、macOS 钥匙串或 Linux 系统密钥库中。
- CLI 核心只使用 Python 标准库；系统密钥库支持通过可选的 `keyring` 包提供。

## 工作方式

```text
用户提示词
   ↓
Codex 判断本次需要关注的邮件和时间事项
   ↓
mailcal.py 通过 IMAP 读取邮件
   ↓
Codex 提取标题、时间、地点、链接和提醒
   ↓
mailcal.py 通过 CalDAV 写入日历
   ↓
state.json 记录游标与处理结果
```

CLI 不依赖任何 AI SDK，也不需要单独的 OpenAI API Key。语义理解由运行该 Skill 的 Codex 完成。

## 仓库结构

```text
mail-calendar-skill/
├── README.md
└── mail-calendar/
    ├── SKILL.md
    ├── agents/
    │   └── openai.yaml
    ├── references/
    │   ├── commands.md
    │   ├── configuration.md
    │   ├── event-json.md
    │   └── processing-state.md
    └── scripts/
        ├── mailcal.py
        └── test_mailcal.py
```

真正的 Skill 是 `mail-calendar/` 子目录；仓库根目录只保存 GitHub 项目说明。

## 环境要求

- Python 3.10 或更高版本
- 能访问目标邮箱的 IMAP 服务
- 能访问目标日历的 CalDAV 服务
- Codex（使用 Skill 时）
- `keyring`（推荐，用于安全保存密码或授权码）

使用前需要在邮箱服务商后台启用 IMAP。QQ、163、126 等邮箱通常应使用服务商签发的客户端授权码，不要使用网页登录密码。Gmail 和 Outlook 的默认预设使用 OAuth2 access token。

## 安装 Skill

Codex 将一个包含 `SKILL.md` 的目录视为一个 Skill。个人 Skill 可以放在：

```text
$HOME/.agents/skills/mail-calendar/
```

克隆本仓库后，只复制 `mail-calendar/` 子目录。

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\.agents\skills" | Out-Null
Copy-Item -Recurse -Force ".\mail-calendar" "$HOME\.agents\skills\mail-calendar"
```

### macOS / Linux

```bash
mkdir -p "$HOME/.agents/skills"
cp -R ./mail-calendar "$HOME/.agents/skills/mail-calendar"
```

也可以让 Codex 的 `$skill-installer` 从 GitHub 仓库中的 `mail-calendar/` 子目录安装。Codex 通常会自动发现新增 Skill；如果没有出现，重启 Codex。

Skill 的目录结构和加载位置可参考 [OpenAI 官方 Skills 文档](https://developers.openai.com/codex/skills)。

## 保存凭据

推荐安装 `keyring`：

```bash
python -m pip install keyring
```

如果邮箱和日历使用同一个账号，并且服务商允许两种协议共用同一个密码或授权码，只需保存一次：

```bash
python -m keyring set mail-calendar person@example.com
```

命令会交互式询问密码或授权码。邮箱和日历配置都引用同一个条目：

```text
keyring:mail-calendar:person@example.com
```

只有在邮箱和日历使用不同账号、不同授权码或不同类型的 OAuth token 时，才需要分别保存两个 keyring 条目。

不同系统使用对应的系统凭据存储：

- Windows：Windows 凭据管理器
- macOS：钥匙串访问（Keychain）
- Linux：Secret Service 或 KWallet，具体取决于桌面环境

也可以使用 `env:VARIABLE_NAME` 从环境变量读取凭据。不要把明文密码、授权码或 token 提交到 Git 仓库。

## 初始化配置

进入 Skill 目录：

```bash
cd mail-calendar
```

查看支持的服务商：

```bash
python scripts/mailcal.py provider list
python scripts/mailcal.py provider show mail qq
python scripts/mailcal.py provider show calendar qq
```

以同一个 QQ 账号同时连接邮箱和日历为例：

```bash
python scripts/mailcal.py config init \
  --email person@qq.com \
  --mail-provider qq \
  --mail-secret-ref keyring:mail-calendar:person@qq.com \
  --calendar-provider qq \
  --calendar-user person@qq.com \
  --calendar-secret-ref keyring:mail-calendar:person@qq.com
```

测试连接：

```bash
python scripts/mailcal.py config test
```

如果账号中有多个日历，可以先查看列表：

```bash
python scripts/mailcal.py calendar list
```

然后把选中日历的 `url` 写入本地 `config.json` 的 `calendar.collection_url`。

完整配置说明见 [`configuration.md`](mail-calendar/references/configuration.md)。

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

## 直接使用 CLI

获取新增且尚未处理的邮件头：

```bash
python scripts/mailcal.py mail pending --since 30d --limit 50
```

读取一封邮件正文：

```bash
python scripts/mailcal.py mail get --uid 123
```

把邮件标记为已处理：

```bash
python scripts/mailcal.py mail ack --uid 123 --outcome ignored
python scripts/mailcal.py mail ack --uid 124 --outcome created --event-uid EVENT_UID
```

查看游标状态：

```bash
python scripts/mailcal.py mail state
```

详细参数见 [`commands.md`](mail-calendar/references/commands.md)，日程 JSON 格式见 [`event-json.md`](mail-calendar/references/event-json.md)。

## 配置和运行数据

默认配置目录：

| 系统 | 配置文件 | 处理状态 |
|---|---|---|
| Windows | `%APPDATA%\mail-calendar\config.json` | `%APPDATA%\mail-calendar\state.json` |
| macOS | `~/Library/Application Support/mail-calendar/config.json` | `~/Library/Application Support/mail-calendar/state.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/mail-calendar/config.json` | `${XDG_CONFIG_HOME:-~/.config}/mail-calendar/state.json` |

`config.json` 只保存服务器设置和密钥引用。`state.json` 不保存密码，但会保存邮件 UID、部分邮件头以及处理结果，因此也应视为用户私有数据。

## 增量处理与失败恢复

`mail pending` 会同时维护扫描游标和待处理队列：

- 新邮件只下载邮件头，模型认为可能相关时再读取正文。
- 只有执行 `mail ack` 后，邮件才算处理完成。
- 如果运行中断，未确认邮件会在下一轮继续出现。
- `UIDVALIDITY` 变化时会自动开始新一代游标，避免 UID 重用造成误判。

实现细节见 [`processing-state.md`](mail-calendar/references/processing-state.md)。

## 测试

在仓库根目录执行：

```bash
python -m unittest discover -s mail-calendar/scripts -p "test_*.py" -v
```

测试使用本地模拟数据，不会连接真实邮箱或日历。实际账号配置完成后，请再执行：

```bash
python mail-calendar/scripts/mailcal.py config test
```

## 当前边界

- 每次安装配置一个邮箱和一个日历。
- CLI 不负责 OAuth 登录页面、授权流程或 token 自动刷新。
- 附件只返回文件名、类型和大小等元数据，不下载附件内容。
- 不在 CLI 中固化邮件分类或日程提取规则，具体目标由用户提示词决定。

## 相关文档

- [Skill 使用说明](mail-calendar/SKILL.md)
- [CLI 命令参考](mail-calendar/references/commands.md)
- [邮箱和日历配置](mail-calendar/references/configuration.md)
- [日程 JSON 格式](mail-calendar/references/event-json.md)
- [增量处理状态](mail-calendar/references/processing-state.md)
