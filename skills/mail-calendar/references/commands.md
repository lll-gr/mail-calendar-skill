# CLI 命令参考

## 基本格式

```text
node scripts/mailcal.mjs <命令组> <子命令> [参数]
```

执行 `node scripts/mailcal.mjs --help` 查看完整的命令树、参数和默认值；每个子命令也支持 `--help`。本文只记录 `--help` 无法表达的行为约定。

命令成功时输出 `{"ok": true, "data": ...}`；失败时向标准错误输出 `{"ok": false, "error": ...}` 并返回非零退出码。

设置、凭据和状态文件固定保存在 `~/.mail-calendar-skill/`，不支持路径覆盖。

## 行为约定

- `mail pending` 是定期增量处理的首选命令，它同时维护扫描游标和待处理队列。不要给它加主题、发件人或未读过滤，原因见 [processing-state.md](processing-state.md)。临时检索历史邮件用 `mail search`，它不修改处理状态。
- 只有用户明确要求检索历史邮件时才使用 `mail search`。
- 邮件命令默认读取 `INBOX`，处理其他文件夹时用 `--folder NAME`。`mail ack` 和 `mail retry` 的 `--folder` 必须与发现邮件时使用的文件夹一致，否则找不到对应记录。
- `mail get` 返回邮件头、纯文本正文和附件元数据；不下载附件内容，也不会把邮件标记为已读。
- `mail ack` 的 `--outcome` 在配合 `--uid` 时统一应用到这些邮件，常用值为 `ignored` 和 `created`。创建了日程时用 `--event-uid` 记录事件 UID；批量确认的输入格式见 [processing-state.md](processing-state.md)。
- 相同 UID 对应同一个 `.ics` 资源，`calendar create` 再次调用会替换该事件，不会产生重复日程。
- `calendar delete` 的 `--uid` 和 `--url` 至少提供一个；两者都提供时使用 `--url`。

## 执行顺序

增量同步一轮：

```text
mail pending → mail get → 判断并提取日程 → calendar create → mail ack
```

只查询不修改日历：

```text
mail search → mail get → 返回结果
```

只有在日程创建成功后才把邮件确认成 `created`。如果读取、解析或创建日程失败，不执行 `mail ack`，让该邮件保留到下一轮重试。
