const MODULE_ID = "sr6-edge-qualities";
const SYSTEM_NAME = "shadowrun6-eden";
const ANALYTICAL_MIND_ATTRIB = "log";
const COMPENDIUM_NAME = "qualities";

console.log(`${MODULE_ID} | Script file loaded`);

// Quality identifiers - matches by genesisID or name (case-insensitive)
const ANALYTICAL_MIND_IDS = ["analytical_mind", "analytischer_verstand"];
const ANALYTICAL_MIND_NAMES = ["analytical mind"];
const ATTRIBUTE_MASTERY_IDS = ["attribute_mastery"];
const ATTRIBUTE_MASTERY_NAMES = ["attribute mastery"];

const PRIMARY_ATTRIBUTES = [
  "bod",
  "agi",
  "rea",
  "str",
  "wil",
  "log",
  "int",
  "cha",
];

/**
 * Test whether an item matches any of the given quality identifiers/names.
 * Name matching uses startsWith so "Attribute Mastery (Logic)" still matches
 * the base name "attribute mastery".
 */
function qualityMatches(item, genesisIds, names) {
  if (item.type !== "quality") return false;
  const gid = (item.system?.genesisID || "").toLowerCase().trim();
  if (genesisIds.some((id) => gid === id)) return true;
  const n = item.name.toLowerCase().trim();
  return names.some((name) => n === name || n.startsWith(name + " ("));
}

/**
 * Check if an actor has a quality matching any of the given identifiers/names.
 * Returns the first matching quality item, or null.
 */
function findQuality(actor, genesisIds, names) {
  if (!actor?.items) return null;
  return (
    actor.items.find((item) => qualityMatches(item, genesisIds, names)) ?? null
  );
}

/**
 * Find ALL quality items matching the given identifiers/names.
 */
function findAllQualities(actor, genesisIds, names) {
  if (!actor?.items) return [];
  return actor.items.filter((item) => qualityMatches(item, genesisIds, names));
}

/**
 * Get the attribute configured for Attribute Mastery on this actor.
 * Stored as a flag on the quality item itself.
 */
function getAttributeMasteryAttrib(qualityItem) {
  return qualityItem?.getFlag(MODULE_ID, "attribute") ?? null;
}

/** Long attribute names (V2 actors) to the short ids this module stores. */
const LONG_TO_SHORT = {
  body: "bod", agility: "agi", reaction: "rea", strength: "str",
  willpower: "wil", logic: "log", intuition: "int", charisma: "cha",
};

/**
 * Reduce a roll's attribute to the short id (bod, agi, ... cha). Eden 3.3.9 puts the bare id ("log") in the roll;
 * Eden 4.x puts a path ("system.attributes.log.pool", or ".logic.pool" on a V2 actor). Both must match.
 */
function normalizeAttrib(attrib) {
  if (typeof attrib !== "string") return null;
  const id = attrib.replace(/^system\.attributes\./, "").replace(/\.(pool|base|rank|mod|value)$/, "");
  return LONG_TO_SHORT[id] ?? id;
}

/**
 * Determine the attribute being used in a roll from the prepared roll data.
 */
function getRollAttribute(prepared) {
  return normalizeAttrib(prepared?.attrib);
}

/**
 * Calculate how much bonus edge the actor should gain from qualities for a
 * roll using the given attribute. Returns { total, sources[] }.
 */
function calcQualityEdgeBonus(actor, attrib) {
  const sources = [];

  // Analytical Mind: +1 edge on Logic tests
  const am = findQuality(actor, ANALYTICAL_MIND_IDS, ANALYTICAL_MIND_NAMES);
  if (am && attrib === ANALYTICAL_MIND_ATTRIB) {
    sources.push({
      quality: am.name,
      value: 1,
    });
  }

  // Attribute Mastery: +1 edge on tests using the chosen attribute.
  // An actor may have multiple copies, each configured for a different attribute.
  const masteries = findAllQualities(
    actor,
    ATTRIBUTE_MASTERY_IDS,
    ATTRIBUTE_MASTERY_NAMES,
  );
  for (const mastery of masteries) {
    const masteryAttrib = getAttributeMasteryAttrib(mastery);
    if (masteryAttrib && attrib === masteryAttrib) {
      sources.push({
        quality: mastery.name, // e.g. "Attribute Mastery (Logic)"
        value: 1,
      });
      break; // Only +1 even if multiple copies target the same attribute
    }
  }

  return {
    total: sources.reduce((sum, s) => sum + s.value, 0),
    sources,
  };
}

