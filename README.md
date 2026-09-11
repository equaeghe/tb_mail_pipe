# Thunderbird Mail Pipe — KMail-style manual pipe filters for Thunderbird
_Beware: this is almost fully vibe-coded, so use at your own risk!_

Recreates two pieces of KMail behaviour that Thunderbird lacks natively:

1. Run a user-defined action against the currently selected message(s) via
   the message-list context menu or a keyboard shortcut.
2. As one such action: pipe a message through an external script and import
   the script's stdout as a new message (e.g. turning an HTML-only mail
   into a `multipart/alternative` mail with a generated text part), then
   dispose of the original (trash / delete / mark read / leave).

It's a Thunderbird MailExtension (`addon/`) talking to a small Python
**native messaging host** (`native-host/`), since WebExtensions cannot
spawn external processes directly. Linux only, tested against Thunderbird
155.

This repo intentionally contains only the addon and the host — bring your
own action scripts (e.g. [mailfilters](https://github.com/equaeghe/mailfilters))
and your own Nix packaging for installing the host.

## How it fits together

```
Thunderbird (context menu / shortcut)
        │  messages.getRaw()
        ▼
  background.js  ──runtime.sendNativeMessage──▶  tb_mail_pipe_host.py
        │                                              │ runs your script,
        │◀─────────────── stdout of your script ───────┘ stdin = raw message
        ▼
  messages.import() into a folder, then messages.delete()/update()
  on the original per the action's configuration
```

Each "action" you define in the addon's options page is: an ordered chain
of one or more scripts (each step's stdout feeds the next step's stdin,
like `a | b | c` in a shell), where the final result should land, and what
happens to the original message. Actions show up automatically in the
context menu; you can additionally bind up to 9 of them to keyboard
shortcuts (see "Keyboard shortcuts" below for why it's a fixed number of
slots and what that does and doesn't constrain).

## Script contract

Each step in an action's chain must:

- Read a full raw RFC822 message on **stdin**.
- Write a full raw RFC822 message to **stdout** (the message to pass to
  the next step, or to import if it's the last step; for a no-op pass the
  input through unchanged).
- Optionally accept extra command-line arguments (set per step in the
  options UI) in addition to reading stdin.
- Exit `0` on success. A non-zero exit code from *any* step aborts the
  whole chain at that point — later steps don't run, the original message
  is left untouched, and an error is reported — so partial failures don't
  silently trash a message with no replacement imported.
- Treat stderr as diagnostic-only; it's captured and surfaced in the
  addon's error notification on failure but otherwise ignored.

This is exactly the contract [mailfilters](https://github.com/equaeghe/mailfilters)
scripts already follow for KMail, so pointing an action's step at one of
those should need no changes to the script itself — only registering its
absolute path in the host's allow-list (next section). Since a mailfilters
chain is just this addon's chain by another name, you can drop an entire
existing KMail pipe-chain of mailfilters scripts into one action, one
script per step, in the same order.

## 1. Install the native messaging host

The host only runs scripts explicitly allow-listed by absolute path, read
from a JSON file (default `~/.config/tb-mail-pipe/allowed-scripts.json`,
override with the `TB_MAIL_PIPE_ALLOWLIST` env var). This exists so a bug
in the extension, or in Thunderbird's handling of it, can't be turned into
arbitrary code execution — only scripts you've explicitly opted in to are
reachable.

### Quick manual install (any Linux)

```sh
cd native-host
./install.sh
```

This writes `~/.mozilla/native-messaging-hosts/tb_mail_pipe.json` — the
path Thunderbird actually reads on Linux — pointing at
`tb_mail_pipe_host.py` in place (don't move that file afterwards without
re-running the installer), and creates an empty allow-list file for you to
edit, e.g.:

```json
["/home/you/bin/add-text-alternative.py"]
```

### Packaging it yourself (e.g. in your private Nix overlay)

The host is dependency-free stdlib Python 3, so packaging it is just
"make `native-host/tb_mail_pipe_host.py` executable and put it on the
store path." The two things your packaging needs to produce, matching
what `install.sh` does manually:

1. A native messaging manifest at
   `~/.mozilla/native-messaging-hosts/tb_mail_pipe.json` (Linux path;
   see `native-host/tb_mail_pipe.json.template` for the exact shape):
   ```json
   {
     "name": "tb_mail_pipe",
     "description": "Native messaging host for the Thunderbird Mail Pipe Thunderbird addon",
     "path": "<absolute path to the installed tb_mail_pipe_host.py / wrapper>",
     "type": "stdio",
     "allowed_extensions": ["tb_mail_pipe@localhost"]
   }
   ```
   The `allowed_extensions` value must match
   `browser_specific_settings.gecko.id` in `addon/manifest.json` — don't
   change one without the other.
2. Optionally, an allow-list at `~/.config/tb-mail-pipe/allowed-scripts.json`
   (a JSON array of absolute script paths) written declaratively from
   whatever list of action scripts you configure — this is the natural
   place to plug in paths from your `mailfilters` flake output.

## 2. Install the addon

1. In Thunderbird: hamburger menu → Add-ons and Themes → gear icon →
   "Debug Add-ons" → "Load Temporary Add-on…" → select `addon/manifest.json`.
   This is fine for personal use but is removed on restart. For a
   persistent install, run `./package.sh` to build `tb_mail_pipe.xpi`
   and install that instead (unsigned XPIs require flipping
   `xpinstall.signatures.required` to `false` in about:config, since this
   isn't going through addons.thunderbird.net).
2. Open the addon's options page (Add-ons Manager → Thunderbird Mail Pipe →
   Preferences) and click **+ Add action**. Fill in:
   - **Pipe chain**: one or more steps, each a script path (must exactly
     match an entry in `allowed-scripts.json`) plus optional arguments.
     Use "+ Add step" and the ↑/↓ buttons to build and reorder a chain;
     each step's stdout becomes the next step's stdin.
   - **Import destination**: same folder as the original, or a specific
     account/folder.
   - **Original message handling**: Trash / permanently delete / mark
     read and leave in place / leave completely untouched.
   - **Shortcut slot** (optional): pick one of the 9 slots.
3. If you bound a slot, go to Add-ons Manager → gear icon → "Manage
   Extension Shortcuts" and assign an actual key combination to that
   slot's command.
4. Select one or more messages in the message list and either right-click
   → "Thunderbird Mail Pipe" → your action, or press the shortcut.

## Keyboard shortcuts

WebExtension keyboard shortcuts must be declared as fixed command IDs in
`manifest.json` at install time — there's no API to register a new
shortcut for an action created later at runtime in the options page. The
workaround, used here, is 9 generic pre-declared slots
(`run-action-1`…`run-action-9`) that you map to whichever action you want
via the options page.

The number of slots is just how many are predeclared (raising it is a
one-line-per-slot edit to `manifest.json`'s `commands` block). It has no
bearing on *which key combinations* are available — each slot gets a
normal Thunderbird shortcut picker in "Manage Extension Shortcuts,"
so any modifier/key combination Thunderbird otherwise allows (e.g.
`Ctrl+Shift+K`, `Alt+H`) works for any slot.

## The `messages.import` "same folder" semantics

`importTarget: same` writes the new message into whatever folder the
*original* currently lives in, before that original is trashed/deleted. If
you route the original to Trash, the new message stays in the original
folder, not in Trash — matching "add the processed mail to the mailbox,
move the old one to Trash."

## Pipe chains

An action's steps run sequentially, each one's stdout feeding the next
one's stdin — the addon-side equivalent of `step1 | step2 | step3` in a
shell, orchestrated by the native host rather than an actual shell
pipeline. All steps are validated against the allow-list *before any of
them run*, so a chain never partially executes because a later step turns
out to be misconfigured or disallowed. The action's timeout is a shared
budget across the whole chain, not per step. If a step exits non-zero, the
chain stops there (later steps don't run) and the failure is reported with
that step's stderr.

## Known limitations

- **Manual invocation only.** Actions never run automatically on incoming
  mail — only when triggered. Automatic triggering would need an
  `onNewMailReceived` listener wired to the same pipeline in
  `background.js`; a small addition if wanted later.
- **No native "run existing Thunderbird filter" API.** Thunderbird's
  WebExtension API has no call to re-run one of Thunderbird's own
  built-in filters against arbitrary messages, so this addon implements
  its own independent action system rather than hooking into Thunderbird's
  native filter engine.
- **Large selections**: `mailTabs.getSelectedMessages()` /
  `menus.onClicked`'s `selectedMessages` return a single page of results
  for very large selections (Thunderbird paginates message lists); this
  isn't handled here. Fine for selecting a handful of messages at a time;
  would need `messages.continueList` handling for bulk operations over
  hundreds of messages at once.
- **Security boundary is the allow-list, not a sandbox.** Any script on
  the allow-list runs with your full user privileges, exactly like running
  it from a terminal — the allow-list only prevents scripts you *haven't*
  opted into from being reachable via the addon.
