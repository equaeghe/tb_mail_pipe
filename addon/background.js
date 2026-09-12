/*
 * Thunderbird Mail Pipe - background script (event page).
 *
 * Storage schema (storage.local), key "config":
 * {
 *   scratchFolderId: "<MailFolderId string>" | null, // dedicated empty
 *                                     // folder the user creates themselves;
 *                                     // every processed message is imported
 *                                     // here first, then moved to its real
 *                                     // destination - see runActionOnOneMessage
 *   scratchFolderAccountId: "<accountId>" | null, // UI-only, to preselect
 *                                                  // the account when re-editing
 *   actions: [
 *     {
 *       id: "uuid",
 *       name: "Human readable name",
 *       steps: [                                // ordered pipe-chain, output of
 *         {                                      // step N is the stdin of step N+1
 *           command: "/absolute/path/to/script", // must be allow-listed by the native host
 *           argv: []                             // optional extra argv entries for this step
 *         }, ...
 *       ],
 *       timeoutMs: 30000,                        // total budget for the whole chain
 *       importTarget: "same" | "custom",
 *       customFolderId: "<MailFolderId string>" | null,
 *       customFolderAccountId: "<accountId>" | null, // UI-only, to preselect
 *                                                     // the account when re-editing;
 *                                                     // import() only uses customFolderId
 *       carryFlags: true,                       // copy read/flagged state onto the new message
 *       originalAction: "trash" | "delete" | "markRead" | "leave"
 *     }, ...
 *   ],
 *   slotBindings: { "run-action-1": "<action id>", ..., "run-action-9": "<action id>" }
 * }
 *
 * NATIVE HOST protocol (see native-host/tb_mail_pipe_host.py):
 *   request:  { action: "run", steps: [{command, argv}, ...], stdinBase64, timeoutMs }
 *   response: { ok: true, exitCode, stdoutBase64, stderr } | { ok: false, error }
 *   exitCode/stderr refer to whichever step failed, or the last step if all
 *   succeeded (expected 0).
 */

const NATIVE_HOST_NAME = "tb_mail_pipe";
const MENU_ROOT_ID = "tb_mail_pipe-root";

// ---------- storage helpers ----------

async function getConfig() {
  const { config } = await messenger.storage.local.get("config");
  return (
    config || {
      scratchFolderId: null,
      scratchFolderAccountId: null,
      actions: [],
      slotBindings: {},
    }
  );
}

async function setConfig(config) {
  await messenger.storage.local.set({ config });
}

// ---------- base64 <-> ArrayBuffer ----------

function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ---------- context menu ----------

async function rebuildMenu() {
  await messenger.menus.removeAll();
  const { actions } = await getConfig();

  if (!actions || actions.length === 0) {
    return;
  }

  await messenger.menus.create({
    id: MENU_ROOT_ID,
    title: "Thunderbird Mail Pipe",
    contexts: ["message_list"],
  });

  for (const action of actions) {
    await messenger.menus.create({
      id: `mail-pipe-run:${action.id}`,
      parentId: MENU_ROOT_ID,
      title: action.name,
      contexts: ["message_list"],
    });
  }
}

messenger.menus.onClicked.addListener(async (info, tab) => {
  if (!info.menuItemId || !info.menuItemId.startsWith("mail-pipe-run:")) return;
  const actionId = info.menuItemId.slice("mail-pipe-run:".length);
  const { actions, scratchFolderId } = await getConfig();
  const action = actions.find((a) => a.id === actionId);
  if (!action) return;

  const messages = await resolveSelectedMessages(info, tab);
  await runActionOnMessages(action, messages, scratchFolderId);
});

// Thunderbird's menus.onClicked info includes `selectedMessages` for the
// message_list context on recent versions; fall back to mailTabs for safety.
async function resolveSelectedMessages(info, tab) {
  if (info && info.selectedMessages && info.selectedMessages.messages) {
    return info.selectedMessages.messages;
  }
  const list = await messenger.mailTabs.getSelectedMessages(
    tab ? tab.id : undefined,
  );
  return list.messages;
}

// ---------- keyboard shortcut slots ----------

messenger.commands.onCommand.addListener(async (command) => {
  if (!command.startsWith("run-action-")) return;
  const { actions, slotBindings, scratchFolderId } = await getConfig();
  const actionId = slotBindings ? slotBindings[command] : undefined;
  if (!actionId) {
    await notify(
      "Thunderbird Mail Pipe",
      `No action is bound to ${command}. Configure it in the addon options.`,
    );
    return;
  }
  const action = actions.find((a) => a.id === actionId);
  if (!action) {
    await notify(
      "Thunderbird Mail Pipe",
      `The action bound to ${command} no longer exists.`,
    );
    return;
  }
  const list = await messenger.mailTabs.getSelectedMessages();
  await runActionOnMessages(action, list.messages, scratchFolderId);
});

// ---------- core pipeline ----------

async function runActionOnMessages(action, messages, scratchFolderId) {
  if (!messages || messages.length === 0) return;

  let successCount = 0;
  const errors = [];

  for (const message of messages) {
    try {
      await runActionOnOneMessage(action, message, scratchFolderId);
      successCount++;
    } catch (err) {
      console.error(
        `Thunderbird Mail Pipe: action "${action.name}" failed for message ${message.id}`,
        err,
      );
      errors.push(`${message.subject || message.id}: ${err.message || err}`);
    }
  }

  if (errors.length > 0) {
    await notify(
      `Thunderbird Mail Pipe: ${action.name}`,
      `${successCount} succeeded, ${errors.length} failed.\n` +
        errors.slice(0, 5).join("\n"),
    );
  }
}