/** Escape a value for use inside chat card HTML: quality and actor names are user-editable text. */
function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

/**
 * The update path of an actor's current Edge. V2 (DataModel) actors store it at `system.edge.current`; `edge.value` is only
 * a compatibility getter there. Legacy actors (Eden 3.3.9, 4.x Player/NPC) keep `system.edge.value`. Same rule as Eden's own
 * `edgeUpdate` (module/util/edge.mjs), which a module cannot import, so it is repeated here.
 */
function edgePath(actor) {
  return actor?.isActorV2 ? "system.edge.current" : "system.edge.value";
}

/**
 * Get the maximum edge the actor can still gain this round, respecting the
 * system's maxEdgePerRound setting and the combat tracker's per-combatant
 * tracking of edge already gained.
 */
function getMaxEdgeGainRemaining(actor) {
  let max;
  try {
    max = game.settings.get(SYSTEM_NAME, "maxEdgePerRound");
  } catch (e) {
    // Setting may not exist in this version of the system
  }
  const combat = game.combat;
  if (combat && typeof combat.getMaxEdgeGain === "function") {
    const combatMax = combat.getMaxEdgeGain(actor);
    if (Number.isFinite(combatMax)) max = combatMax;
  }
  // Fallback: SR6 default is 2 edge gain per round
  if (!Number.isFinite(max)) max = 2;
  return max;
}

/**
 * After the system's _onCalcEdge runs, inject quality-based edge bonuses
 * while respecting both the per-round cap and the absolute 7-edge cap.
 * Logs decisions to the console for debugging.
 */
function applyEdgeBonusToDialog(dialog) {
  const actor = dialog.actor;
  const prepared = dialog.prepared;
  const configured = dialog.dialogResult;
  if (!actor || !configured?.actor) {
    console.log(`${MODULE_ID} | applyEdgeBonusToDialog: no actor or configured.actor`);
    return;
  }

  const attrib = getRollAttribute(prepared);
  if (!attrib) {
    console.log(`${MODULE_ID} | applyEdgeBonusToDialog: no attrib on prepared roll`);
    return;
  }

  console.log(`${MODULE_ID} | Roll uses attribute: ${attrib}`);
  const bonus = calcQualityEdgeBonus(actor, attrib);
  console.log(`${MODULE_ID} | Quality edge bonus: ${bonus.total}`, bonus.sources);
  if (bonus.total <= 0) return;

  // Read current actor edge from system data
  const actorEdge = actor.system.edge.value;

  // The system has already set configured.edgePlayer and capped it at the
  // per-round max. We need to add our bonus but re-apply both caps.
  const systemGain = configured.edgePlayer || 0;
  const perRoundMax = getMaxEdgeGainRemaining(actor);
  const absoluteMax = Math.max(0, 7 - actorEdge);

  // The total gain (system + quality) must not exceed either cap
  const totalDesired = systemGain + bonus.total;
  const totalAllowed = Math.min(totalDesired, perRoundMax, absoluteMax);
  const applied = totalAllowed - systemGain;
  console.log(`${MODULE_ID} | Edge caps: system gain ${systemGain}, per-round room ${perRoundMax}, room to 7 ${absoluteMax}, allowed ${totalAllowed}, applied ${applied}, dialog element ${dialog._element?.[0] ? "present" : "missing"}`);

  if (applied <= 0) return;

  // PREVIEW ONLY. Do not write the bonus into configured.edgePlayer: Eden awards configured.edgePlayer itself when the dialog closes
  // (Rolls.js _dialogClosed), and this module awards the quality Edge once, from the createChatMessage hook below. Writing it here
  // as well made every roll pay the bonus twice. This function only shows the number, so it is safe to run any number of times.
  dialog.edge = Math.min(7, actorEdge + totalAllowed);

  // Update display
  const el = dialog._element?.[0];
  if (!el) return;

  const edgeValue = el.getElementsByClassName("edge-value")[0];
  if (edgeValue) {
    edgeValue.innerText = dialog.edge.toString();
  }

  // Append quality info to edge label
  const edgeLabel = el.querySelector("#edgeLabel");
  if (edgeLabel) {
    const qualityNames = bonus.sources.map((s) => s.quality).join(", ");
    const bonusText = game.i18n.format("sr6eq.edgeBonus", {
      value: applied,
      quality: qualityNames,
    });
    if (edgeLabel.innerText) {
      edgeLabel.innerText += "\n" + bonusText;
    } else {
      edgeLabel.innerText = bonusText;
    }
    // If capped, indicate it
    if (totalDesired > totalAllowed) {
      edgeLabel.innerText += ` (${game.i18n.localize("sr6eq.capped")})`;
    }
    // Remember what we wrote, so the label observer can tell our own write from Eden's later rewrite.
    dialog._sr6eq_lastLabel = edgeLabel.innerText;
  }

  // Refresh edge boost dropdown with new edge value
  const boostSelect = el.getElementsByClassName("edgeBoosts")[0];
  if (boostSelect && typeof dialog._updateEdgeBoosts === "function") {
    dialog._updateEdgeBoosts(boostSelect, dialog.edge);
  }
}

