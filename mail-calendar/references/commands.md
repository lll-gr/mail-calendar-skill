# CLI 命令参考

## 基本格式

```text
python scripts/mailcal.py [--config PATH] [--state PATH] <命令组> <子命令> [参数]
```

全局参数必须放在命令组之前：

| 参数 | 说明 |
|---|---|
| `--config PATH` | 指定配置文件，覆盖 `MAILCAL_CONFIG` 和默认位置。 |
| `--state PATH` | 指定处理状态 JSON，覆盖 `MAILCAL_STATE` 和默认位置。 |
| `--version` | 输出 CLI 版本。 |

命令成功时输出 `{"ok": true, "data": ...}`；失败时向标准错误输出 `{"ok": false, "error": ...}` 并返回非零退出码。

## 服务商预设

```text
python scripts/mailcal.py provider list
python scripts/mailcal.py provider show mail qq
python scripts/mailcal.py provider show calendar qq
```

`provider show` 的第一个位置参数是 `mail` 或 `calendar`，第二个位置参数是预设名称。

## 初始化和检查配置

### `config init`

```text
python scripts/mailcal.py config init --email person@163.com --mail-secret-ref keyring:mail-calendar-imap:person@163.com --calendar-provider qq --calendar-user person@qq.com --calendar-secret-ref keyring:mail-calendar-caldav:person@qq.com
```

| 参数 | 是否必需 | 说明 |
|---|---:|---|
| `--email ADDRESS` | 是 | IMAP 登录邮箱地址。 |
| `--mail-provider NAME` | 否 | 默认 `auto`；也可使用内置预设或 `generic`。 |
| `--mail-host HOST` | 条件必需 | `generic` 邮箱必须提供；也可覆盖预设主机。 |
| `--mail-port PORT` | 否 | 覆盖预设端口；`generic` 默认 993。 |
| `--mail-security ssl\|starttls\|plain` | 否 | 连接安全方式；`generic` 默认 `ssl`。 |
| `--mail-auth password\|xoauth2` | 否 | 邮箱认证方式；可覆盖预设。 |
| `--mail-secret-ref REF` | 是 | `keyring:SERVICE:USERNAME` 或 `env:VARIABLE`。 |
| `--calendar-provider qq\|google\|generic` | 是 | CalDAV 服务商。 |
| `--calendar-url URL` | 否 | CalDAV 基础地址；常用于覆盖预设或配置 `generic`。 |
| `--calendar-collection-url URL` | 否 | 直接指定目标日历集合地址。 |
| `--calendar-user USER` | 条件必需 | `basic` 认证需要用户名。 |
| `--calendar-auth basic\|bearer` | 否 | 覆盖日历认证方式。 |
| `--calendar-secret-ref REF` | 是 | 日历密码、授权码或 token 的安全引用。 |
| `--timezone ZONE` | 否 | 默认 `Asia/Shanghai`。 |
| `--force` | 否 | 覆盖已经存在的配置文件。 |

凭据准备和不同系统的保存方式见 [configuration.md](configuration.md)。

### `config show` 和 `config test`

```text
python scripts/mailcal.py config show
python scripts/mailcal.py config test
```

- `config show` 输出当前配置和路径，不解析或输出实际密码。
- `config test` 实际连接 IMAP，并通过 CalDAV 发现日历，用于验证凭据和服务器地址。

## 读取邮件

### `mail folders`

```text
python scripts/mailcal.py mail folders
```

列出服务器上的 IMAP 文件夹。其他邮件命令默认读取 `INBOX`；处理其他文件夹时使用 `--folder NAME`。

### `mail pending`

```text
python scripts/mailcal.py mail pending --since 30d --limit 50 --scan-limit 200
```

这是定期增量处理的首选命令。它扫描新增邮件头，并返回尚未确认完成的邮件。

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--folder NAME` | `INBOX` | IMAP 文件夹。 |
| `--since VALUE` | `30d` | 扫描起始日期，支持 `YYYY-MM-DD`、`Nd`、`Nw`。 |
| `--limit N` | 50 | 本次最多返回多少封待处理邮件。 |
| `--scan-limit N` | 200 | 本次最多下载多少个新增邮件头。 |

不要给增量游标添加主题、发件人或未读过滤；详细原因见 [processing-state.md](processing-state.md)。

### `mail search`

```text
python scripts/mailcal.py mail search --since 2026-08-01 --subject 会议 --from example.com --limit 20
python scripts/mailcal.py mail search --since 2w --unseen
```

用于用户明确要求的历史或临时检索，不修改增量处理状态。

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--folder NAME` | `INBOX` | IMAP 文件夹。 |
| `--since VALUE` | `30d` | 支持 `YYYY-MM-DD`、`Nd`、`Nw`。 |
| `--limit N` | 50 | 最多返回多少个邮件头。 |
| `--subject TEXT` | 无 | 按主题搜索。 |
| `--from TEXT` | 无 | 按发件人搜索。 |
| `--unseen` | 否 | 只搜索 IMAP 未读邮件。 |

