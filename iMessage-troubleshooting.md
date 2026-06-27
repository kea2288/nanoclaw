# iMessage Troubleshooting

Install-specific notes for this NanoClaw copy. Not for upstream PRs.

## Symptom: agent works but the user never gets a reply

**Date resolved:** 2026-06-27 · **Agent:** Japbak (`ag-1782539680332-q8ex1a`)

The agent received messages and generated replies, but no reply ever arrived on the phone. Host logs showed the agent was fine — the failure was purely in **delivery**.

### Root cause

The iMessage messaging group's `platform_id` was stored as the **bare phone number** `+1XXXXXXXXXX`. The iMessage Chat-SDK adapter (`chat-adapter-imessage`) requires the thread ID to carry an `imessage:` prefix — its `decodeThreadId` throws otherwise:

```
ValidationError: Invalid iMessage thread ID: +1XXXXXXXXXX
    at iMessageAdapter.decodeThreadId (.../chat-adapter-imessage/dist/index.js:341)
```

So every outbound message failed `decodeThreadId`, retried 3×, then was dropped:

```
WARN  Message delivery failed, will retry … attempt=1
ERROR Message delivery failed permanently, giving up … attempts=3
```

The correct format is `imessage:<chatGuid>`. For a DM the chatGuid is just the handle, so `imessage:+1XXXXXXXXXX`. In local mode the adapter derives the send recipient as `chatGuid.split(";").pop()`, so `imessage:+1XXXXXXXXXX` resolves to recipient `+1XXXXXXXXXX`.

A second complication: a **spurious duplicate** messaging group (`is_group=1`, `unknown_sender_policy=request_approval`) had been auto-created during a failed channel-registration-card attempt, and it already occupied the correctly-prefixed value `imessage:+1XXXXXXXXXX` — tripping the `UNIQUE(channel_type, platform_id, instance)` constraint. It also held foreign-key references in `pending_channel_approvals` and `unregistered_senders`.

### How it was diagnosed

```bash
# 1. Error log told the whole story
tail -40 logs/nanoclaw.error.log        # → "Invalid iMessage thread ID: +1XXXXXXXXXX"

# 2. Inspect the messaging groups (note: thread value lives in platform_id)
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT id, channel_type, platform_id, name, is_group FROM messaging_groups"

# 3. Confirm which group the session is bound to
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT id, messaging_group_id, agent_group_id FROM sessions"
```

### Fix

```bash
# Remove the spurious duplicate group's FK references, delete it, then add the
# imessage: prefix to the real ("Ez") group — all in one statement.
pnpm exec tsx scripts/q.ts data/v2.db "
  DELETE FROM pending_channel_approvals WHERE messaging_group_id='mg-1782544202509-qxpmne';
  DELETE FROM unregistered_senders     WHERE messaging_group_id='mg-1782544202509-qxpmne';
  DELETE FROM messaging_groups         WHERE id='mg-1782544202509-qxpmne';
  UPDATE messaging_groups SET platform_id='imessage:+1XXXXXXXXXX'
    WHERE id='mg-1782539680332-hkkza8';
"

# Restart the host so it re-reads the messaging-group row.
# NOTE: the launchd label is slugged per-install.
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-58fb791d
```

The previously-abandoned reply is not auto-resent (it exhausted its retries) — send a **fresh** iMessage to confirm.

**Verified:** sending a new iMessage produced a reply on the phone.

### Notes / gotchas

- The thread value is the `platform_id` column on `messaging_groups` — there is no `thread_id` column.
- Use `scripts/q.ts` for ad-hoc SQL, not the `sqlite3` CLI (this host doesn't depend on the `sqlite3` binary). It supports writes (single statements via `stmt.run()`, compound via `db.exec()`).
- This may be a `init-first-agent` / setup bug that recurs when wiring a fresh iMessage DM — if a new iMessage agent "replies but nothing arrives," check `platform_id` for the `imessage:` prefix first.
- The launchd service label here is `com.nanoclaw-v2-58fb791d` (find it via `launchctl list | grep nanoclaw`), not the bare `com.nanoclaw`.