/**
 * Hook into RollDialog rendering to wrap _onCalcEdge.
 */
function onRenderDialog(app, html, data) {
  // Identify SR6 RollDialog by checking for its specific properties
  if (!app.dialogResult || !app.prepared || !app.actor) {
    console.log(`${MODULE_ID} | onRenderDialog: not an SR6 RollDialog (missing dialogResult/prepared/actor)`, app.constructor.name);
    return;
  }
  console.log(`${MODULE_ID} | Detected SR6 RollDialog — patching _onCalcEdge`);

  // Wrap _onCalcEdge once per dialog instance
  if (!app._sr6eq_patched) {
    const original = app._onCalcEdge.bind(app);
    app._onCalcEdge = function (event) {
      original(event);
      applyEdgeBonusToDialog(app);
    };
    app._sr6eq_patched = true;
  }

  // Also handle the _onAttribChange case - when the player switches
  // the attribute for a roll, we need to recalculate
  if (!app._sr6eq_attribPatched) {
    const origAttrib = app._onAttribChange.bind(app);
    app._onAttribChange = function (event) {
      origAttrib(event);
      applyEdgeBonusToDialog(app);
    };
    app._sr6eq_attribPatched = true;
  }

  // Apply on initial render
  applyEdgeBonusToDialog(app);

  // Eden binds its own _onCalcEdge before this hook runs (activateListeners: change handlers and html.show(...), which fires after the
  // show animation), so those calls bypass the wrapper above, rewrite #edgeLabel to "No one gets Edge" and reset configured.edgePlayer
  // to 0. Watch the label and apply again after every rewrite that is not ours. Eden resets edgePlayer first, so this cannot count twice.
  observeEdgeLabel(app);
}

/** The #edgeLabel node of a dialog. */
function edgeLabelOf(app) {
  return app._element?.[0]?.querySelector?.("#edgeLabel") ?? null;
}

/**
 * Observe the dialog's current #edgeLabel node (a re-render replaces the node, so a new observer follows it) and apply the bonus
 * again after every rewrite that is not ours. The observer is disconnected when the dialog closes.
 */
