# @artymaximus/n8n-nodes-yandex-mail

Community nodes for **Yandex Mail** in n8n: a poll trigger and mailbox/message actions.

Yandex advertises IMAP `IDLE` but drops long sockets (`ECONNRESET` / `EPIPE`). This package never uses IDLE. Each tick opens one short IMAP session, sends `ID`, does the work, then `LOGOUT`.

Measured against Yandex 360 (`imap.yandex.ru:993`): `IDLE`, `ID`, `MOVE`, `UIDPLUS`, `XLIST`, `NAMESPACE`, `AUTH=XOAUTH2`. Hierarchy delimiter is `|`. Spam is `Spam` with `\Junk`.

Send uses SMTP on `smtp.yandex.ru` or `smtp.ya.ru`, port **465** + TLS, with the same app password as IMAP.

## Nodes

### Yandex Mail Trigger

Polls one or more folders in a single short session and starts the workflow with one item per new message.

- Folder list (default `INBOX`) plus optional Junk in the same session
- **Include Junk Folder defaults to on.** Turn it off if you only want the folders you picked
- UID cursor per folder (`uidValidity` + `lastUid`). Never `SEARCH ALL`
- `fetchOnlyNew` on first start / UIDVALIDITY change
- Max emails per poll (default 10, max 50). Leftovers wait for the next tick
- Quiet retries on RST; workflow stays active. Optional webhook after N failed polls
- Filters: exclude senders, subject regex (invalid regex is ignored), max size
- Manual Execute Step does not advance the cursor unless you opt in
- `Mark as Read` defaults to off. If you turn it on, IMAP `STORE \Seen` runs **after** `FETCH` finishes — imapflow allows only one command in flight, so a `STORE` inside the fetch iterator kills the socket (`Connection not available`)
- **Download Attachments** is on by default. Files land on `$binary.attachment_0`, `$binary.attachment_1`, … — the same keys as Email Read IMAP. `Extract From File` and `IF {{ $binary.attachment_0 }} exists` work without remapping
- Inline CID images stay off `$binary` unless you enable **Include Inline Attachments**, so a real CSV/PDF stays `attachment_0`
- JSON keeps `hasAttachments`, `attachmentCount`, and `attachments[]` with `filename`, `contentType`, `size`, `binaryProperty` (`attachment_0` matches `attachments[0]`)

A poll that finds N messages returns **N items**. Downstream nodes that loop items (Mark / Move with `{{ $json.uid }}`) do not need Split Out.

### Yandex Mail

**Mailbox**

- **List** — folders + XLIST flags (`\Inbox`, `\Junk`, `\Trash`, `\Sent`)
- **Get Status** — messages / unseen / UIDNEXT / UIDVALIDITY
- **Diagnose** — CAPABILITY, greeting ms, folders, `sc=`-friendly errors
- **Create Folder** — IMAP `CREATE`. Nested path uses `|`, for example `n8n-node-tests|sub`. Idempotent if the folder already exists
- **Delete Folder** — only empty custom folders. System folders (INBOX / Sent / Trash / Spam / Drafts) are refused

**Message**

- **Get / Get Many** — same parsed shape and `$binary.attachment_*` keys as the trigger. Get accepts UID and/or RFC Message-ID
- **Move / Copy** — `MOVE`/`COPY` + UIDPLUS. Output keeps `uid` / `mailbox` / `messageId` so a later button can act again
- **Mark** — read / unread / flagged / unflagged
- **Delete** — Trash by default (returns the new UID there), or permanent expunge
- **Append** — IMAP `APPEND` into a folder, no SMTP. Useful for isolated tests. Generated Message-ID looks like `n8n-yandex-test.*@n8n.test`. From is the credential email
- **Send** — SMTP through the matching Yandex host. From is the credential email. Optional HTML; text stays as the plain part. **Binary Attachments** defaults to `*` and forwards every `$binary` file from the incoming item (or list `attachment_0, attachment_1`)

Get / Move / Copy / Mark / Delete locate by UID first. If the UID is gone, they scan by Message-ID. Yandex `SEARCH HEADER Message-ID` is often empty, so the node falls back to the last ~400 envelopes in that folder. When Message-ID is set, it also walks other folders and **skips Sent / Trash / Spam / INBOX** unless that folder is the start mailbox or the destination — otherwise a leftover copy in Sent steals the first hit.

Do not run **Get Many** on Sent or INBOX with `fromUid = 1` on a live mailbox. That dumps real mail.

## Credentials

Yandex Mail API:

- Full email (`name@yandex.ru` or a Yandex 360 address)
- **App password** for Mail, not the account password
- Host preset: `imap.yandex.ru` (default) or `imap.ya.ru`. Port 993 + TLS are fixed
- Optional **Yandex Account UID** — digits from the browser URL `?uid=…` (or paste the whole `mail.360.yandex.ru` link). Used only to build `webUrl`
- Saving the credential runs a live IMAP diagnose (CAPABILITY + INBOX status)

Enable IMAP in the mailbox: Yandex Mail → Settings → Mail clients.

## Install

```text
Settings → Community nodes → Install @artymaximus/n8n-nodes-yandex-mail
```

Self-hosted / Harbor: pin the version next to other community packages.

## Output fields

Trigger / Get / Get Many: `uid`, `mailbox` / `source_mailbox`, `subject`, `from`, `fromEmail`, `to`, `cc`, `date`, `html`, `text`, `messageId`, `inReplyTo`, `references[]`, `headers`, `flags`, `size`, `hasAttachments`, `attachmentCount`, `attachments[]` (`filename`, `contentType`, `size`, `binaryProperty`), `webUrl`. Files: `$binary.attachment_0` …

`webUrl` is a Yandex 360 search link by RFC Message-ID (`?uid=<accountUid>#search?request=msgid:…`). Empty if the credential has no Account UID or the letter has no Message-ID. This is not `#/message/<mid>` — that web store id is not on IMAP.

Move / Copy / Delete (trash): `uid`, `mailbox`, `source_mailbox`, `previousUid`, `previousMailbox`, `messageId`, `webUrl`, `moved`, `alreadyInDestination`.

Send: `accepted`, `rejected`, `messageId`, `webUrl`, `response`, `host`, `attachedCount`, `attachedFilenames`.

Append: `uid`, `mailbox`, `messageId`, `webUrl`, `appended`.

## License

MIT
