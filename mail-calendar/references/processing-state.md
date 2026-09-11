# 邮件处理状态

CLI 使用一个本地 JSON 文件保存 IMAP 游标和邮件处理结果。后续运行只需要下载新增邮件的邮件头，并继续处理尚未确认的邮件。

## 保存位置

`state.json` 默认保存在用户的 `config.json` 旁边：

- Windows：`%APPDATA%\mail-calendar\state.json`
- macOS：`~/Library/Application Support/mail-calendar/state.json`
- Linux：`${XDG_CONFIG_HOME:-~/.config}/mail-calendar/state.json`

可以设置 `MAILCAL_STATE`，或传入 `--state PATH` 更改位置。该文件属于用户运行数据，不应放进或随 Skill 分发。更新时先写入同目录临时文件，再进行原子替换，避免进程中断后留下不完整的 JSON。

## 处理流程

发现新增邮件，并返回仍待处理的邮件头：

```text
python scripts/mailcal.py mail pending --since 30d --limit 50
```

`mail pending` 会扫描日期范围内的所有新增邮件。不要对这个基于游标的命令增加发件人、主题或未读过滤，否则推进过滤后的游标可能永久跳过邮件。由模型按照用户当前的要求判断返回邮件是否相关；临时的筛选检索使用 `mail search`。

返回结果包含：

- `uidvalidity`：IMAP 邮箱文件夹当前代次的标识。
- `cursor_before`、`cursor_after`：扫描前后的 UID 游标。
- `discovered`：本次新下载的邮件头数量。
- `pending`：尚未确认完成的邮件。

只对可能相关的邮件执行 `mail get` 读取正文。完整处理一封邮件后再进行确认：

```text
python scripts/mailcal.py mail ack --uid 123 --outcome ignored
python scripts/mailcal.py mail ack --uid 124 --outcome created --event-uid EVENT_UID
```

批量确认时，准备一个数组并通过 `--input` 传入：

```json
[
  {"uid": "123", "outcome": "ignored"},
  {"uid": "124", "outcome": "created", "event_uid": "EVENT_UID"}
]
```

```text
python scripts/mailcal.py mail ack --input acknowledgements.json
```

如果一次运行在确认前中断，该邮件会保持待处理状态，并在下次运行时再次出现。

查看游标和数量：

```text
python scripts/mailcal.py mail state
```

需要重新处理一封已确认邮件时：

```text
python scripts/mailcal.py mail retry --uid 124
```

`UIDVALIDITY` 用于防止服务端重复使用旧 UID。当它发生变化时，CLI 会开始一代新的游标，不会把旧 UID 当作当前邮件。