function observeEdgeLabel(app) {
  const label = edgeLabelOf(app);
  if (!label || app._sr6eq_observedLabel === label) return;
  app._sr6eq_labelObserver?.disconnect();
  const observer = new MutationObserver(() => {
    const current = edgeLabelOf(app);
    if (current && current !== app._sr6eq_observedLabel) {
      observeEdgeLabel(app);
      applyEdgeBonusToDialog(app);
      return;
    }
    if ((current ?? label).innerText === app._sr6eq_lastLabel) return; // our own write
    applyEdgeBonusToDialog(app);
  });
  observer.observe(label, { childList: true, characterData: true, subtree: true });
  app._sr6eq_labelObserver = observer;
  app._sr6eq_observedLabel = label;
}

function onCloseDialog(app) {
  app._sr6eq_labelObserver?.disconnect();
  app._sr6eq_labelObserver = null;
  app._sr6eq_observedLabel = null;
}

/**
 * Inject a configure button for Attribute Mastery qualities on the actor sheet.
 */
function onRenderActorSheet(app, html, data) {
  const actor = app.actor;
  if (!actor) return;

  // Quality rows are <tr class="item list-item" data-item-id="...">
  html.find("tr.item.list-item[data-item-id]").each(function () {
    const row = this;
    const itemId = row.dataset.itemId;
    if (!itemId) return;

    const item = actor.items.get(itemId);
    if (!item) return;
    if (!qualityMatches(item, ATTRIBUTE_MASTERY_IDS, ATTRIBUTE_MASTERY_NAMES))
      return;

    // Find the controls cell (last <td> with edit/delete buttons)
    const controlsTd = row.querySelector("td:last-child");
    if (!controlsTd) return;

    // Don't add the button twice
    if (controlsTd.querySelector(".sr6eq-configure")) return;

    // Create a gear button matching the system's style
    const btn = document.createElement("a");
    btn.classList.add("item-control", "sr6eq-configure");
    btn.title = game.i18n.localize("sr6eq.configTitle");
    btn.innerHTML = '<i class="fas fa-cog"></i>';
    btn.style.marginRight = "4px";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showAttributeMasteryConfig(item);
    });

    // Insert before the existing edit button
    controlsTd.prepend(btn);
  });
}

/**
 * Show a dialog to pick which attribute Attribute Mastery applies to.
 */
async function showAttributeMasteryConfig(qualityItem) {
  const current = getAttributeMasteryAttrib(qualityItem) || "";

  const options = PRIMARY_ATTRIBUTES.map(
    (key) =>
      `<option value="${key}" ${key === current ? "selected" : ""}>${game.i18n.localize(`sr6eq.attrib.${key}`)}</option>`,
  ).join("");

  const content = `
    <form>
      <div class="form-group">
        <label>${game.i18n.localize("sr6eq.selectAttribute")}</label>
        <select name="attribute">${options}</select>
      </div>
    </form>
  `;

  new Dialog({
    title: game.i18n.localize("sr6eq.configTitle"),
    content,
    buttons: {
      save: {
        icon: '<i class="fas fa-check"></i>',
        label: "Save",
        callback: async (html) => {
          const attr = html.find('select[name="attribute"]').val();
          await qualityItem.setFlag(MODULE_ID, "attribute", attr);
          const label = game.i18n.localize(`sr6eq.attrib.${attr}`);
          await qualityItem.update({
            name: `Attribute Mastery (${label})`,
          });
          ui.notifications.info(
            `Attribute Mastery set to ${label}`,
          );
        },
      },
      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancel",
      },
    },
    default: "save",
  }).render(true);
}

// ── Compendium population ──────────────────────────────────────────────