### `mail get`

```text
python scripts/mailcal.py mail get --uid 123
python scripts/mailcal.py mail get --folder 通知 --uid 123
```

`--uid UID` 必需，`--folder NAME` 默认 `INBOX`。返回邮件头、纯文本正文和附件元数据，不下载附件内容，也不会把邮件标记为已读。

### `mail ack`

处理完成后确认一封或多封已登记的邮件：

```text
python scripts/mailcal.py mail ack --uid 123 --outcome ignored
python scripts/mailcal.py mail ack --uid 124 --outcome created --event-uid EVENT_UID
python scripts/mailcal.py mail ack --uid 125 --uid 126 --outcome processed
```

| 参数 | 说明 |
|---|---|
| `--folder NAME` | 默认 `INBOX`，必须与发现邮件时的文件夹一致。 |
| `--uid UID` | 邮件 UID；可以重复传入。 |
| `--input PATH` | 从 JSON 数组批量读取；`-` 表示标准输入。与 `--uid` 二选一。 |
| `--outcome VALUE` | 使用 `--uid` 时应用于这些邮件，默认 `processed`；常用值为 `ignored`、`created`。 |
| `--event-uid UID` | 创建了日程时保存对应事件 UID。 |

批量输入格式：

```json
[
  {"uid": "123", "outcome": "ignored"},
  {"uid": "124", "outcome": "created", "event_uid": "EVENT_UID"}
]
```

### `mail retry` 和 `mail state`

```text
python scripts/mailcal.py mail retry --uid 124
python scripts/mailcal.py mail retry --uid 124 --uid 125
python scripts/mailcal.py mail state
```

- `mail retry` 把一个或多个已确认 UID 恢复为待处理；`--uid` 可以重复，`--folder` 默认 `INBOX`。
- `mail state` 显示指定文件夹的 `UIDVALIDITY`、游标和待处理/已处理数量；`--folder` 默认 `INBOX`。

## 管理日历

### `calendar list`

```text
python scripts/mailcal.py calendar list
```

发现当前账号可访问的 CalDAV 日历集合。需要固定目标日历时，把返回的 `url` 保存为 `calendar.collection_url`。

### `calendar create`

```text
python scripts/mailcal.py calendar create --input event.json
python scripts/mailcal.py calendar create --input -
python scripts/mailcal.py calendar create --input event.json --calendar-url CALENDAR_COLLECTION_URL
```

| 参数 | 说明 |
|---|---|
| `--input PATH` | 必需。事件 JSON 文件；`-` 表示从标准输入读取。 |
| `--calendar-url URL` | 临时覆盖配置中的目标日历集合地址。 |

相同 UID 对应同一个 `.ics` 资源，再次创建会替换该事件。事件字段见 [event-json.md](event-json.md)。成功结果中的 `uid` 应保存到对应邮件的 `mail ack --event-uid`。

### `calendar delete`

```text
python scripts/mailcal.py calendar delete --uid EVENT_UID
python scripts/mailcal.py calendar delete --url EVENT_RESOURCE_URL
```

| 参数 | 说明 |
|---|---|
| `--uid UID` | 根据配置的日历集合地址拼出事件资源地址。 |
| `--url URL` | 直接指定完整事件资源地址。 |
| `--calendar-url URL` | 使用 `--uid` 时临时覆盖日历集合地址。 |

`--uid` 和 `--url` 至少提供一个；两者都提供时使用 `--url`。

## 常用执行顺序

增量同步一轮：

```text
mail pending → mail get → 判断并提取日程 → calendar create → mail ack
```

只查询不修改：

```text
mail search → mail get → 返回结果
```

只有在日程创建成功后才把邮件确认成 `created`。如果读取、解析或创建日程失败，不执行 `mail ack`，让该邮件保留到下一轮重试。
