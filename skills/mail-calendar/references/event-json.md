# 日程 JSON

`calendar create` 接收一个 JSON 对象。

## 必填字段

```json
{
  "summary": "[会议] 项目评审",
  "start": "2026-09-15T14:00:00+08:00"
}
```

## 支持的字段

| 字段 | 含义 |
|---|---|
| `uid` | 稳定的事件标识；提供 `source_id` 时可以省略。 |
| `source_id` | 稳定的来源标识，例如邮件的 `Message-ID`。 |
| `summary` | 日程标题，必填。 |
| `start` | ISO 8601 日期或日期时间，必填。 |
| `end` | ISO 8601 日期或日期时间，可选。 |
| `description` | 纯文本备注。 |
| `location` | 线下地点或会议平台。 |
| `url` | 会议链接或操作链接。 |
| `status` | `CONFIRMED`、`TENTATIVE` 或 `CANCELLED`。 |
| `alarms` | RFC 5545 相对提醒时间，例如 `-PT24H`、`-PT1H`。 |

没有提供 `uid` 时，CLI 会根据 `source_id`、`summary` 和 `start` 生成可重复的 UID。如果 `uid` 和 `source_id` 都不存在，则生成随机 UID。

仅包含日期的值会创建全天日程。全天日程的 `end` 表示不包含该日的结束边界；省略时默认为次日。显式提供的结束时间必须晚于开始时间。带时区偏移的日期时间会转换为 UTC。为避免错误选择时区，不接受没有时区信息的日期时间。提醒时长可能被库规范化，例如 `-PT24H` 与 `-P1D` 表示相同的提前一天。

示例：

```json
{
  "source_id": "<message-id@example.com>#meeting-1",
  "summary": "[会议] 项目评审",
  "start": "2026-09-15T14:00:00+08:00",
  "end": "2026-09-15T15:00:00+08:00",
  "location": "线上会议",
  "url": "https://meeting.example.com/123",
  "description": "来源：会议通知邮件",
  "status": "CONFIRMED",
  "alarms": ["-PT24H", "-PT1H"]
}
```