const COMPENDIUM_ITEMS = [
  {
    name: "Analytical Mind",
    type: "quality",
    img: "icons/svg/eye.svg",
    system: {
      genesisID: "analytical_mind",
      description:
        "Your character is exceptionally logical. Gain +1 edge on any test that uses Logic.",
      product: "SR6 Core",
      page: 0,
      category: "ADVANTAGE",
      level: false,
      value: 0,
      explain: "+1 edge on Logic-linked tests",
      modifier: [],
    },
  },
  {
    name: "Attribute Mastery",
    type: "quality",
    img: "icons/svg/upgrade.svg",
    system: {
      genesisID: "attribute_mastery",
      description:
        "Your character has an innate edge when using a specific attribute. Gain +1 edge on any test linked to the chosen attribute. After adding to a character, Shift+Double-click or right-click to configure which attribute.",
      product: "SR6 Core",
      page: 0,
      category: "ADVANTAGE",
      level: false,
      value: 0,
      explain: "+1 edge on tests linked to chosen attribute",
      modifier: [],
    },
  },
];

/**
 * Populate the module compendium with quality items if they don't exist yet.
 * Only runs for the GM.
 */
async function populateCompendium() {
  if (!game.user.isGM) return;

  const packKey = `${MODULE_ID}.${COMPENDIUM_NAME}`;
  const pack = game.packs.get(packKey);
  if (!pack) {
    console.warn(`${MODULE_ID} | Compendium pack '${packKey}' not found`);
    return;
  }

  // Module packs are locked by default — unlock to allow creation
  const wasLocked = pack.locked;
  if (wasLocked) {
    await pack.configure({ locked: false });
  }

  try {
    const existing = await pack.getDocuments();

    for (const itemData of COMPENDIUM_ITEMS) {
      const found = existing.find(
        (i) =>
          i.system?.genesisID === itemData.system.genesisID ||
          i.name === itemData.name,
      );
      if (found) continue;

      await Item.create(itemData, { pack: packKey });
      console.log(
        `${MODULE_ID} | Created compendium item: ${itemData.name}`,
      );
    }
  } finally {
    // Re-lock if it was locked before
    if (wasLocked) {
      await pack.configure({ locked: true });
    }
  }
}

