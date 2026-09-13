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
- `calendar list` 只列出可见日历集合的名称和 URL；查询具体日程用 `calendar events`，单条详情用 `calendar get`。这三个命令只读，不修改日历或邮件处理状态。
- `calendar events` 必须提供 `--start` 和 `--end`，范围为起始时间包含、结束时间不包含。`YYYY-MM-DD` 按配置时区的零点解释，日期时间必须带明确 UTC 偏移。通过 CalDAV REPORT 请求服务器展开范围内的重复日程及例外实例；不支持 REPORT 或展开的服务器会返回错误，不会回退成不准确的重复日程列表。
- `calendar events` 返回 `{calendar_url, events, total, truncated}`，按开始时间排序，默认最多返回 50 条，可用 `--limit` 调整。`total` 是查询范围和可选 `--summary` 标题子串过滤后、截断前的日程数量；`truncated: true` 时提高限制或缩小范围以免遗漏。限制控制输出数量，不是服务端分页。
- 每条日程包含 `uid`、`summary`、`start`、`end`、`all_day`、`timezone`、`description`、`location`、`url`、`status`、`rrule`、`recurrence_id`、`alarms`、`resource_url` 和 `etag`。`url` 是日程内的关联链接，`resource_url` 才是用于读取或删除的 CalDAV 资源地址。全天日程起止值为日期，结束日期不包含在内；日期时间带时区偏移或 `Z`。
- `calendar get` 的 `--uid` 和 `--url` 至少提供一个；两者都提供时使用 `--url`。UID 查询匹配日程内部 UID，不假定资源文件名等于 UID；找不到时返回 `NOT_FOUND`。返回 `{url, etag, events, ical}`，保留原始 iCalendar；重复日程资源可能包含主事件及多个例外事件，详情不会展开重复规则。
- `calendar events|get|create|delete` 默认使用配置的 `calendar.collection_url`；`--calendar-url` 可以覆盖集合地址。`get --url` 直接读取资源，不需要集合地址。
- `calendar delete` 的 `--uid` 和 `--url` 至少提供一个；两者都提供时使用 `--url`。

## 日程读取示例

```text
node scripts/mailcal.mjs calendar events --start 2026-09-13 --end 2026-09-14
node scripts/mailcal.mjs calendar events --start 2026-09-13 --end 2026-09-20 --summary 会议 --limit 100
node scripts/mailcal.mjs calendar get --uid EVENT_UID
node scripts/mailcal.mjs calendar get --url https://dav.example/calendars/user/default/event.ics
```

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
