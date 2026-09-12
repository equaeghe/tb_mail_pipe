const SLOTS = [
  "run-action-1",
  "run-action-2",
  "run-action-3",
  "run-action-4",
  "run-action-5",
  "run-action-6",
  "run-action-7",
  "run-action-8",
  "run-action-9",
];

const NATIVE_HOST_NAME = "tb_mail_pipe";

// [{name, path}], populated from the native host's allow-list so step
// commands can be picked from a dropdown instead of typed/pasted by hand.
let allowedScripts = [];

async function refreshAllowedScripts() {
  try {
    const response = await messenger.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: "list_scripts" },
    );
    if (response && response.ok && Array.isArray(response.scripts)) {
      allowedScripts = response.scripts;
    } else {
      allowedScripts = [];
      console.warn(
        "Thunderbird Mail Pipe: could not load the allow-list:",
        response && response.error,
      );
    }
  } catch (err) {
    allowedScripts = [];
    console.warn(
      "Thunderbird Mail Pipe: native host unreachable while loading the allow-list:",
      err,
    );
  }
}

let config = {
  scratchFolderId: null,
  scratchFolderAccountId: null,
  actions: [],
  slotBindings: {},
};
let editingId = null; // null = creating new
let editingSteps = []; // [{command, argv: [string]}], edited in place while the editor is open

function uuid() {
  return crypto.randomUUID();
}

async function load() {
  const stored = await messenger.storage.local.get("config");
  config = stored.config || {
    scratchFolderId: null,
    scratchFolderAccountId: null,
    actions: [],
    slotBindings: {},
  };
  await populateAccountsInto(document.getElementById("f-account"));
  await populateAccountsInto(document.getElementById("scratch-account"));

  if (config.scratchFolderAccountId) {
    document.getElementById("scratch-account").value =
      config.scratchFolderAccountId;
  }
  await populateFoldersInto(
    document.getElementById("scratch-folder-id"),
    document.getElementById("scratch-account").value,
    config.scratchFolderId,
  );

  render();
}

async function save() {
  await messenger.storage.local.set({ config });
}

async function populateAccountsInto(select) {
  select.innerHTML = "";
  const accounts = await messenger.accounts.list(false);
  for (const acc of accounts) {
    const opt = document.createElement("option");
    opt.value = acc.id;
    opt.textContent = acc.name;
    select.appendChild(opt);
  }
}

// Populates a folder dropdown for the given account. MailFolderId is an
// opaque string in MV3 (no more {accountId, path}), so we look up the
// account's real folder tree and store each folder's actual `.id`, rather
// than trying to construct or guess one.
async function populateFoldersInto(select, accountId, selectedFolderId) {
  select.innerHTML = "";
  if (!accountId) return;

  const account = await messenger.accounts.get(accountId, true);
  if (!account || !account.rootFolder) return;

  const entries = [];
  (function walk(folder, prefix) {
    const label = prefix ? `${prefix}/${folder.name}` : folder.name;
    entries.push({ id: folder.id, label });
    for (const sub of folder.subFolders || []) walk(sub, label);
  })(account.rootFolder, "");

  for (const entry of entries) {
    const opt = document.createElement("option");
    opt.value = entry.id;
    opt.textContent = entry.label;
    select.appendChild(opt);
  }

  if (selectedFolderId) select.value = selectedFolderId;
}

async function populateFoldersForAccount(accountId, selectedFolderId) {
  await populateFoldersInto(
    document.getElementById("f-folder-id"),
    accountId,
    selectedFolderId,
  );
}

async function onScratchAccountChange() {
  await populateFoldersInto(
    document.getElementById("scratch-folder-id"),
    document.getElementById("scratch-account").value,
    null,
  );
  await onScratchFolderChange();
}

async function onScratchFolderChange() {
  config.scratchFolderAccountId =
    document.getElementById("scratch-account").value || null;
  config.scratchFolderId =
    document.getElementById("scratch-folder-id").value || null;
  await save();
}

function slotLabelFor(actionId) {
  for (const slot of SLOTS) {
    if (config.slotBindings[slot] === actionId)
      return slot.replace("run-action-", "Slot ");
  }
  return "—";
}

function chainSummary(action) {
  const steps = action.steps || [];
  if (steps.length === 0) return "(no steps)";
  return steps.map((s) => basename(s.command)).join(" → ");
}

function basename(p) {
  const parts = String(p).split("/");
  return parts[parts.length - 1] || p;
}