// ── Module initialization ──────────────────────────────────────────────

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing SR6 Edge Qualities`);
});

Hooks.once("ready", async () => {
  console.log(`${MODULE_ID} | Ready`);

  // Populate compendium with quality items. A failure here (a locked or missing pack) must not stop the hooks below.
  try {
    await populateCompendium();
  } catch (error) {
    console.error(`${MODULE_ID} | Could not populate the compendium`, error);
  }

  // Eden's RollDialog is an Application v1 Dialog subclass; Foundry fires render<ClassName> for it. The generic
  // renderDialog / renderApplication hooks fire for every dialog and window, so they are not used.
  Hooks.on("renderRollDialog", (app, html, data) => {
    if (app._sr6eq_patched) {
      observeEdgeLabel(app); // a re-render replaced the label node
      return;
    }
    onRenderDialog(app, html, data);
  });
  Hooks.on("closeRollDialog", onCloseDialog);
});

// Hook into actor sheet rendering for Attribute Mastery configuration
Hooks.on("renderActorSheet", (app, html, data) => {
  onRenderActorSheet(app, html, data);
});

// ── Edge award on roll completion ──────────────────────────────────────
// Since the RollDialog patching may not work in all Foundry versions,
// we award quality edge retroactively when the roll chat message is created.
// We track message IDs we've already processed to avoid double-awarding.
const processedMessages = new Set();

Hooks.on("createChatMessage", async (message, options, userId) => {
  // Only process our own rolls (the person who rolled)
  if (userId !== game.user.id) return;

  const roll = message.rolls?.[0];
  if (!roll?.configured) return;

  // Avoid double-processing
  if (processedMessages.has(message.id)) return;
  processedMessages.add(message.id);

  const configured = roll.configured;
  const actorId = configured.actor?._id ?? configured.speaker?.actor;
  if (!actorId) return;
  const actor = game.actors.get(actorId);
  if (!actor) return;

  const attrib = normalizeAttrib(configured.attrib ?? roll.data?.attrib);
  if (!attrib) return;

  // Check if the actor has any edge-granting qualities at all
  const allQualities = [
    ...findAllQualities(actor, ANALYTICAL_MIND_IDS, ANALYTICAL_MIND_NAMES),
    ...findAllQualities(actor, ATTRIBUTE_MASTERY_IDS, ATTRIBUTE_MASTERY_NAMES),
  ];
  if (allQualities.length === 0) return;

  const bonus = calcQualityEdgeBonus(actor, attrib);
  const qualityNames = allQualities.map((q) => q.name).join(", ");
  const actorEdge = actor.system.edge.value;

  // No matching attribute for this roll — stay silent
  if (bonus.total <= 0) return;

  // Apply per-round cap
  const perRoundMax = getMaxEdgeGainRemaining(actor);
  const systemGain = configured.edgePlayer || 0;
  const roomInRound = Math.max(0, perRoundMax - systemGain);
  const roomTo7 = Math.max(0, 7 - actorEdge);
  const applied = Math.min(bonus.total, roomInRound, roomTo7);

  const activeNames = bonus.sources.map((s) => s.quality).join(", ");
  const speaker = ChatMessage.getSpeaker({ actor });

  if (applied <= 0) {
    // Explain why edge wasn't awarded
    let reason;
    if (roomTo7 <= 0) {
      reason = game.i18n.localize("sr6eq.cappedBy7");
    } else {
      reason = game.i18n.localize("sr6eq.cappedByRound");
    }
    ChatMessage.create({
      content: `<div class="chat-edge" style="display:block"><div style="color: var(--highlight-color)">${esc(activeNames)}</div><div>${esc(reason)}</div></div>`,
      speaker,
    });
    return;
  }

  // Award edge to actor
  const newEdge = Math.min(7, actorEdge + applied);
  await actor.update({ [edgePath(actor)]: newEdge });
  console.log(`${MODULE_ID} | Awarded ${applied} edge to ${actor.name} (${actorEdge} → ${newEdge})`);

  // Track in combat if active
  const combat = game.combat;
  if (combat) {
    const tracked = combat.getCombatantsByActor(actorId) ?? [];
    const combatant = tracked[0];
    if (combatant) {
      combatant.edgeGained = (combatant.edgeGained || 0) + applied;
    }
    console.log(`${MODULE_ID} | Combat tracking: combat ${combat.id}, ${tracked.length} combatant(s) for the actor, edgeGained now ${combatant?.edgeGained}`);
  } else {
    console.log(`${MODULE_ID} | Combat tracking: no viewed combat`);
  }

  // Notify in chat using the system's edge message styling
  const bonusText = game.i18n.format("sr6eq.edgeBonus", {
    value: applied,
    quality: activeNames,
  });
  ChatMessage.create({
    content: `<div class="chat-edge" style="display:block"><div style="color: var(--highlight-color)">${esc(bonusText)}</div><div>${esc(actor.name)}: ${esc(actorEdge)} → ${esc(newEdge)}</div></div>`,
    speaker,
  });
});

// ── Annotate roll chat cards with triggering quality name ─────────────
Hooks.on("renderChatMessageHTML", (message, html) => {
  const roll = message.rolls?.[0];
  if (!roll?.configured) return;

  const configured = roll.configured;
  const actorId = configured.actor?._id ?? configured.speaker?.actor;
  if (!actorId) return;
  const actor = game.actors.get(actorId);
  if (!actor) return;

  const attrib = normalizeAttrib(configured.attrib ?? roll.data?.attrib);
  if (!attrib) return;

  const bonus = calcQualityEdgeBonus(actor, attrib);
  if (bonus.total <= 0) return;

  const activeNames = bonus.sources.map((s) => s.quality).join(", ");

  // Append quality name centered at the bottom of the card (html is an HTMLElement since Foundry 13)
  const content = html.querySelector(".message-content");
  if (content && !content.querySelector(".sr6eq-quality-label")) {
    const label = document.createElement("div");
    label.className = "sr6eq-quality-label";
    label.style.cssText =
      "text-align:center;margin-top:6px;padding-top:4px;border-top:1px solid var(--color-border-light-tertiary, #555);color:var(--highlight-color);font-size:0.9em;";
    label.textContent = activeNames;
    content.append(label);
  }
});