async function runActionOnOneMessage(action, message, scratchFolderId) {
  if (!scratchFolderId) {
    throw new Error(
      "No scratch folder is configured. Open the add-on's options, create " +
        "an empty folder dedicated to this purpose, and select it under " +
        '"Scratch folder" before running any action.',
    );
  }

  const rawFile = await messenger.messages.getRaw(message.id, {
    data_format: "File",
  });
  const inputBuffer = await rawFile.arrayBuffer();

  if (!action.steps || action.steps.length === 0) {
    throw new Error("Action has no steps configured.");
  }

  const request = {
    action: "run",
    steps: action.steps.map((s) => ({
      command: s.command,
      argv: s.argv || [],
    })),
    stdinBase64: arrayBufferToBase64(inputBuffer),
    timeoutMs: action.timeoutMs || 30000,
  };

  let response;
  try {
    response = await messenger.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      request,
    );
  } catch (err) {
    throw new Error(
      `Could not reach native host "${NATIVE_HOST_NAME}": ${err.message || err}`,
    );
  }

  if (!response) {
    throw new Error("Native host returned no response.");
  }
  if (!response.ok) {
    throw new Error(response.error || "Native host reported an error.");
  }
  if (response.exitCode !== 0) {
    const stderrSnippet = (response.stderr || "").slice(0, 500);
    throw new Error(
      `Chain exited with code ${response.exitCode}. stderr: ${stderrSnippet}`,
    );
  }
  if (!response.stdoutBase64) {
    throw new Error("Script produced no output message.");
  }

  const outputBuffer = base64ToArrayBuffer(response.stdoutBase64);
  const newFile = new File([outputBuffer], "message.eml", {
    type: "message/rfc822",
  });

  const sourceFolder = resolveFolderId(message);
  const destFolder =
    action.importTarget === "custom" && action.customFolderId
      ? action.customFolderId
      : sourceFolder;

  const properties = {};
  if (action.carryFlags) {
    properties.read = message.read;
    properties.flagged = message.flagged;
  }

  // messenger.messages.import() throws "Destination folder already
  // contains a message with id <Message-ID>" if destFolder already holds a
  // message with the same Message-ID header as the one we're importing.
  // Since the script's output normally keeps the original Message-ID
  // intact (as it should - this add-on never rewrites Message-IDs), this
  // can happen whenever destFolder already has *any* message sharing that
  // ID - not just the original message currently being processed, but also
  // e.g. a leftover copy from a previous run. There's no way to reliably
  // rule that out for an arbitrary destFolder, so we never import directly
  // into it. Instead we always import into a dedicated, presumed-empty
  // scratch folder that the user set up for exactly this purpose, and then
  // move the freshly imported message into the real destination - move()
  // is not subject to the same duplicate-Message-ID check.
  if (scratchFolderId === sourceFolder) {
    throw new Error(
      "The configured scratch folder is the same folder this message is " +
        "in. Point the scratch folder setting at a separate, empty " +
        "folder that isn't used as a source or destination by any action.",
    );
  }

  const imported = await messenger.messages.import(
    newFile,
    scratchFolderId,
    properties,
  );

  if (destFolder !== scratchFolderId) {
    await messenger.messages.move([imported.id], destFolder);
  }

  await performOriginalAction(action, message);
}

async function performOriginalAction(action, message) {
  switch (action.originalAction) {
    case "trash":
      await messenger.messages.delete([message.id], false);
      break;
    case "delete":
      await messenger.messages.delete([message.id], true);
      break;
    case "markRead":
      await messenger.messages.update(message.id, { read: true });
      break;
    case "leave":
    default:
      break;
  }
}

// resolveFolderId: Thunderbird MV3's MailFolderId is an opaque string (a
// full MailFolder object, or the old {accountId, path} shape, is no longer
// accepted by messages.import). Message objects are documented to carry
// either a `folderId` string directly, or a `folder` MailFolder object
// whose `.id` is that string - this checks both, and logs the actual shape
// on failure so a mismatch can be diagnosed from the background console
// (Add-ons Manager -> gear -> Debug Add-ons -> Inspect -> Console) instead
// of guessed at blind.
function resolveFolderId(message) {
  if (typeof message.folderId === "string") return message.folderId;
  if (message.folder) {
    if (typeof message.folder === "string") return message.folder;
    if (typeof message.folder.id === "string") return message.folder.id;
  }
  console.error(
    "Thunderbird Mail Pipe: could not resolve a folder id from message object:",
    message,
  );
  throw new Error(
    "Could not determine a MailFolderId for this message - see the background console for the actual message object shape.",
  );
}

async function notify(title, message) {
  try {
    await messenger.notifications.create({
      type: "basic",
      title,
      message,
    });
  } catch (err) {
    console.warn("Thunderbird Mail Pipe: notification failed", err);
  }
}

// ---------- keep the menu in sync with config changes made in the options page ----------

messenger.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.config) {
    rebuildMenu();
  }
});

messenger.runtime.onInstalled.addListener(() => {
  rebuildMenu();
});

messenger.runtime.onStartup.addListener(() => {
  rebuildMenu();
});

// Event pages are unloaded when idle; make sure the menu exists again
// as soon as this script is re-evaluated for any reason.
rebuildMenu();