function render() {
  const tbody = document.getElementById("actions-body");
  tbody.innerHTML = "";
  for (const action of config.actions) {
    const tr = document.createElement("tr");

    const originalLabel =
      {
        trash: "Move to Trash",
        delete: "Delete permanently",
        markRead: "Leave, mark read",
        leave: "Leave untouched",
      }[action.originalAction] || action.originalAction;

    const destLabel =
      action.importTarget === "custom" ? "custom folder" : "same folder";

    tr.innerHTML = `
      <td>${escapeHtml(action.name)}</td>
      <td><code>${escapeHtml(chainSummary(action))}</code></td>
      <td>${destLabel}</td>
      <td>${originalLabel}</td>
      <td>${slotLabelFor(action.id)}</td>
      <td class="row-actions">
        <button data-edit="${action.id}">Edit</button>
        <button data-delete="${action.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("button[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () =>
      openEditor(btn.getAttribute("data-edit")),
    );
  });
  tbody.querySelectorAll("button[data-delete]").forEach((btn) => {
    btn.addEventListener("click", () =>
      deleteAction(btn.getAttribute("data-delete")),
    );
  });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

// ---------- step-list editing ----------

// Builds the <option> list for one step's command select, given its
// currently stored command (a resolved absolute path, or ""). Returns the
// HTML string plus whether that command matched a known allow-listed
// script (if not, the row should fall back to showing the custom-path
// text input so the value isn't silently lost or hidden).
function commandOptionsHtml(selectedCommand) {
  const opts = ['<option value="">Select a script…</option>'];
  let matched = false;
  for (const s of allowedScripts) {
    const isSelected = s.path === selectedCommand;
    if (isSelected) matched = true;
    opts.push(
      `<option value="${escapeHtml(s.path)}" title="${escapeHtml(s.path)}"${isSelected ? " selected" : ""}>${escapeHtml(s.name)}</option>`,
    );
  }
  const customSelected = selectedCommand && !matched;
  opts.push(
    `<option value="__custom__"${customSelected ? " selected" : ""}>Custom path…</option>`,
  );
  return { html: opts.join(""), matched };
}

function renderSteps() {
  const list = document.getElementById("steps-list");
  list.innerHTML = "";

  editingSteps.forEach((step, i) => {
    const row = document.createElement("div");
    row.className = "step-row";

    const { html: optionsHtml, matched } = commandOptionsHtml(step.command);
    const showCustom = !!step.command && !matched;

    row.innerHTML = `
      <span class="step-index">${i + 1}.</span>
      <div class="step-command-wrap">
        <select class="step-command"></select>
        <input
          type="text"
          class="step-command-custom${showCustom ? "" : " hidden"}"
          placeholder="/absolute/path/to/script"
          value="${escapeHtml(step.command || "")}"
        />
      </div>
      <input type="text" class="step-argv" placeholder="extra args (space separated)" value="${escapeHtml((step.argv || []).join(" "))}" />
      <span class="step-buttons">
        <button type="button" data-up="${i}" ${i === 0 ? "disabled" : ""}>↑</button>
        <button type="button" data-down="${i}" ${i === editingSteps.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" data-remove="${i}">✕</button>
      </span>
    `;
    list.appendChild(row);

    const select = row.querySelector(".step-command");
    select.innerHTML = optionsHtml;
    const customInput = row.querySelector(".step-command-custom");

    select.addEventListener("change", () => {
      if (select.value === "__custom__") {
        customInput.classList.remove("hidden");
        customInput.value = editingSteps[i].command || "";
        customInput.focus();
      } else {
        customInput.classList.add("hidden");
        editingSteps[i].command = select.value;
      }
    });
    customInput.addEventListener("input", (e) => {
      editingSteps[i].command = e.target.value;
    });

    row.querySelector(".step-argv").addEventListener("input", (e) => {
      editingSteps[i].argv = e.target.value.trim()
        ? e.target.value.trim().split(/\s+/)
        : [];
    });

    const upBtn = row.querySelector("[data-up]");
    if (upBtn) upBtn.addEventListener("click", () => moveStep(i, -1));
    const downBtn = row.querySelector("[data-down]");
    if (downBtn) downBtn.addEventListener("click", () => moveStep(i, 1));
    row
      .querySelector("[data-remove]")
      .addEventListener("click", () => removeStep(i));
  });
}

function moveStep(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= editingSteps.length) return;
  const [step] = editingSteps.splice(index, 1);
  editingSteps.splice(target, 0, step);
  renderSteps();
}

function removeStep(index) {
  editingSteps.splice(index, 1);
  renderSteps();
}

function addStep() {
  editingSteps.push({ command: "", argv: [] });
  renderSteps();
}

// ---------- editor ----------

async function openEditor(actionId) {
  editingId = actionId || null;
  const action = actionId
    ? config.actions.find((a) => a.id === actionId)
    : {
        id: uuid(),
        name: "",
        steps: [{ command: "", argv: [] }],
        timeoutMs: 30000,
        importTarget: "same",
        customFolderId: null,
        customFolderAccountId: null,
        carryFlags: true,
        originalAction: "trash",
      };

  editingSteps = (action.steps || [{ command: "", argv: [] }]).map((s) => ({
    command: s.command,
    argv: [...(s.argv || [])],
  }));

  document.getElementById("editor-title").textContent = actionId
    ? "Edit action"
    : "New action";
  document.getElementById("f-name").value = action.name;
  document.getElementById("f-timeout").value = action.timeoutMs || 30000;
  document.getElementById("f-import-target").value =
    action.importTarget || "same";
  document.getElementById("f-carry-flags").checked = !!action.carryFlags;
  document.getElementById("f-original-action").value =
    action.originalAction || "trash";

  if (action.customFolderId) {
    // customFolderAccountId is stored purely so re-opening this action for
    // editing can preselect the right account; the import call itself
    // only ever uses customFolderId.
    document.getElementById("f-account").value =
      action.customFolderAccountId || "";
    populateFoldersForAccount(
      document.getElementById("f-account").value,
      action.customFolderId,
    );
  } else {
    populateFoldersForAccount(document.getElementById("f-account").value, null);
  }

  const slotSelect = document.getElementById("f-slot");
  slotSelect.innerHTML = '<option value="">(none)</option>';
  for (const slot of SLOTS) {
    const boundTo = config.slotBindings[slot];
    if (boundTo && boundTo !== action.id) continue; // slot taken by another action
    const opt = document.createElement("option");
    opt.value = slot;
    opt.textContent = slot.replace("run-action-", "Slot ");
    slotSelect.appendChild(opt);
  }
  let currentSlot = "";
  for (const slot of SLOTS) {
    if (config.slotBindings[slot] === action.id) currentSlot = slot;
  }
  slotSelect.value = currentSlot;

  await refreshAllowedScripts();
  renderSteps();
  document.getElementById("editor").classList.remove("hidden");
  window.scrollTo(0, document.body.scrollHeight);
}

function toggleFolderPicker() {
  const wrap = document.getElementById("folder-picker-wrap");
  const isCustom =
    document.getElementById("f-import-target").value === "custom";
  wrap.classList.toggle("hidden", !isCustom);
}

function closeEditor() {
  document.getElementById("editor").classList.add("hidden");
  editingId = null;
  editingSteps = [];
}

async function deleteAction(actionId) {
  if (!confirm("Delete this action?")) return;
  config.actions = config.actions.filter((a) => a.id !== actionId);
  for (const slot of SLOTS) {
    if (config.slotBindings[slot] === actionId)
      delete config.slotBindings[slot];
  }
  await save();
  render();
}

async function onSaveAction() {
  const name = document.getElementById("f-name").value.trim();
  if (!name) {
    alert("Name is required.");
    return;
  }

  const steps = editingSteps
    .map((s) => ({ command: s.command.trim(), argv: s.argv || [] }))
    .filter((s) => s.command); // drop rows left empty

  if (steps.length === 0) {
    alert("Add at least one step with a script path.");
    return;
  }

  const importTarget = document.getElementById("f-import-target").value;
  let customFolderId = null;
  let customFolderAccountId = null;
  if (importTarget === "custom") {
    const accountId = document.getElementById("f-account").value;
    const folderId = document.getElementById("f-folder-id").value;
    if (!accountId || !folderId) {
      alert("Pick an account and a folder for a custom destination.");
      return;
    }
    customFolderId = folderId;
    customFolderAccountId = accountId;
  }

  const action = {
    id: editingId || uuid(),
    name,
    steps,
    timeoutMs:
      parseInt(document.getElementById("f-timeout").value, 10) || 30000,
    importTarget,
    customFolderId,
    customFolderAccountId,
    carryFlags: document.getElementById("f-carry-flags").checked,
    originalAction: document.getElementById("f-original-action").value,
  };

  const idx = config.actions.findIndex((a) => a.id === action.id);
  if (idx >= 0) config.actions[idx] = action;
  else config.actions.push(action);

  // Update slot binding: clear any previous slot for this action, then set the new one.
  for (const slot of SLOTS) {
    if (config.slotBindings[slot] === action.id)
      delete config.slotBindings[slot];
  }
  const chosenSlot = document.getElementById("f-slot").value;
  if (chosenSlot) config.slotBindings[chosenSlot] = action.id;

  await save();
  render();
  closeEditor();
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  document
    .getElementById("add-action")
    .addEventListener("click", () => openEditor(null));
  document.getElementById("add-step").addEventListener("click", addStep);
  document
    .getElementById("refresh-scripts")
    .addEventListener("click", async () => {
      await refreshAllowedScripts();
      renderSteps();
    });
  document
    .getElementById("save-action")
    .addEventListener("click", onSaveAction);
  document.getElementById("cancel-edit").addEventListener("click", closeEditor);
  document
    .getElementById("f-import-target")
    .addEventListener("change", toggleFolderPicker);
  document.getElementById("f-account").addEventListener("change", (e) => {
    populateFoldersForAccount(e.target.value, null);
  });
  document
    .getElementById("scratch-account")
    .addEventListener("change", onScratchAccountChange);
  document
    .getElementById("scratch-folder-id")
    .addEventListener("change", onScratchFolderChange);
});
