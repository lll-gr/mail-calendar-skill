# 配置

每次安装只配置一个邮箱和一个日历。不同用户安装同一个 Skill 后，分别保存自己的本地配置和凭据。

## 默认位置

- Windows：`%APPDATA%\mail-calendar\config.json`
- macOS：`~/Library/Application Support/mail-calendar/config.json`
- Linux：`${XDG_CONFIG_HOME:-~/.config}/mail-calendar/config.json`

可以设置 `MAILCAL_CONFIG`，或传入 `--config PATH` 更改配置文件位置。

邮件处理状态单独保存在配置文件旁的 `state.json` 中，详见 [processing-state.md](processing-state.md)。可以设置 `MAILCAL_STATE`，或传入 `--state PATH` 更改位置。

## 保存凭据

推荐使用 Python `keyring`。它会调用当前系统的凭据存储：

- Windows：Windows 凭据管理器
- macOS：钥匙串访问（Keychain）
- Linux：通常为 Secret Service 或 KWallet，取决于桌面环境

如果邮箱和日历使用同一个账号，并且服务商允许 IMAP 和 CalDAV 共用同一个密码或授权码，只需写入一次：

```text
python -m pip install keyring
python -m keyring set mail-calendar person@example.com
```

命令会交互式读取密码或授权码，不要把密码直接写在命令行中。邮箱和日历都使用同一个配置引用：

```text
keyring:mail-calendar:person@example.com
```

只有在邮箱和日历使用不同账号、不同授权码，或者需要不同类型的 OAuth token 时，才分别创建两个 keyring 条目，并为 `mail.secret_ref` 和 `calendar.secret_ref` 配置不同引用。

也可以使用 `env:VARIABLE_NAME` 从环境变量读取凭据，适合临时测试或已有安全注入机制的环境。不要把明文密码或授权码写入 Skill 目录、`config.json` 或 `state.json`。

## 初始化

优先使用服务商预设：

```text
python scripts/mailcal.py config init \
  --email person@qq.com \
  --mail-provider qq \
  --mail-secret-ref keyring:mail-calendar:person@qq.com \
  --calendar-provider qq \
  --calendar-user person@qq.com \
  --calendar-secret-ref keyring:mail-calendar:person@qq.com
```

凭据引用支持：

- `keyring:SERVICE:USERNAME`
- `env:VARIABLE_NAME`

## 服务商预设

邮箱预设包括 `qq`、`netease163`、`netease126`、`netease-yeah`、`aliyun`、`gmail` 和 `outlook`。`auto` 会根据邮箱域名选择预设。其他 IMAP 邮箱可使用 `generic`，并提供 `--mail-host`、`--mail-port` 和 `--mail-auth`。

日历预设包括 `qq`、`google` 和 `generic`。Google CalDAV 使用 bearer token，集合地址中包含日历 ID。CLI 不负责获取或刷新 OAuth 令牌，应通过凭据引用提供当前令牌，或配合能够管理 OAuth 的凭据工具。

当 CalDAV 基础地址只包含主机根地址时，CLI 会按 RFC 6764 尝试 `/.well-known/caldav`，跟随同源 HTTP 重定向到实际服务路径，并在标准入口不存在时回退到根地址。配置中已经包含明确服务路径时，优先使用该路径。

预设只是默认值。生成配置后仍可修改主机、端口、安全方式、认证方式、基础地址和日历集合地址。

## 选择日历

执行：

```text
python scripts/mailcal.py calendar list
```

如果返回多个日历，把选中日历的 `url` 写入本地配置的 `calendar.collection_url`。也可以在执行 `calendar create` 或 `calendar delete` 时传入 `--calendar-url`。

## 认证方式

- IMAP `password`：邮箱密码或服务商签发的客户端授权码。
- IMAP `xoauth2`：由凭据引用提供 OAuth access token。
- CalDAV `basic`：用户名加密码或授权码。
- CalDAV `bearer`：由凭据引用提供 OAuth access token。

更换凭据或服务器地址后执行 `config test`。
