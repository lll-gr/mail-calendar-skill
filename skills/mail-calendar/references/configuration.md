# 配置

每次安装只配置一个邮箱和一个日历。Windows、macOS 和 Linux 都使用 Node.js 解析出的用户主目录，不读取路径环境变量，也不接受其他配置路径。

## 固定位置

```text
~/.mail-calendar-skill/
├── settings.json
├── credentials.json
└── state.json
```

- `settings.json`：邮箱、日历、认证方式和默认时区等非敏感设置。
- `credentials.json`：邮箱和日历使用的明文密码、客户端授权码或 OAuth token。
- `state.json`：邮件扫描游标和处理结果，由 CLI 自动维护。

兼容 Python 0.2 版本使用的同目录 `version: 1` 配置、凭据和状态文件，升级到 Node.js 版本后无需重新初始化。其他旧配置路径、旧凭据字段和环境变量回退都不受支持。

## 文件格式

`settings.json` 示例：

```json
{
  "version": 1,
  "timezone": "Asia/Shanghai",
  "mail": {
    "provider": "qq",
    "address": "person@qq.com",
    "host": "imap.qq.com",
    "port": 993,
    "security": "ssl",
    "auth": "password"
  },
  "calendar": {
    "provider": "qq",
    "base_url": "https://dav.qq.com/",
    "collection_url": "https://dav.qq.com/calendars/person/default/",
    "auth": "basic",
    "username": "person@qq.com"
  }
}
```

`calendar.base_url` 填写 CalDAV 服务入口。

`credentials.json` 示例：

```json
{
  "version": 1,
  "mail": {
    "secret": "邮箱密码、客户端授权码或 OAuth token"
  },
  "calendar": {
    "secret": "日历密码、客户端授权码或 OAuth token"
  }
}
```

凭据文件当前不加密。不要把真实凭据提交到 Git、云盘或聊天中。

## 初始化

优先使用服务商预设：

```text
node scripts/mailcal.mjs config init \
  --email person@qq.com \
  --mail-provider qq \
  --calendar-provider qq \
  --calendar-user person@qq.com \
  --reuse-mail-secret
```

命令会隐藏输入邮箱密码、授权码或 token。`--reuse-mail-secret` 会把同一输入写入邮箱和日历凭据；不使用该选项时，命令会分别提示输入两份凭据。已有任一配置文件时初始化会拒绝覆盖，只有明确传入 `--force` 才会替换。

## 文件权限

- macOS/Linux：配置目录设为 `0700`，`credentials.json` 设为 `0600`。
- Windows：文件位于当前用户的 home 目录下，并使用系统自带工具尽力把目录和凭据文件 ACL 限制为当前用户、SYSTEM 和 Administrators。ACL 收紧失败不会增加额外运行时依赖。

Codex 和用户终端只要运行在同一个系统用户下，就会解析到同一组文件。

## Codex 定时任务权限

Skill 本身不能授予网络或沙箱外文件权限，自动化任务也没有可绑定到任务 ID 的独立网络权限开关。Codex 定时任务默认无人值守运行，因此应先为 `config test`、`mail` 和 `calendar` 命令配置精确规则，重启 Codex 后再创建或启用任务；不要允许任意 `node` 命令。每条 CLI 调用都应是独立的简单命令，避免在同一条 shell 命令中拼接其他操作。

把下面示例中的 `<USER>` 替换为当前用户名，并保存到 `~/.codex/rules/mail-calendar.rules`：

```python
prefix_rule(
    pattern = ["node", "C:\\Users\\<USER>\\.codex\\skills\\mail-calendar\\scripts\\mailcal.mjs", "config", "test"],
    decision = "allow",
    justification = "Allow only the mail-calendar connectivity test outside the sandbox.",
)

prefix_rule(
    pattern = ["node", "C:\\Users\\<USER>\\.codex\\skills\\mail-calendar\\scripts\\mailcal.mjs", "mail", ["folders", "search", "pending", "get", "ack", "retry", "state"]],
    decision = "allow",
    justification = "Allow only mail-calendar IMAP and mail state operations outside the sandbox.",
)

prefix_rule(
    pattern = ["node", "C:\\Users\\<USER>\\.codex\\skills\\mail-calendar\\scripts\\mailcal.mjs", "calendar", ["list", "create", "delete"]],
    decision = "allow",
    justification = "Allow only mail-calendar CalDAV operations outside the sandbox.",
)
```

规则刻意不放行 `config init`、其他脚本或普通 Node.js 命令。使用 `npx skills` 安装时，脚本可能通过符号链接关联到 `~/.agents/skills/mail-calendar/`；请使用实际调用命令中的绝对路径配置规则。从 Python 版本升级后，旧的 Python 规则不匹配新的 Node.js 调用，需要更新。新增或修改规则后重启 Codex，并用 `codex execpolicy check --pretty --rules <规则文件> -- <命令>` 检查实际决策。

## 服务商预设

可用预设见 `provider list`，单个预设的连接参数见 `provider show`。`auto` 会根据邮箱域名选择预设；其他 IMAP 邮箱使用 `generic`，需要提供 `--mail-host`、`--mail-port` 和 `--mail-auth`。

Google CalDAV 使用 bearer token，集合地址中包含日历 ID。CLI 不负责获取或刷新 OAuth token，需把当前 token 写入 `credentials.json`。

`calendar.base_url` 需要指向提供标准 CalDAV 发现接口的服务端。如果 `calendar list` 或 `config test` 无法发现日历，把已知的日历集合地址直接写入 `calendar.collection_url`；`calendar create` 和 `calendar delete` 不经过发现流程，此时仍然可用。

## 选择日历

执行：

```text
node scripts/mailcal.mjs calendar list
```

如果返回多个日历，把选中日历的 `url` 写入 `~/.mail-calendar-skill/settings.json` 的 `calendar.collection_url`。也可以在执行 `calendar create` 或 `calendar delete` 时传入 `--calendar-url`。

## 认证方式

- IMAP `password`：邮箱密码或服务商签发的客户端授权码。
- IMAP `xoauth2`：OAuth access token。
- CalDAV `basic`：用户名加密码或授权码。
- CalDAV `bearer`：OAuth access token。

更换凭据或服务器地址后执行 `config test`。
